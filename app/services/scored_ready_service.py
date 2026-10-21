"""Move Scored jobs to Ready to apply by building their application documents.

Tailored mode writes a tailored résumé and cover letter per job. Original
résumé mode writes only the cover letter; the uploaded résumé goes out as is.
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import and_, not_, or_, select

from app.models.database import (
    Job,
    JobExtraction,
    JobMatchResult,
    ResumeBuildResult,
    UserJobStatus,
    ValidJobUserApplication,
)
from app.models.schemas import ExtractionStatus
from app.services import credit_service
from app.services.job_pipeline_mode import documents_ready_clause, has_tailored_resume
from app.storage.database import get_session

logger = structlog.get_logger(__name__)

MAX_PER_RUN = 100
IN_FLIGHT_CONTENT = ("pending", "processing")


def _scored_targets_stmt(user_id: str, countries: list[str], job_ids: list[str] | None, limit: int):
    from app.services.dashboard_stats import _visible_job_clause

    clauses = [
        _visible_job_clause(user_id, countries),
        JobMatchResult.overall_score.is_not(None),
        JobExtraction.status.in_((ExtractionStatus.EXTRACTED, ExtractionStatus.COMPLETED)),
        or_(
            ResumeBuildResult.id.is_(None),
            ResumeBuildResult.resume_docx_status.is_(None),
            not_(documents_ready_clause(ResumeBuildResult)),
        ),
        ValidJobUserApplication.id.is_(None),
    ]
    if job_ids:
        clauses.append(Job.id.in_(job_ids))
    return (
        select(Job.id, Job.extraction_id, ResumeBuildResult.content_generation_status)
        .select_from(Job)
        .outerjoin(UserJobStatus, and_(UserJobStatus.job_id == Job.id, UserJobStatus.user_id == user_id))
        .join(JobMatchResult, and_(JobMatchResult.job_id == Job.id, JobMatchResult.user_id == user_id))
        .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
        .outerjoin(ResumeBuildResult, and_(ResumeBuildResult.job_id == Job.id, ResumeBuildResult.user_id == user_id))
        .outerjoin(
            ValidJobUserApplication,
            and_(ValidJobUserApplication.job_id == Job.id, ValidJobUserApplication.user_id == user_id),
        )
        .where(*clauses)
        .order_by(JobMatchResult.overall_score.desc(), Job.id)
        .limit(limit + 1)
    )


def _content_matches_mode(row: ResumeBuildResult | None, original: bool) -> bool:
    if row is None:
        return False
    tailored = has_tailored_resume(row.tailored_resume_data)
    cover = isinstance(row.cover_letter_data, dict) and bool(row.cover_letter_data.get("body"))
    return (not original and tailored) or (original and cover and not tailored)


async def queue_scored_jobs_ready(
    user_id: str,
    *,
    job_ids: list[str] | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Queue document builds for the user's best Scored jobs (highest score first)."""
    from app.services.job_match_orchestrator import enqueue_tailored_content_generation
    from app.services.job_pipeline_mode import user_uses_original_resume
    from app.services.original_resume_service import get_original_resume_meta
    from app.storage.repository import ResumeBuildRepository
    from app.storage.user_repository import UserRepository
    from app.tasks.worker import get_resume_build_pool

    limit = max(1, min(int(limit or 50), MAX_PER_RUN))
    original = await user_uses_original_resume(user_id)
    original_missing = original and (await get_original_resume_meta(user_id)) is None

    async with get_session() as session:
        countries = await UserRepository(session).get_country_preferences(user_id)
        rows = (await session.execute(_scored_targets_stmt(user_id, countries, job_ids, limit))).all()

    remaining = max(0, len(rows) - limit)
    already_running = 0
    queued = 0
    failed = 0
    no_credits = 0
    budget = await credit_service.spendable_credits(user_id)
    for job_id, extraction_id, content_status in rows[:limit]:
        if content_status in IN_FLIGHT_CONTENT:
            already_running += 1
            continue

        async with get_session() as session:
            repo = ResumeBuildRepository(session)
            row = await repo.get(job_id, user_id)
            rebuild_only = _content_matches_mode(row, original)
            if not rebuild_only and budget is not None:
                if not await credit_service.preparation_is_free(job_id, user_id):
                    if budget < credit_service.PREPARE_COST:
                        no_credits += 1
                        continue
                    budget -= credit_service.PREPARE_COST
            if rebuild_only:
                await repo.upsert(job_id, user_id, row.tailored_resume_data, row.cover_letter_data)
            else:
                await repo.ensure_content_placeholder(job_id, user_id, status="pending")
            await session.commit()

        if rebuild_only:
            try:
                pool = await get_resume_build_pool()
                await pool.enqueue_job("build_resume_task", job_id, user_id)
                queued += 1
            except Exception as exc:  # noqa: BLE001 - keep queueing the rest
                logger.warning("scored_ready_build_enqueue_failed", job_id=job_id, error=str(exc)[:200])
                failed += 1
            continue

        if await enqueue_tailored_content_generation(job_id, user_id, extraction_id, manual=True):
            queued += 1
        else:
            failed += 1
            async with get_session() as session:
                await ResumeBuildRepository(session).fail_content_generation(
                    job_id, user_id, "Could not queue document generation"
                )
                await session.commit()

    logger.info(
        "scored_ready_queued",
        user_id=user_id,
        mode="original" if original else "tailored",
        queued=queued,
        already_running=already_running,
        failed=failed,
        no_credits=no_credits,
        remaining=remaining,
    )
    return {
        "queued": queued,
        "already_running": already_running,
        "failed": failed,
        "no_credits": no_credits,
        "remaining": remaining,
        "resume_source": "original" if original else "tailored",
        "original_resume_missing": original_missing,
    }
