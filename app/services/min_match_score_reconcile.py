"""Preview and reconcile jobs against a user's minimum match score threshold."""

from __future__ import annotations

from sqlalchemy import select, func, or_, and_

from app.models.database import Job, JobMatchResult, UserJobStatus
from app.storage.repository import UserJobStatusRepository
from app.storage.database import get_session
from app.api.websocket import publish_ws_event
from app.core.logging import get_logger

logger = get_logger(__name__)

BELOW_MIN_SCORE_EXCLUSION = "below_min_score"


def _visible_in_dashboard_filter(user_id: str):
    """Same visibility rule as GET /jobs/dashboard for this user."""
    return (
        Job.status != "blocked",
        or_(
            UserJobStatus.status.is_(None),
            UserJobStatus.status == "active",
        ),
    )


def _match_onclause(user_id: str):
    return and_(
        JobMatchResult.job_id == Job.id,
        JobMatchResult.user_id == user_id,
    )


def _ujs_onclause(user_id: str):
    return and_(
        UserJobStatus.job_id == Job.id,
        UserJobStatus.user_id == user_id,
    )


async def preview_min_match_score_for_user(user_id: str, min_score: int) -> dict:
    """Dry-run: how many visible analyzed jobs would be hidden at this threshold."""
    async with get_session() as session:
        base_visible = (
            select(Job.id, Job.title, Job.company, JobMatchResult.overall_score)
            .join(JobMatchResult, _match_onclause(user_id))
            .outerjoin(UserJobStatus, _ujs_onclause(user_id))
            .where(*_visible_in_dashboard_filter(user_id))
        )

        analyzed_visible = (await session.execute(
            select(func.count()).select_from(base_visible.subquery())
        )).scalar_one()

        would_hide = 0
        meeting_threshold = analyzed_visible
        samples: list[dict] = []

        if min_score > 0:
            below_stmt = base_visible.where(JobMatchResult.overall_score < min_score)
            would_hide = (await session.execute(
                select(func.count()).select_from(below_stmt.subquery())
            )).scalar_one()
            meeting_threshold = analyzed_visible - would_hide

            sample_rows = await session.execute(
                below_stmt.order_by(
                    JobMatchResult.created_at.desc(),
                    Job.created_at.desc(),
                ).limit(5)
            )
            samples = [
                {
                    "job_id": row[0],
                    "title": row[1],
                    "company": row[2],
                    "match_score": int(row[3]),
                }
                for row in sample_rows.all()
            ]

        already_hidden = (await session.execute(
            select(func.count())
            .select_from(UserJobStatus)
            .where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "duplicated",
                UserJobStatus.exclusion_type == BELOW_MIN_SCORE_EXCLUSION,
            )
        )).scalar_one()

        would_restore = 0
        if min_score == 0:
            would_restore = already_hidden
        else:
            restore_stmt = (
                select(func.count())
                .select_from(UserJobStatus)
                .join(Job, Job.id == UserJobStatus.job_id)
                .join(
                    JobMatchResult,
                    (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
                )
                .where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.status == "duplicated",
                    UserJobStatus.exclusion_type == BELOW_MIN_SCORE_EXCLUSION,
                    JobMatchResult.overall_score >= min_score,
                )
            )
            would_restore = (await session.execute(restore_stmt)).scalar_one()

    return {
        "threshold": min_score,
        "analyzed_visible_count": analyzed_visible,
        "would_hide_count": would_hide,
        "meeting_threshold_count": meeting_threshold,
        "already_hidden_count": already_hidden,
        "would_restore_count": would_restore,
        "samples": samples,
    }


async def reconcile_min_match_score_for_user(user_id: str, min_score: int) -> dict:
    """Hide visible analyzed jobs below threshold; restore low-score exclusions at/above threshold."""
    hidden = 0
    restored = 0

    async with get_session() as session:
        ujs_repo = UserJobStatusRepository(session)

        if min_score > 0:
            hide_rows = await session.execute(
                select(Job.id, JobMatchResult.overall_score)
                .join(JobMatchResult, _match_onclause(user_id))
                .outerjoin(UserJobStatus, _ujs_onclause(user_id))
                .where(*_visible_in_dashboard_filter(user_id))
                .where(JobMatchResult.overall_score < min_score)
            )
            for job_id, overall_score in hide_rows.all():
                score = int(overall_score)
                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=job_id,
                    status="duplicated",
                    exclusion_type=BELOW_MIN_SCORE_EXCLUSION,
                    duplicated_because_id=None,
                    reason=(
                        f"Match score {score}% is below your minimum threshold ({min_score}%)."
                    ),
                    match_score_at_decision=float(score),
                )
                await publish_ws_event({
                    "type": "job_status_changed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "status": "duplicated",
                    "exclusion_type": BELOW_MIN_SCORE_EXCLUSION,
                })
                hidden += 1

        low_score_rows = await session.execute(
            select(UserJobStatus, JobMatchResult)
            .outerjoin(
                JobMatchResult,
                (JobMatchResult.job_id == UserJobStatus.job_id)
                & (JobMatchResult.user_id == user_id),
            )
            .where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "duplicated",
                UserJobStatus.exclusion_type == BELOW_MIN_SCORE_EXCLUSION,
            )
        )
        for ujs, match in low_score_rows.all():
            score = int(match.overall_score) if match and match.overall_score is not None else None
            if min_score > 0 and (score is None or score < min_score):
                continue
            restore_score = float(score if score is not None else 0)
            await ujs_repo.upsert(
                user_id=user_id,
                job_id=ujs.job_id,
                status="active",
                exclusion_type=None,
                duplicated_because_id=None,
                reason=None,
                match_score_at_decision=restore_score,
            )
            await publish_ws_event({
                "type": "job_status_changed",
                "user_id": user_id,
                "job_id": ujs.job_id,
                "status": "active",
            })
            restored += 1

        await session.commit()

    logger.info(
        "min_match_score_reconcile_done",
        user_id=user_id,
        min_score=min_score,
        hidden=hidden,
        restored=restored,
    )
    return {
        "success": True,
        "min_match_score": min_score,
        "hidden": hidden,
        "restored": restored,
    }
