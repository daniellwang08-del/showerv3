"""Heal orphaned pipeline rows left by worker cancel/timeout/restart."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from app.core.logging import get_logger
from app.storage.database import get_session

logger = get_logger(__name__)

# Phase B (tailoring) job_timeout is 480s; allow a buffer before declaring orphans.
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
    completed_extractions = 0
    demoted_scrape_only = 0
    excluded_zero_scores = 0
    restored_location_unknown = 0

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

        # Heal rows stuck at EXTRACTED after a score already exists (UI "Analyzing"
        # while Match shows e.g. "0 Weak"). Phase A finished; status was never advanced.
        completed_result = await session.execute(
            text(
                """
                UPDATE job_extractions AS je
                SET status = 'COMPLETED',
                    completed_at = coalesce(je.completed_at, timezone('UTC', now())),
                    updated_at = timezone('UTC', now())
                WHERE je.status = 'EXTRACTED'
                  AND EXISTS (
                      SELECT 1
                      FROM jobs j
                      JOIN job_match_results jmr ON jmr.job_id = j.id
                      WHERE j.extraction_id = je.id
                  )
                RETURNING je.id
                """
            )
        )
        completed_extractions = len(completed_result.fetchall())

        # Demote scrape-only rows wrongly marked COMPLETED (legacy platform promote).
        # COMPLETED means Phase A structured the posting; shared raw JD stays EXTRACTED.
        demote_result = await session.execute(
            text(
                """
                UPDATE job_extractions AS je
                SET status = 'EXTRACTED',
                    completed_at = NULL,
                    updated_at = timezone('UTC', now())
                WHERE je.status = 'COMPLETED'
                  AND je.raw_plain_text IS NOT NULL
                  AND length(btrim(je.raw_plain_text)) > 0
                  AND (
                      je.description IS NULL
                      OR length(btrim(je.description)) = 0
                  )
                  AND (
                      -- Column is JSON (not JSONB); "?" exists only for jsonb.
                      je.raw_metadata IS NULL
                      OR NOT ((je.raw_metadata::jsonb) ? 'ai_structured_source')
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM jobs j
                      JOIN job_match_results jmr ON jmr.job_id = j.id
                      WHERE j.extraction_id = je.id
                  )
                RETURNING je.id
                """
            )
        )
        demoted_scrape_only = len(demote_result.fetchall())

        # Remove already-scored 0 Weak jobs that remained active on the Jobs list.
        zero_score_result = await session.execute(
            text(
                """
                UPDATE user_job_status AS ujs
                SET status = 'duplicated',
                    exclusion_type = 'below_min_score',
                    reason = 'Match score is 0 (Weak), removed after analysis.',
                    match_score_at_decision = coalesce(ujs.match_score_at_decision, 0),
                    updated_at = timezone('UTC', now())
                WHERE ujs.status = 'active'
                  AND EXISTS (
                      SELECT 1
                      FROM job_match_results jmr
                      WHERE jmr.job_id = ujs.job_id
                        AND jmr.user_id = ujs.user_id
                        AND jmr.overall_score <= 0
                  )
                RETURNING ujs.id
                """
            )
        )
        excluded_zero_scores = len(zero_score_result.fetchall())

        # Unknown locations are treated as US, clear legacy location_unknown hides.
        location_unknown_result = await session.execute(
            text(
                """
                UPDATE user_job_status AS ujs
                SET status = 'active',
                    exclusion_type = NULL,
                    duplicated_because_id = NULL,
                    reason = NULL,
                    updated_at = timezone('UTC', now())
                WHERE ujs.status = 'duplicated'
                  AND ujs.exclusion_type = 'location_unknown'
                RETURNING ujs.id
                """
            )
        )
        restored_location_unknown = len(location_unknown_result.fetchall())
        await session.commit()

    if (
        failed_content
        or cleared_progress
        or completed_extractions
        or demoted_scrape_only
        or excluded_zero_scores
        or restored_location_unknown
    ):
        logger.info(
            "pipeline_stale_state_healed",
            failed_content=failed_content,
            cleared_progress=cleared_progress,
            completed_extractions=completed_extractions,
            demoted_scrape_only=demoted_scrape_only,
            excluded_zero_scores=excluded_zero_scores,
            restored_location_unknown=restored_location_unknown,
            processing_max_age_seconds=processing_age,
            progress_max_age_seconds=progress_age,
        )
    return {
        "failed_content": failed_content,
        "cleared_progress": cleared_progress,
        "completed_extractions": completed_extractions,
        "demoted_scrape_only": demoted_scrape_only,
        "excluded_zero_scores": excluded_zero_scores,
        "restored_location_unknown": restored_location_unknown,
        "processing_max_age_seconds": processing_age,
        "progress_max_age_seconds": progress_age,
    }
