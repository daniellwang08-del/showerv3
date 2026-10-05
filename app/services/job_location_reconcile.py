"""Reconcile already-active jobs against the user's preferred-country rules.

Policy: drop only locations that explicitly resolve outside the user's
preferred countries. Missing / ambiguous locations stay visible so users can
filter them themselves. An empty preference list disables location filtering
entirely (everything previously hidden by location rules is restored).
"""

from __future__ import annotations

from sqlalchemy import and_, or_, select

from app.api.websocket import publish_ws_event
from app.core.logging import get_logger
from app.models.database import Job, JobExtraction, JobMatchResult, UserJobStatus
from app.services.country_catalog import describe_country_list
from app.services.job_exclusion_types import (
    LOCATION_EXCLUSION_TYPES,
    OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION,
)
from app.services.job_location_classifier import keeps_preferred_job_pool
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


async def _restore_location_exclusions(user_id: str, preferred: list[str]) -> int:
    """Bring back jobs previously auto-hidden by location rules that now belong
    in the user's preferred pool (match or unknown/missing). Covers legacy
    non_us_location rows and the current outside_preferred_countries rows.
    Only location-based auto-exclusions are touched - manual hides, dedup, and
    score exclusions are left untouched."""
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
                Job.status != "blocked",
                UserJobStatus.status == "duplicated",
                UserJobStatus.exclusion_type.in_(list(LOCATION_EXCLUSION_TYPES)),
            )
        )
        rows = (await session.execute(stmt)).all()
        ujs_repo = UserJobStatusRepository(session)
        for job, extraction, _ujs_id in rows:
            keep, _verdict, _detail = keeps_preferred_job_pool(
                job.location,
                remote_policy=extraction.remote_policy if extraction else None,
                allowed_countries=preferred,
            )
            if not keep:
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
    """Move visible active jobs with locations outside the user's preferred
    countries into the hidden list, and restore location-hidden jobs that now
    belong in the pool (including unknown locations)."""
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        preferred = await UserRepository(session).get_country_preferences(user_id)

    restored = await _restore_location_exclusions(user_id, preferred)
    moved_outside = 0
    scanned = 0

    # No preferences configured → no location filtering; restores already ran.
    if preferred:
        preferred_label = describe_country_list(preferred)

        # Snapshot all visible active job ids up front so every job is scanned
        # exactly once regardless of how many get hidden along the way.
        async with get_session() as session:
            id_stmt = (
                select(Job.id)
                .outerjoin(UserJobStatus, and_(
                    UserJobStatus.job_id == Job.id,
                    UserJobStatus.user_id == user_id,
                ))
                .where(*_visible_active_filter(user_id))
                .order_by(Job.created_at.desc())
            )
            job_ids = [row[0] for row in (await session.execute(id_stmt)).all()]

        for start in range(0, len(job_ids), batch_size):
            chunk = job_ids[start:start + batch_size]
            async with get_session() as session:
                stmt = (
                    select(Job, JobExtraction, JobMatchResult.overall_score)
                    .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
                    .outerjoin(
                        JobMatchResult,
                        and_(
                            JobMatchResult.job_id == Job.id,
                            JobMatchResult.user_id == user_id,
                        ),
                    )
                    .where(Job.id.in_(chunk))
                )
                rows = (await session.execute(stmt)).all()

                ujs_repo = UserJobStatusRepository(session)
                from app.services.job_location_classifier import job_was_added_by_user

                for job, extraction, overall_score in rows:
                    scanned += 1
                    if job_was_added_by_user(job.raw_metadata, user_id):
                        continue
                    keep, _verdict, detail = keeps_preferred_job_pool(
                        job.location,
                        remote_policy=extraction.remote_policy if extraction else None,
                        allowed_countries=preferred,
                    )
                    if keep:
                        continue

                    exclusion_type = OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION
                    reason = (
                        f"Job location is outside your preferred countries "
                        f"({preferred_label}): {detail}."
                    )
                    moved_outside += 1

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

    if moved_outside or restored:
        logger.info(
            "job_location_reconcile_completed",
            user_id=user_id,
            scanned=scanned,
            moved_non_us=moved_outside,
            moved_unknown=0,
            restored=restored,
            preferred_countries=preferred,
        )

    return {
        "scanned": scanned,
        "moved_non_us": moved_outside,
        "moved_unknown": 0,
        "restored": restored,
        "preferred_countries": preferred,
    }
