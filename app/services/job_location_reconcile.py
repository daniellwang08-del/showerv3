"""Reconcile already-active jobs against US location rules."""

from __future__ import annotations

from sqlalchemy import and_, or_, select

from app.api.websocket import publish_ws_event
from app.core.logging import get_logger
from app.models.database import Job, JobExtraction, JobMatchResult, UserJobStatus
from app.services.job_exclusion_types import (
    LOCATION_UNKNOWN_EXCLUSION,
    NON_US_LOCATION_EXCLUSION,
)
from app.services.job_location_classifier import LocationVerdict, classify_job_location
from app.storage.database import get_session
from app.storage.repository import UserJobStatusRepository

logger = get_logger(__name__)


def _visible_active_filter(user_id: str):
    return (
        Job.status != "blocked",
        or_(
            UserJobStatus.status.is_(None),
            UserJobStatus.status == "active",
        ),
    )


async def _restore_us_location_exclusions(user_id: str) -> int:
    """Bring back jobs previously auto-hidden by the location rules whose location
    now classifies as US (e.g. after a classifier fix for US-inclusive postings
    such as "US or Canada"). Only location-based auto-exclusions are touched -
    manual hides, dedup, and score exclusions are left untouched."""
    restored = 0
    async with get_session() as session:
        stmt = (
            select(Job, JobExtraction, UserJobStatus.id)
            .join(UserJobStatus, and_(
                UserJobStatus.job_id == Job.id,
                UserJobStatus.user_id == user_id,
            ))
            .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            .where(
                UserJobStatus.status == "duplicated",
                UserJobStatus.exclusion_type.in_(
                    [NON_US_LOCATION_EXCLUSION, LOCATION_UNKNOWN_EXCLUSION]
                ),
            )
        )
        rows = (await session.execute(stmt)).all()
        ujs_repo = UserJobStatusRepository(session)
        for job, extraction, _ujs_id in rows:
            verdict, _detail = classify_job_location(
                job.location,
                remote_policy=extraction.remote_policy if extraction else None,
            )
            if verdict != LocationVerdict.US:
                continue
            await ujs_repo.upsert(
                user_id=user_id,
                job_id=job.id,
                status="active",
                exclusion_type=None,
                reason=None,
            )
            restored += 1
            await publish_ws_event({
                "type": "scrape_promoted",
                "user_id": user_id,
                "valid_job_id": job.id,
            })
    if restored:
        logger.info("job_location_reconcile_restored", user_id=user_id, restored=restored)
    return restored


async def reconcile_job_locations_for_user(user_id: str, *, batch_size: int = 500) -> dict:
    """Move visible active jobs with non-US or unknown locations into hidden lists,
    and restore any location-hidden jobs that now classify as US."""
    restored = await _restore_us_location_exclusions(user_id)
    moved_non_us = 0
    moved_unknown = 0
    scanned = 0

    while True:
        batch_moved_non_us = 0
        batch_moved_unknown = 0
        batch_scanned = 0

        async with get_session() as session:
            stmt = (
                select(Job, JobExtraction, JobMatchResult.overall_score)
                .outerjoin(UserJobStatus, and_(
                    UserJobStatus.job_id == Job.id,
                    UserJobStatus.user_id == user_id,
                ))
                .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
                .outerjoin(
                    JobMatchResult,
                    and_(
                        JobMatchResult.job_id == Job.id,
                        JobMatchResult.user_id == user_id,
                    ),
                )
                .where(*_visible_active_filter(user_id))
                .order_by(Job.created_at.desc())
                .limit(batch_size)
            )
            rows = (await session.execute(stmt)).all()
            if not rows:
                break

            ujs_repo = UserJobStatusRepository(session)
            for job, extraction, overall_score in rows:
                batch_scanned += 1
                verdict, detail = classify_job_location(
                    job.location,
                    remote_policy=extraction.remote_policy if extraction else None,
                )
                if verdict == LocationVerdict.US:
                    continue

                if verdict == LocationVerdict.NON_US:
                    exclusion_type = NON_US_LOCATION_EXCLUSION
                    reason = f"Non-US job location ({detail})."
                    batch_moved_non_us += 1
                else:
                    exclusion_type = LOCATION_UNKNOWN_EXCLUSION
                    reason = f"Job location could not be verified as US ({detail}). Review in Duplicates."
                    batch_moved_unknown += 1

                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=job.id,
                    status="duplicated",
                    exclusion_type=exclusion_type,
                    reason=reason,
                    match_score_at_decision=float(overall_score) if overall_score is not None else None,
                )
                await publish_ws_event({
                    "type": "job_excluded_for_user",
                    "user_id": user_id,
                    "valid_job_id": job.id,
                    "exclusion_type": exclusion_type,
                    "reason": reason,
                })

        scanned += batch_scanned
        moved_non_us += batch_moved_non_us
        moved_unknown += batch_moved_unknown

        if batch_moved_non_us == 0 and batch_moved_unknown == 0:
            break

    if moved_non_us or moved_unknown or restored:
        logger.info(
            "job_location_reconcile_completed",
            user_id=user_id,
            scanned=scanned,
            moved_non_us=moved_non_us,
            moved_unknown=moved_unknown,
            restored=restored,
        )

    return {
        "scanned": scanned,
        "moved_non_us": moved_non_us,
        "moved_unknown": moved_unknown,
        "restored": restored,
    }
