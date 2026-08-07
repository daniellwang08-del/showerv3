"""Preview and reconcile optional per-user dedup rules (applied company / score cmp)."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select

from app.api.websocket import publish_ws_event
from app.core.logging import get_logger
from app.models.database import Job, JobMatchResult, UserJobStatus, ValidJobUserApplication
from app.services.job_exclusion_types import (
    APPLIED_COMPANY_EXCLUSION,
    LOCATION_UNKNOWN_EXCLUSION,
    LOWER_SCORE_EXCLUSION,
    SUPERSEDED_BY_HIGHER_EXCLUSION,
)
from app.services.post_analysis_dedup import resolve_employer_key
from app.storage.database import get_session
from app.storage.repository import UserJobStatusRepository
from app.storage.user_repository import UserRepository

logger = get_logger(__name__)

_SCORE_CMP_EXCLUSIONS = frozenset({LOWER_SCORE_EXCLUSION, SUPERSEDED_BY_HIGHER_EXCLUSION})


def _utcnow() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE; asyncpg rejects aware datetimes.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _visible_in_dashboard_filter(user_id: str):
    return (
        Job.status != "blocked",
        or_(
            UserJobStatus.status.is_(None),
            UserJobStatus.status == "active",
        ),
    )


def _ujs_onclause(user_id: str):
    return and_(
        UserJobStatus.job_id == Job.id,
        UserJobStatus.user_id == user_id,
    )


def _match_onclause(user_id: str):
    return and_(
        JobMatchResult.job_id == Job.id,
        JobMatchResult.user_id == user_id,
    )


async def restore_location_unknown_for_user(user_id: str | None = None) -> int:
    """Restore location_unknown exclusions (unknown loc is treated as US)."""
    restored = 0
    async with get_session() as session:
        ujs_repo = UserJobStatusRepository(session)
        stmt = select(UserJobStatus).where(
            UserJobStatus.status == "duplicated",
            UserJobStatus.exclusion_type == LOCATION_UNKNOWN_EXCLUSION,
        )
        if user_id:
            stmt = stmt.where(UserJobStatus.user_id == user_id)
        rows = list((await session.execute(stmt)).scalars().all())
        for ujs in rows:
            await ujs_repo.upsert(
                user_id=ujs.user_id,
                job_id=ujs.job_id,
                status="active",
                exclusion_type=None,
                duplicated_because_id=None,
                reason=None,
                match_score_at_decision=ujs.match_score_at_decision,
            )
            await publish_ws_event({
                "type": "job_status_changed",
                "user_id": ujs.user_id,
                "job_id": ujs.job_id,
                "status": "active",
            })
            restored += 1
    return restored


async def preview_dedup_rules_for_user(
    user_id: str,
    *,
    applied_company_enabled: bool,
    score_comparison_enabled: bool,
    recycle_days: int | None = None,
) -> dict:
    """Dry-run counts for enabling/disabling optional dedup rules."""
    async with get_session() as session:
        user_repo = UserRepository(session)
        if recycle_days is None:
            recycle_days = await user_repo.get_effective_dedup_recycle_days(user_id)
        recycle_days = max(1, min(3650, int(recycle_days)))

        restore_types: list[str] = []
        if not applied_company_enabled:
            restore_types.append(APPLIED_COMPANY_EXCLUSION)
        if not score_comparison_enabled:
            restore_types.extend(sorted(_SCORE_CMP_EXCLUSIONS))

        would_restore = 0
        restore_samples: list[dict] = []
        if restore_types:
            would_restore = (
                await session.execute(
                    select(func.count())
                    .select_from(UserJobStatus)
                    .where(
                        UserJobStatus.user_id == user_id,
                        UserJobStatus.status == "duplicated",
                        UserJobStatus.exclusion_type.in_(restore_types),
                    )
                )
            ).scalar_one()
            sample_rows = await session.execute(
                select(Job.id, Job.title, Job.company, UserJobStatus.exclusion_type)
                .join(UserJobStatus, _ujs_onclause(user_id))
                .where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.status == "duplicated",
                    UserJobStatus.exclusion_type.in_(restore_types),
                )
                .limit(5)
            )
            restore_samples = [
                {
                    "job_id": row.id,
                    "title": row.title,
                    "company": row.company,
                    "exclusion_type": row.exclusion_type,
                    "action": "restore",
                }
                for row in sample_rows.all()
            ]

        already_hidden_applied = (
            await session.execute(
                select(func.count())
                .select_from(UserJobStatus)
                .where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.status == "duplicated",
                    UserJobStatus.exclusion_type == APPLIED_COMPANY_EXCLUSION,
                )
            )
        ).scalar_one()

        already_hidden_score = (
            await session.execute(
                select(func.count())
                .select_from(UserJobStatus)
                .where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.status == "duplicated",
                    UserJobStatus.exclusion_type.in_(list(_SCORE_CMP_EXCLUSIONS)),
                )
            )
        ).scalar_one()

        hide_applied_candidates = await _collect_applied_company_hide_targets(
            session, user_id=user_id, recycle_days=recycle_days
        )
        would_hide_applied = len(hide_applied_candidates) if applied_company_enabled else 0

        hide_score_candidates = await _collect_score_comparison_hide_targets(
            session, user_id=user_id, recycle_days=recycle_days
        )
        would_hide_score = len(hide_score_candidates) if score_comparison_enabled else 0

        hide_samples: list[dict] = []
        if applied_company_enabled:
            for job, applied_job_id in hide_applied_candidates[:5]:
                hide_samples.append(
                    {
                        "job_id": job.id,
                        "title": job.title,
                        "company": job.company,
                        "exclusion_type": APPLIED_COMPANY_EXCLUSION,
                        "action": "hide",
                        "duplicated_because_id": applied_job_id,
                    }
                )
        if score_comparison_enabled and len(hide_samples) < 5:
            for job, winner_id, score, best_score in hide_score_candidates[
                : 5 - len(hide_samples)
            ]:
                hide_samples.append(
                    {
                        "job_id": job.id,
                        "title": job.title,
                        "company": job.company,
                        "exclusion_type": LOWER_SCORE_EXCLUSION,
                        "action": "hide",
                        "duplicated_because_id": winner_id,
                        "match_score": score,
                        "best_score": best_score,
                    }
                )

    return {
        "applied_company_enabled": applied_company_enabled,
        "score_comparison_enabled": score_comparison_enabled,
        "recycle_days": recycle_days,
        "would_restore_count": would_restore,
        "would_hide_applied_company_count": would_hide_applied,
        "would_hide_score_comparison_count": would_hide_score,
        "already_hidden_applied_company_count": already_hidden_applied,
        "already_hidden_score_comparison_count": already_hidden_score,
        "samples": restore_samples + hide_samples,
    }


async def reconcile_dedup_rules_for_user(
    user_id: str,
    *,
    applied_company_enabled: bool | None = None,
    score_comparison_enabled: bool | None = None,
    recycle_days: int | None = None,
) -> dict:
    """Restore/hide UJS rows to match effective optional dedup rules."""
    restored_location_unknown = await restore_location_unknown_for_user(user_id)

    restored = 0
    hidden_applied = 0
    hidden_score = 0

    async with get_session() as session:
        user_repo = UserRepository(session)
        if applied_company_enabled is None:
            applied_company_enabled = await user_repo.get_effective_dedup_applied_company_enabled(
                user_id
            )
        if score_comparison_enabled is None:
            score_comparison_enabled = (
                await user_repo.get_effective_dedup_score_comparison_enabled(user_id)
            )
        if recycle_days is None:
            recycle_days = await user_repo.get_effective_dedup_recycle_days(user_id)
        recycle_days = max(1, min(3650, int(recycle_days)))

        ujs_repo = UserJobStatusRepository(session)

        restore_types: list[str] = []
        if not applied_company_enabled:
            restore_types.append(APPLIED_COMPANY_EXCLUSION)
        if not score_comparison_enabled:
            restore_types.extend(sorted(_SCORE_CMP_EXCLUSIONS))

        if restore_types:
            rows = list(
                (
                    await session.execute(
                        select(UserJobStatus).where(
                            UserJobStatus.user_id == user_id,
                            UserJobStatus.status == "duplicated",
                            UserJobStatus.exclusion_type.in_(restore_types),
                        )
                    )
                ).scalars().all()
            )
            for ujs in rows:
                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=ujs.job_id,
                    status="active",
                    exclusion_type=None,
                    duplicated_because_id=None,
                    reason=None,
                    match_score_at_decision=ujs.match_score_at_decision,
                )
                await publish_ws_event({
                    "type": "job_status_changed",
                    "user_id": user_id,
                    "job_id": ujs.job_id,
                    "status": "active",
                })
                restored += 1

        if applied_company_enabled:
            targets = await _collect_applied_company_hide_targets(
                session, user_id=user_id, recycle_days=recycle_days
            )
            for job, applied_job_id in targets:
                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=job.id,
                    status="duplicated",
                    exclusion_type=APPLIED_COMPANY_EXCLUSION,
                    duplicated_because_id=applied_job_id,
                    reason=(
                        f"User already applied to another posting at this company "
                        f"within the {recycle_days}-day recycle window."
                    ),
                    match_score_at_decision=None,
                )
                await publish_ws_event({
                    "type": "job_status_changed",
                    "user_id": user_id,
                    "job_id": job.id,
                    "status": "duplicated",
                    "exclusion_type": APPLIED_COMPANY_EXCLUSION,
                })
                hidden_applied += 1

        if score_comparison_enabled:
            targets = await _collect_score_comparison_hide_targets(
                session, user_id=user_id, recycle_days=recycle_days
            )
            for job, winner_id, score, best_score in targets:
                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=job.id,
                    status="duplicated",
                    exclusion_type=LOWER_SCORE_EXCLUSION,
                    duplicated_because_id=winner_id,
                    reason=(
                        f"Lower or equal match score ({score}% vs {best_score}%) "
                        f"at the same company."
                    ),
                    match_score_at_decision=float(score),
                )
                await publish_ws_event({
                    "type": "job_status_changed",
                    "user_id": user_id,
                    "job_id": job.id,
                    "status": "duplicated",
                    "exclusion_type": LOWER_SCORE_EXCLUSION,
                })
                hidden_score += 1

    logger.info(
        "dedup_rules_reconciled",
        user_id=user_id,
        restored=restored,
        restored_location_unknown=restored_location_unknown,
        hidden_applied=hidden_applied,
        hidden_score=hidden_score,
        applied_company_enabled=applied_company_enabled,
        score_comparison_enabled=score_comparison_enabled,
    )
    return {
        "restored": restored,
        "restored_location_unknown": restored_location_unknown,
        "hidden_applied_company": hidden_applied,
        "hidden_score_comparison": hidden_score,
        "applied_company_enabled": applied_company_enabled,
        "score_comparison_enabled": score_comparison_enabled,
        "recycle_days": recycle_days,
    }


async def _collect_applied_company_hide_targets(
    session,
    *,
    user_id: str,
    recycle_days: int,
) -> list[tuple[Job, str]]:
    """Visible jobs at employers the user applied to within the recycle window."""
    cutoff = _utcnow() - timedelta(days=recycle_days)
    applied_rows = await session.execute(
        select(Job, ValidJobUserApplication)
        .join(
            ValidJobUserApplication,
            and_(
                ValidJobUserApplication.job_id == Job.id,
                ValidJobUserApplication.user_id == user_id,
            ),
        )
        .where(ValidJobUserApplication.applied_at >= cutoff)
    )
    applied_by_key: dict[str, str] = {}
    for job, app in applied_rows.all():
        key = resolve_employer_key(job)
        if not key:
            continue
        # Prefer any applied job id for duplicated_because_id.
        applied_by_key.setdefault(key, app.job_id)

    if not applied_by_key:
        return []

    visible_rows = await session.execute(
        select(Job)
        .outerjoin(UserJobStatus, _ujs_onclause(user_id))
        .where(*_visible_in_dashboard_filter(user_id))
        .where(func.coalesce(Job.posted_date, Job.created_at) >= cutoff)
    )
    applied_job_ids = set(applied_by_key.values())
    targets: list[tuple[Job, str]] = []
    for job in visible_rows.scalars().all():
        if job.id in applied_job_ids:
            continue
        key = resolve_employer_key(job)
        if not key or key not in applied_by_key:
            continue
        targets.append((job, applied_by_key[key]))
    return targets


async def _collect_score_comparison_hide_targets(
    session,
    *,
    user_id: str,
    recycle_days: int,
) -> list[tuple[Job, str, int, int]]:
    """Within recycle window, demote lower-scoring visible jobs per employer key."""
    cutoff = _utcnow() - timedelta(days=recycle_days)
    rows = await session.execute(
        select(Job, JobMatchResult.overall_score)
        .join(JobMatchResult, _match_onclause(user_id))
        .outerjoin(UserJobStatus, _ujs_onclause(user_id))
        .where(*_visible_in_dashboard_filter(user_id))
        .where(func.coalesce(Job.posted_date, Job.created_at) >= cutoff)
    )
    by_key: dict[str, list[tuple[Job, int]]] = defaultdict(list)
    for job, score in rows.all():
        key = resolve_employer_key(job)
        if not key:
            continue
        by_key[key].append((job, int(score or 0)))

    targets: list[tuple[Job, str, int, int]] = []
    for group in by_key.values():
        if len(group) < 2:
            continue
        group_sorted = sorted(group, key=lambda item: item[1], reverse=True)
        winner_job, best_score = group_sorted[0]
        for job, score in group_sorted[1:]:
            targets.append((job, winner_job.id, score, best_score))
    return targets
