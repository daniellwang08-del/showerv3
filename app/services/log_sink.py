"""Async batch sink: structlog events → system_log_events table.

Processors are sync (structlog contract), so events land in a thread-safe
deque. An asyncio flusher started from API/worker lifespan drains the buffer
into PostgreSQL in batches so request handlers never wait on log I/O.
"""

from __future__ import annotations

import asyncio
import json
import os
import traceback
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.config import get_settings

# Populated context keys that map 1:1 onto SystemLogEvent columns.
_COLUMN_KEYS = frozenset(
    {
        "request_id",
        "user_id",
        "job_id",
        "extraction_id",
        "worker_job_type",
        "method",
        "path",
        "status_code",
        "duration_ms",
        "client_ip",
        "category",
        "service",
        "message",
    }
)

_SKIP_EVENTS = frozenset(
    {
        # Transport chatter and cache hits: high volume, no diagnostic value
        # (http_request_completed already carries method, path and duration).
        "ws_redis_event_received",
        "ws_event_published",
        "http_request_started",
        "job_metadata_hydrated",
        "extraction_cache_stored",
        "job_text_from_cache",
        "extraction_service_started",
    }
)

_SKIP_PATH_PREFIXES = (
    "/api/v1/health",
    "/favicon.ico",
    "/docs",
    "/openapi.json",
    "/redoc",
)

_LEVEL_RANK = {"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}

_buffer: deque[dict[str, Any]] = deque(maxlen=20_000)
_flush_task: asyncio.Task | None = None
_service_name: str = "api"
_enabled: bool = True
_min_level_rank: int = 20


def configure_log_sink(*, service: str = "api") -> None:
    """Call once at process start (before/alongside setup_logging)."""
    global _service_name, _enabled, _min_level_rank
    _service_name = (service or "api").strip() or "api"
    settings = get_settings()
    _enabled = bool(getattr(settings, "log_persist_enabled", True))
    level = str(getattr(settings, "log_persist_min_level", "INFO") or "INFO").lower()
    _min_level_rank = _LEVEL_RANK.get(level, 20)


def _infer_category(event: str, event_dict: dict) -> str:
    if event_dict.get("category"):
        return str(event_dict["category"])
    if event.startswith("http_") or event_dict.get("method") or event_dict.get("status_code") is not None:
        return "http"
    if event_dict.get("worker_job_type") or event.endswith("_task") or "worker" in event:
        return "worker"
    if event.startswith("application_") or event.endswith("_startup") or event.endswith("_shutdown"):
        return "system"
    return "process"


def _safe_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_safe_jsonable(v) for v in value[:50]]
    if isinstance(value, dict):
        out = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 40:
                out["…"] = f"+{len(value) - 40} keys"
                break
            out[str(k)[:80]] = _safe_jsonable(v)
        return out
    try:
        return str(value)[:2000]
    except Exception:
        return "<unserializable>"


def _normalize_row(event_dict: dict) -> dict[str, Any] | None:
    if not _enabled:
        return None

    level = str(event_dict.get("level") or "info").lower()
    if _LEVEL_RANK.get(level, 20) < _min_level_rank:
        return None

    event = str(event_dict.get("event") or "log").strip().lower()[:200]
    if event in _SKIP_EVENTS:
        return None

    path = event_dict.get("path")
    if isinstance(path, str) and any(path.startswith(p) for p in _SKIP_PATH_PREFIXES):
        return None

    payload: dict[str, Any] = {}
    for key, value in event_dict.items():
        if key in (
            "event",
            "level",
            "logger",
            "timestamp",
            "_record",
            "_from_structlog",
            "exc_info",
            "exception",
        ):
            continue
        if key in _COLUMN_KEYS:
            continue
        payload[key] = _safe_jsonable(value)

    # Cap payload size roughly.
    try:
        raw = json.dumps(payload, default=str)
        if len(raw) > 12_000:
            payload = {"_truncated": True, "_preview": raw[:4000]}
    except Exception:
        payload = {"_error": "payload_serialize_failed"}

    message = event_dict.get("message")
    if message is None and event_dict.get("error"):
        message = str(event_dict.get("error"))[:2000]
    elif message is not None:
        message = str(message)[:2000]

    status_code = event_dict.get("status_code")
    try:
        status_code = int(status_code) if status_code is not None else None
    except (TypeError, ValueError):
        status_code = None

    duration_ms = event_dict.get("duration_ms")
    try:
        duration_ms = float(duration_ms) if duration_ms is not None else None
    except (TypeError, ValueError):
        duration_ms = None

    created_at = None
    ts = event_dict.get("timestamp")
    if isinstance(ts, str):
        try:
            created_at = datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            created_at = None
    if created_at is None:
        created_at = datetime.now(timezone.utc).replace(tzinfo=None)

    return {
        "id": str(uuid.uuid4()),
        "created_at": created_at,
        "level": level[:20],
        "event": event,
        "logger_name": str(event_dict.get("logger") or "")[:200] or None,
        "category": _infer_category(event, event_dict)[:40],
        "service": str(event_dict.get("service") or _service_name)[:40],
        "request_id": (str(event_dict["request_id"])[:64] if event_dict.get("request_id") else None),
        "user_id": (str(event_dict["user_id"])[:36] if event_dict.get("user_id") else None),
        "job_id": (str(event_dict["job_id"])[:36] if event_dict.get("job_id") else None),
        "extraction_id": (
            str(event_dict["extraction_id"])[:36] if event_dict.get("extraction_id") else None
        ),
        "worker_job_type": (
            str(event_dict["worker_job_type"])[:80] if event_dict.get("worker_job_type") else None
        ),
        "method": (str(event_dict["method"])[:16] if event_dict.get("method") else None),
        "path": (str(event_dict["path"])[:500] if event_dict.get("path") else None),
        "status_code": status_code,
        "duration_ms": duration_ms,
        "client_ip": (str(event_dict["client_ip"])[:64] if event_dict.get("client_ip") else None),
        "message": message,
        "payload": payload or None,
    }


def persist_log_processor(_, __, event_dict: dict) -> dict:
    """structlog processor, never raises; never blocks."""
    try:
        row = _normalize_row(event_dict)
        if row is not None:
            _buffer.append(row)
    except Exception:
        # Logging must never break the app.
        pass
    return event_dict


async def _flush_once() -> int:
    if not _buffer:
        return 0
    batch: list[dict[str, Any]] = []
    while _buffer and len(batch) < 200:
        try:
            batch.append(_buffer.popleft())
        except IndexError:
            break
    if not batch:
        return 0

    try:
        from app.models.database import SystemLogEvent
        from app.storage.database import get_session

        async with get_session() as session:
            session.add_all([SystemLogEvent(**row) for row in batch])
            await session.commit()
        return len(batch)
    except Exception:
        # Put events back if possible (best-effort); drop on overflow.
        for row in reversed(batch):
            try:
                _buffer.appendleft(row)
            except Exception:
                break
        return 0


async def _flush_usage() -> None:
    from app.services.llm_usage import flush_llm_usage

    await flush_llm_usage()


async def _flush_loop() -> None:
    while True:
        try:
            await _flush_once()
        except Exception:
            pass
        try:
            await _flush_usage()
        except Exception:
            pass
        await asyncio.sleep(1.0)


async def start_log_sink(*, service: str | None = None) -> None:
    global _flush_task
    if service:
        configure_log_sink(service=service)
    else:
        configure_log_sink(service=_service_name or os.environ.get("SHOWERV3_SERVICE", "api"))
    # The loop also writes LLM usage rows, so it runs even with log persistence off.
    if _flush_task and not _flush_task.done():
        return
    _flush_task = asyncio.create_task(_flush_loop(), name="system-log-flush")


async def stop_log_sink() -> None:
    global _flush_task
    if _flush_task and not _flush_task.done():
        _flush_task.cancel()
        try:
            await _flush_task
        except asyncio.CancelledError:
            pass
    _flush_task = None
    try:
        await _flush_once()
    except Exception:
        pass
    try:
        await _flush_usage()
    except Exception:
        pass


async def purge_old_logs(*, days: int | None = None) -> int:
    """Delete log rows older than retention. Returns deleted count."""
    settings = get_settings()
    retain = days if days is not None else int(getattr(settings, "log_retention_days", 14) or 14)
    retain = max(1, min(retain, 365))
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=retain)

    from sqlalchemy import delete
    from app.models.database import SystemLogEvent
    from app.storage.database import get_session

    async with get_session() as session:
        result = await session.execute(
            delete(SystemLogEvent).where(SystemLogEvent.created_at < cutoff)
        )
        await session.commit()
        return int(result.rowcount or 0)
