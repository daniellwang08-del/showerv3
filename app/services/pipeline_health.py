"""Heal orphaned pipeline rows left by worker cancel/timeout/restart."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from app.core.logging import get_logger
from app.storage.database import get_session

logger = get_logger(__name__)

# Phase B job_timeout is 360s; allow a buffer before declaring orphans.
DEFAULT_PROCESSING_MAX_AGE_SECONDS = 900
# Match progress should clear when Phase A finishes; anything older is stale.
DEFAULT_PROGRESS_MAX_AGE_SECONDS = 1800


async def heal_stale_pipeline_state(
    *,
    processing_max_age_seconds: int = DEFAULT_PROCESSING_MAX_AGE_SECONDS,
    progress_max_age_seconds: int = DEFAULT_PROGRESS_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    """Mark stuck content generation failed and drop stale match-progress rows."""
    processing_age = max(60, int(processing_max_age_seconds))
    progress_age = max(60, int(progress_max_age_seconds))
    failed_content = 0
    cleared_progress = 0

    async with get_session() as session:
        content_result = await session.execute(
            text(
                """
                UPDATE resume_build_results
                SET content_generation_status = 'failed',
                    content_generation_error = :err,
                    updated_at = timezone('UTC', now())
                WHERE content_generation_status = 'processing'
                  AND coalesce(updated_at, created_at)
                      < timezone('UTC', now()) - make_interval(secs => :age)
                RETURNING job_id
                """
            ),
            {
                "err": "Stale processing healed (worker cancel/timeout/restart)",
                "age": processing_age,
            },
        )
        failed_content = len(content_result.fetchall())

        progress_result = await session.execute(
            text(
                """
                DELETE FROM job_match_in_progress
                WHERE created_at
                      < timezone('UTC', now()) - make_interval(secs => :age)
                RETURNING job_id
                """
            ),
            {"age": progress_age},
        )
        cleared_progress = len(progress_result.fetchall())
        await session.commit()

    if failed_content or cleared_progress:
        logger.info(
            "pipeline_stale_state_healed",
            failed_content=failed_content,
            cleared_progress=cleared_progress,
            processing_max_age_seconds=processing_age,
            progress_max_age_seconds=progress_age,
        )
    return {
        "failed_content": failed_content,
        "cleared_progress": cleared_progress,
        "processing_max_age_seconds": processing_age,
        "progress_max_age_seconds": progress_age,
    }
