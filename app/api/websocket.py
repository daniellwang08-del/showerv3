"""
WebSocket endpoint for real-time progress reporting.

Architecture:
  - Worker publishes events to Redis pub/sub channel "ws:events"
  - API server subscribes and forwards events to connected WebSocket clients
  - Each client authenticates via JWT and receives only their own user's events
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.auth_service import AuthService

logger = get_logger(__name__)

WS_CHANNEL = "ws:events"

ws_router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self._connections: dict[str, set[WebSocket]] = {}  # user_id -> set of websockets
        self._subscriber_task: asyncio.Task | None = None

    async def connect(self, ws: WebSocket, user_id: str) -> None:
        await ws.accept()
        if user_id not in self._connections:
            self._connections[user_id] = set()
        self._connections[user_id].add(ws)
        logger.info("ws_client_connected", user_id=user_id, total=self._total_connections())

    def disconnect(self, ws: WebSocket, user_id: str) -> None:
        conns = self._connections.get(user_id)
        if conns:
            conns.discard(ws)
            if not conns:
                del self._connections[user_id]
        logger.info("ws_client_disconnected", user_id=user_id, total=self._total_connections())

    async def send_to_user(self, user_id: str, data: dict[str, Any]) -> None:
        conns = self._connections.get(user_id)
        if not conns:
            return
        message = json.dumps(data)
        dead: list[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            conns.discard(ws)
        if not conns:
            self._connections.pop(user_id, None)

    async def broadcast(self, data: dict[str, Any]) -> None:
        message = json.dumps(data)
        for user_id, conns in list(self._connections.items()):
            dead: list[WebSocket] = []
            for ws in conns:
                try:
                    await ws.send_text(message)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                conns.discard(ws)

    def _total_connections(self) -> int:
        return sum(len(c) for c in self._connections.values())

    async def start_redis_subscriber(self) -> None:
        if self._subscriber_task is not None:
            return
        self._subscriber_task = asyncio.create_task(self._redis_subscriber_loop())

    async def stop_redis_subscriber(self) -> None:
        if self._subscriber_task:
            self._subscriber_task.cancel()
            try:
                await self._subscriber_task
            except asyncio.CancelledError:
                pass
            self._subscriber_task = None

    async def _redis_subscriber_loop(self) -> None:
        """Subscribe to Redis pub/sub and forward events to WebSocket clients."""
        import redis.asyncio as aioredis

        settings = get_settings()
        while True:
            try:
                r = aioredis.from_url(settings.redis_url, decode_responses=True)
                pubsub = r.pubsub()
                await pubsub.subscribe(WS_CHANNEL)
                logger.info("ws_redis_subscriber_started")
                async for message in pubsub.listen():
                    if message["type"] != "message":
                        continue
                    try:
                        data = json.loads(message["data"])
                        user_id = data.get("user_id")
                        logger.info(
                            "ws_redis_event_received",
                            event_type=data.get("type"),
                            target_user=user_id,
                            connected_users=list(self._connections.keys()),
                        )
                        if user_id:
                            await self.send_to_user(user_id, data)
                        else:
                            await self.broadcast(data)
                    except (json.JSONDecodeError, Exception) as e:
                        logger.warning("ws_redis_message_parse_error", error=str(e))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("ws_redis_subscriber_error", error=str(e))
                await asyncio.sleep(2)


manager = ConnectionManager()


async def publish_ws_event(event: dict[str, Any]) -> None:
    """Publish an event to Redis pub/sub for WebSocket delivery.

    Safe to call from the worker process (only needs redis, no FastAPI runtime).
    """
    import redis.asyncio as aioredis

    settings = get_settings()
    try:
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        receivers = await r.publish(WS_CHANNEL, json.dumps(event))
        logger.info("ws_event_published", event_type=event.get("type"), receivers=receivers)
        await r.aclose()
    except Exception as e:
        logger.warning("ws_publish_failed", error=str(e), event_type=event.get("type"))


@ws_router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    token = ws.query_params.get("token")
    if not token:
        cookies = ws.cookies
        token = cookies.get("access_token")

    if not token:
        await ws.close(code=4001, reason="Missing authentication token")
        return

    payload = AuthService.verify_token(token)
    if not payload:
        await ws.close(code=4001, reason="Invalid token")
        return

    user_id = payload.get("user_id")
    if not user_id:
        await ws.close(code=4001, reason="Invalid token")
        return

    await manager.connect(ws, user_id)
    try:
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        manager.disconnect(ws, user_id)
