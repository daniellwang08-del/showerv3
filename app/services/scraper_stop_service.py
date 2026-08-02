"""Stop platform job fetching (manual sync + scheduled sync).

Uses a Redis flag polled by the scraper runner so in-flight Scrapy
subprocesses are killed promptly, remaining platforms in a multi-spider
run are skipped, and scheduled sync can be disabled from Preferences.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text

from app.core.logging import get_logger
from app.core.redis_support import init_broker_redis_pool
from app.storage.database import get_session

logger = get_logger(__name__)

STOP_KEY = "scraper:fetch_stop"
STOP_TTL_SECONDS = 6 * 60 * 60  # keep long enough to cover a stuck worker tick


async def request_stop(*, reason: str = "user_requested") -> None:
    redis = await init_broker_redis_pool()
    payload = f"{reason}|{datetime.now(timezone.utc).isoformat()}"
    await redis.set(STOP_KEY, payload, ex=STOP_TTL_SECONDS)
    logger.info("scraper_fetch_stop_requested", reason=reason)


async def is_stop_requested() -> bool:
    try:
        redis = await init_broker_redis_pool()
        return bool(await redis.get(STOP_KEY))
    except Exception:
        return False


async def clear_stop() -> None:
    try:
        redis = await init_broker_redis_pool()
        await redis.delete(STOP_KEY)
        logger.info("scraper_fetch_stop_cleared")
    except Exception as e:
        logger.warning("scraper_fetch_stop_clear_failed", error=str(e))


async def interrupt_running_scrape_runs() -> list[str]:
    """Mark every in-progress scrape_runs row as interrupted."""
    async with get_session() as session:
        result = await session.execute(
            text(
                """
                UPDATE scrape_runs
                SET status = 'interrupted', finished_at = now()
                WHERE status = 'running'
                RETURNING id
                """
            )
        )
        ids = [str(row[0]) for row in result.fetchall()]
    if ids:
        logger.info("scraper_fetch_runs_interrupted", count=len(ids), ids=ids)
    return ids


async def stop_job_fetching(
    *,
    disable_schedule: bool = True,
    updated_by_user_id: str | None = None,
) -> dict:
    """Request stop, interrupt DB rows, optionally disable scheduled sync."""
    await request_stop(reason="preferences_stop")
    interrupted_ids = await interrupt_running_scrape_runs()

    schedule_disabled = False
    schedule_view: dict | None = None
    if disable_schedule:
        from app.services.job_sync_schedule_service import (
            get_schedule,
            save_schedule,
            schedule_public_view,
        )

        async with get_session() as session:
            current = await get_schedule(session)
            if current.get("enabled"):
                saved = await save_schedule(
                    session,
                    {**current, "enabled": False},
                    updated_by_user_id=updated_by_user_id,
                )
                schedule_disabled = True
                schedule_view = schedule_public_view(saved)
            else:
                schedule_view = schedule_public_view(current)

    return {
        "status": "stopping",
        "message": (
            "Stop signal sent. Running scrapes will be interrupted; "
            "remaining platforms in this run will be skipped."
            + (" Scheduled sync was disabled." if schedule_disabled else "")
        ),
        "interrupted_run_ids": interrupted_ids,
        "interrupted_count": len(interrupted_ids),
        "schedule_disabled": schedule_disabled,
        "schedule": schedule_view,
        "stop_requested": True,
    }
