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
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            await r.set(key, payload, ex=settings.extraction_cache_ttl_seconds)
            logger.info(
                "extraction_cache_stored",
                job_id=job_id,
                content_length=content.content_length,
                ttl=settings.extraction_cache_ttl_seconds,
            )
        finally:
            await r.aclose()

    async def get(self, job_id: str) -> ExtractionContent | None:
        settings = get_settings()
        key = f"{_KEY_PREFIX}{job_id}"
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            raw = await r.get(key)
            if raw is None:
                return None
            data = json.loads(raw)
            return ExtractionContent(**data)
        except Exception as e:
            logger.warning("extraction_cache_get_failed", job_id=job_id, error=str(e))
            return None
        finally:
            await r.aclose()

    async def delete(self, job_id: str) -> None:
        settings = get_settings()
        key = f"{_KEY_PREFIX}{job_id}"
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            await r.delete(key)
            logger.debug("extraction_cache_deleted", job_id=job_id)
        except Exception as e:
            logger.warning("extraction_cache_delete_failed", job_id=job_id, error=str(e))
        finally:
            await r.aclose()

    async def exists(self, job_id: str) -> bool:
        settings = get_settings()
        key = f"{_KEY_PREFIX}{job_id}"
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            return bool(await r.exists(key))
        finally:
            await r.aclose()
