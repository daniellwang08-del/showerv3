"""DB-backed blocked domains for job extraction (admin-managed)."""

from __future__ import annotations

import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import BlockedDomain

logger = get_logger(__name__)

# Seed fallback used only if the table is empty / unavailable during early boot.
_FALLBACK: dict[str, str] = {
    "paycomonline.net": (
        "Paycom ATS requires lengthy manual registration; auto-extraction not supported."
    ),
}

_cache: dict[str, str] | None = None
_cache_ts = 0.0
_CACHE_TTL = 30.0


def invalidate_blocked_domains_cache() -> None:
    global _cache, _cache_ts
    _cache = None
    _cache_ts = 0.0


def get_blocked_reason(domain: str) -> str | None:
    """Sync lookup against the in-process cache (populated async on admin writes / first miss).

    Callers in the extraction hot path are sync; we refresh the cache lazily via
    a best-effort sync snapshot. If the cache is cold, fall back to the seed list
    and schedule is not available here — admin CRUD and app startup warm the cache.
    """
    lowered = (domain or "").lower().strip()
    if not lowered:
        return None
    mapping = _cache if _cache is not None else _FALLBACK
    for blocked, reason in mapping.items():
        if lowered == blocked or lowered.endswith(f".{blocked}"):
            return reason
    return None


async def refresh_blocked_domains_cache(session: AsyncSession | None = None) -> dict[str, str]:
    global _cache, _cache_ts
    if session is None:
        from app.storage.database import get_session

        async with get_session() as sess:
            return await refresh_blocked_domains_cache(sess)

    result = await session.execute(select(BlockedDomain))
    rows = result.scalars().all()
    mapping = {row.domain.lower(): row.reason for row in rows}
    if not mapping:
        mapping = dict(_FALLBACK)
    _cache = mapping
    _cache_ts = time.monotonic()
    return dict(mapping)


async def get_blocked_domains_map(session: AsyncSession) -> dict[str, str]:
    global _cache, _cache_ts
    now = time.monotonic()
    if _cache is not None and (now - _cache_ts) < _CACHE_TTL:
        return dict(_cache)
    return await refresh_blocked_domains_cache(session)


async def list_blocked_domains(session: AsyncSession) -> list[dict]:
    result = await session.execute(select(BlockedDomain).order_by(BlockedDomain.domain.asc()))
    rows = result.scalars().all()
    if not rows:
        # Ensure seed is visible even if migration seed was skipped.
        return [
            {"domain": d, "reason": r, "created_at": None}
            for d, r in sorted(_FALLBACK.items())
        ]
    return [
        {"domain": row.domain, "reason": row.reason, "created_at": row.created_at}
        for row in rows
    ]


async def add_blocked_domain(
    session: AsyncSession, domain: str, reason: str
) -> dict:
    cleaned = domain.lower().strip().lstrip(".")
    if not cleaned or " " in cleaned:
        raise ValueError("Invalid domain")
    reason_clean = (reason or "").strip() or "Blocked by admin"
    result = await session.execute(
        select(BlockedDomain).where(BlockedDomain.domain == cleaned)
    )
    row = result.scalar_one_or_none()
    if row:
        row.reason = reason_clean
    else:
        row = BlockedDomain(
            domain=cleaned,
            reason=reason_clean,
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        session.add(row)
    await session.flush()
    await refresh_blocked_domains_cache(session)
    logger.info("blocked_domain_added", domain=cleaned)
    return {"domain": row.domain, "reason": row.reason, "created_at": row.created_at}


async def remove_blocked_domain(session: AsyncSession, domain: str) -> bool:
    cleaned = domain.lower().strip()
    result = await session.execute(
        select(BlockedDomain).where(BlockedDomain.domain == cleaned)
    )
    row = result.scalar_one_or_none()
    if not row:
        return False
    await session.delete(row)
    await session.flush()
    await refresh_blocked_domains_cache(session)
    logger.info("blocked_domain_removed", domain=cleaned)
    return True
