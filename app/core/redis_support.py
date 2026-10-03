"""Redis URL helpers, health pings, and shared pub/sub client pools.

Logical roles (optional split when the Redis server allows multiple DBs):

  * broker, arq queues / job payloads  (``REDIS_URL``, typically ``/0``)
  * cache, extraction content cache   (``REDIS_CACHE_URL``, typically ``/1``)
  * pubsub, WebSocket event fan-out    (``REDIS_PUBSUB_URL``, typically ``/2``)

Managed Redis (Render Key Value, some Redis Cloud plans) often only exposes DB 0.
Leave cache/pubsub URLs unset so they fall back to ``REDIS_URL``.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse, urlunparse

import redis.asyncio as aioredis
from arq.connections import RedisSettings

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_pubsub_pool: aioredis.Redis | None = None
_broker_pool: aioredis.Redis | None = None


def with_redis_db(url: str, db: int) -> str:
    """Return *url* rewritten to use logical Redis database *db*."""
    parsed = urlparse(url)
    # path is typically "/0"; query-only DSNs are rare for redis://
    return urlunparse(parsed._replace(path=f"/{int(db)}"))


def broker_redis_url() -> str:
    return get_settings().redis_url


def cache_redis_url() -> str:
    settings = get_settings()
    return settings.redis_cache_url or settings.redis_url


def pubsub_redis_url() -> str:
    settings = get_settings()
    return settings.redis_pubsub_url or settings.redis_url


def arq_redis_settings() -> RedisSettings:
    """arq broker settings derived from ``REDIS_URL``."""
    return RedisSettings.from_dsn(broker_redis_url())


def require_redis_for_jobs() -> bool:
    """When True, API must not fall back to in-process BackgroundTasks."""
    settings = get_settings()
    if settings.redis_require_for_jobs is not None:
        return settings.redis_require_for_jobs
    return settings.app_env.strip().lower() in ("production", "prod")


def allow_in_process_job_fallback() -> bool:
    return not require_redis_for_jobs()


def pipeline_job_id(*parts: str) -> str:
    """Stable arq ``_job_id`` for in-flight dedup (safe with ``keep_result=0``)."""
    cleaned = [str(p).strip() for p in parts if p is not None and str(p).strip()]
    return ":".join(cleaned)


async def ping_url(url: str, *, max_connections: int = 1) -> bool:
    client = aioredis.from_url(url, decode_responses=True, max_connections=max_connections)
    try:
        return bool(await client.ping())
    except Exception:
        return False
    finally:
        await client.aclose()


async def redis_health() -> dict[str, Any]:
    """Ping broker / cache / pubsub roles (may be the same endpoint)."""
    broker = broker_redis_url()
    cache = cache_redis_url()
    pubsub = pubsub_redis_url()
    broker_ok = await ping_url(broker)
    cache_ok = broker_ok if cache == broker else await ping_url(cache)
    pubsub_ok = broker_ok if pubsub == broker else await ping_url(pubsub)
    return {
        "broker": broker_ok,
        "cache": cache_ok,
        "pubsub": pubsub_ok,
        "ok": broker_ok and cache_ok and pubsub_ok,
        "split": len({broker, cache, pubsub}) > 1,
    }


async def init_broker_redis_pool() -> aioredis.Redis:
    """Shared redis.asyncio client on the broker DB (admin queue depth, health)."""
    global _broker_pool
    if _broker_pool is not None:
        return _broker_pool
    settings = get_settings()
    _broker_pool = aioredis.from_url(
        broker_redis_url(),
        decode_responses=True,
        max_connections=settings.redis_broker_pool_size,
    )
    logger.info("broker_redis_pool_initialized")
    return _broker_pool


async def close_broker_redis_pool() -> None:
    global _broker_pool
    if _broker_pool is not None:
        await _broker_pool.aclose()
        _broker_pool = None
        logger.info("broker_redis_pool_closed")


def get_broker_redis() -> aioredis.Redis:
    if _broker_pool is not None:
        return _broker_pool
    settings = get_settings()
    return aioredis.from_url(
        broker_redis_url(),
        decode_responses=True,
        max_connections=settings.redis_broker_pool_size,
    )


async def init_pubsub_redis_pool() -> aioredis.Redis:
    global _pubsub_pool
    if _pubsub_pool is not None:
        return _pubsub_pool
    settings = get_settings()
    _pubsub_pool = aioredis.from_url(
        pubsub_redis_url(),
        decode_responses=True,
        max_connections=settings.redis_pubsub_pool_size,
    )
    logger.info("pubsub_redis_pool_initialized")
    return _pubsub_pool


async def close_pubsub_redis_pool() -> None:
    global _pubsub_pool
    if _pubsub_pool is not None:
        await _pubsub_pool.aclose()
        _pubsub_pool = None
        logger.info("pubsub_redis_pool_closed")


def get_pubsub_redis() -> aioredis.Redis:
    if _pubsub_pool is not None:
        return _pubsub_pool
    settings = get_settings()
    return aioredis.from_url(
        pubsub_redis_url(),
        decode_responses=True,
        max_connections=settings.redis_pubsub_pool_size,
    )


def dumps_ws_payload(event: dict[str, Any]) -> str:
    """Serialize WS/pubsub payloads; prefer orjson when installed."""
    try:
        import orjson

        return orjson.dumps(event).decode("utf-8")
    except Exception:
        import json

        return json.dumps(event)
