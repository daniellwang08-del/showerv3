"""
Redis-backed temporary storage for extracted plain text.

Extraction produces clean page text and stores it here. The analysis worker
reads from this cache, sends it to the LLM for structuring, then persists
the structured result to the database.  The cache entry is deleted after
analysis completes (or expires via TTL as a safety net).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

import redis.asyncio as aioredis

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_KEY_PREFIX = "extraction:content:"

_pool: aioredis.Redis | None = None


async def init_redis_pool() -> None:
    """Create shared Redis connection pool (call once at app/worker startup)."""
    global _pool
    if _pool is not None:
        return
    settings = get_settings()
    _pool = aioredis.from_url(
        settings.redis_url,
        decode_responses=True,
        max_connections=settings.redis_pool_size,
    )
    logger.info("extraction_cache_redis_pool_initialized")


async def close_redis_pool() -> None:
    """Shut down the shared pool (call at app/worker shutdown)."""
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None
        logger.info("extraction_cache_redis_pool_closed")


def _get_redis() -> aioredis.Redis:
    """Return the shared pool, falling back to a one-shot client if the pool
    hasn't been initialized (e.g. test environment)."""
    if _pool is not None:
        return _pool
    settings = get_settings()
    return aioredis.from_url(settings.redis_url, decode_responses=True)


@dataclass(frozen=True, slots=True)
class ExtractionContent:
    """Immutable snapshot of extracted page content waiting for analysis."""

    plain_text: str
    source_url: str
    extraction_method: str
    fetched_at: str
    content_length: int

    @classmethod
    def create(cls, plain_text: str, source_url: str, extraction_method: str) -> ExtractionContent:
        return cls(
            plain_text=plain_text,
            source_url=source_url,
            extraction_method=extraction_method,
            fetched_at=datetime.now(timezone.utc).isoformat(),
            content_length=len(plain_text),
        )


class ExtractionCache:
    """Redis-backed cache for extracted plain text between extraction and analysis."""

    async def store(self, job_id: str, content: ExtractionContent) -> None:
        settings = get_settings()
        key = f"{_KEY_PREFIX}{job_id}"
        payload = json.dumps(asdict(content))
        r = _get_redis()
        await r.set(key, payload, ex=settings.extraction_cache_ttl_seconds)
        logger.info(
            "extraction_cache_stored",
            job_id=job_id,
            content_length=content.content_length,
            ttl=settings.extraction_cache_ttl_seconds,
        )

    async def get(self, job_id: str) -> ExtractionContent | None:
        key = f"{_KEY_PREFIX}{job_id}"
        r = _get_redis()
        try:
            raw = await r.get(key)
            if raw is None:
                return None
            data = json.loads(raw)
            return ExtractionContent(**data)
        except Exception as e:
            logger.warning("extraction_cache_get_failed", job_id=job_id, error=str(e))
            return None

    async def delete(self, job_id: str) -> None:
        key = f"{_KEY_PREFIX}{job_id}"
        r = _get_redis()
        try:
            await r.delete(key)
            logger.debug("extraction_cache_deleted", job_id=job_id)
        except Exception as e:
            logger.warning("extraction_cache_delete_failed", job_id=job_id, error=str(e))

    async def exists(self, job_id: str) -> bool:
        key = f"{_KEY_PREFIX}{job_id}"
        r = _get_redis()
        return bool(await r.exists(key))


async def invalidate_extraction_cache(job_id: str) -> None:
    """Remove cached plain text after extraction reset or rerun."""
    await ExtractionCache().delete(job_id)
