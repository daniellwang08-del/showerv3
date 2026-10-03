"""Auto-prepare opted-in users after shared JD is ready (match and/or full).

Design:
  - Job-first fan-out: for each newly EXTRACTED job, enqueue analyze for every
    opted-in user missing a score (fair across users).
  - Match-only sets skip_phase_b so Phase B does not run.
  - Full keeps Phase B subject to the platform auto_generate kill-switch.
  - Backfill on preference enable is chunked with a per-user pending cap.
  - Platform ``auto_prepare_enabled`` pauses fan-out/backfill (manual Run OK).
  - Daily cap (0 = unlimited) counts only auto-prepare enqueues (fanout/backfill),
    never manual Run / all match results.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, or_, select

from app.core.logging import get_logger
from app.models.database import Job, JobExtraction, JobMatchResult, ResumeBuildResult, User, UserJobStatus
from app.services.job_pipeline_mode import extraction_has_shared_jd
from app.storage.database import get_session

logger = get_logger(__name__)

# Soft caps, protect LLM spend / queue depth under multi-user auto-prepare.
AUTO_PREPARE_FANOUT_MAX_USERS = 200
AUTO_PREPARE_BACKFILL_CHUNK = 50
# Redis counter TTL for per-user auto-prepare daily enqueue budget (UTC day).
_AUTO_PREPARE_DAILY_TTL_SECONDS = 60 * 60 * 36


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _utc_day_start() -> datetime:
    now = _utcnow_naive()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _auto_prepare_daily_redis_key(user_id: str, day: datetime | None = None) -> str:
    day = day or _utc_day_start()
    return f"auto_prepare:daily:{user_id}:{day.strftime('%Y%m%d')}"


async def _auto_prepare_daily_count(user_id: str) -> int:
    """Enqueues attributed to auto-prepare today (fanout/backfill), not manual Run."""
    try:
        from app.core.redis_support import get_broker_redis

        raw = await get_broker_redis().get(_auto_prepare_daily_redis_key(user_id))
        return max(0, int(raw or 0))
    except Exception as err:
        logger.warning("auto_prepare_daily_count_failed", user_id=user_id, error=str(err))
        return 0


async def _bump_auto_prepare_daily(user_id: str) -> None:
    try:
        from app.core.redis_support import get_broker_redis

        r = get_broker_redis()
        key = _auto_prepare_daily_redis_key(user_id)
        count = await r.incr(key)
        if int(count or 0) == 1:
            await r.expire(key, _AUTO_PREPARE_DAILY_TTL_SECONDS)
    except Exception as err:
        logger.warning("auto_prepare_daily_bump_failed", user_id=user_id, error=str(err))


async def _auto_prepare_globally_enabled() -> bool:
    try:
        from app.services.system_settings_service import get_effective_value

        return bool(await get_effective_value("auto_prepare_enabled"))
    except Exception:
        from app.core.config import get_settings

        return bool(get_settings().auto_prepare_enabled)


async def _pending_cap() -> int:
    try:
        from app.services.system_settings_service import get_effective_value

        return int(await get_effective_value("auto_prepare_pending_cap_per_user"))
    except Exception:
        from app.core.config import get_settings

        return int(get_settings().auto_prepare_pending_cap_per_user)


async def _daily_cap() -> int:
    """Return daily auto-prepare enqueue cap. ``0`` means unlimited."""
    try:
        from app.services.system_settings_service import get_effective_value

        return max(0, int(await get_effective_value("auto_prepare_daily_cap_per_user")))
    except Exception:
        from app.core.config import get_settings

        return max(0, int(get_settings().auto_prepare_daily_cap_per_user))


async def list_auto_prepare_users(
    *,
    match: bool = True,
    full: bool = False,
) -> list[dict[str, Any]]:
    """Return opted-in active users (id + flags)."""
    async with get_session() as session:
        conds = [User.is_active.is_(True)]
        flag_conds = []
        if match:
            flag_conds.append(User.auto_prepare_match.is_(True))
        if full:
            flag_conds.append(User.auto_prepare_full.is_(True))
        if not flag_conds:
            return []
        conds.append(or_(*flag_conds))
        rows = (
            await session.execute(
                select(User.id, User.auto_prepare_match, User.auto_prepare_full)
                .where(*conds)
                .limit(AUTO_PREPARE_FANOUT_MAX_USERS)
            )
        ).all()
        return [
            {
                "user_id": row.id,
                "auto_prepare_match": bool(row.auto_prepare_match),
                "auto_prepare_full": bool(row.auto_prepare_full),
            }
            for row in rows
        ]


async def fanout_auto_prepare_for_job(
    job_id: str,
    extraction_id: str | None = None,
) -> dict[str, Any]:
    """After shared JD is ready: enqueue analyze for each opted-in user without a score."""
    if not await _auto_prepare_globally_enabled():
        logger.info("auto_prepare_fanout_paused", job_id=job_id)
        return {"job_id": job_id, "enqueued": 0, "skipped": 0, "users": 0, "paused": True}

    users = await list_auto_prepare_users(match=True, full=True)
    if not users:
        return {"job_id": job_id, "enqueued": 0, "skipped": 0, "users": 0}

    enqueued = 0
    skipped = 0
    async with get_session() as session:
        job = (
            await session.execute(select(Job).where(Job.id == job_id))
        ).scalar_one_or_none()
        if not job:
            logger.warning("auto_prepare_fanout_job_missing", job_id=job_id)
            return {"job_id": job_id, "enqueued": 0, "skipped": 0, "users": 0, "error": "job_not_found"}

        ext_id = extraction_id or job.extraction_id
        if not ext_id:
            return {"job_id": job_id, "enqueued": 0, "skipped": 0, "users": len(users), "error": "no_extraction"}

        extraction = (
            await session.execute(select(JobExtraction).where(JobExtraction.id == ext_id))
        ).scalar_one_or_none()
        if not extraction_has_shared_jd(extraction):
            return {
                "job_id": job_id,
                "enqueued": 0,
                "skipped": 0,
                "users": len(users),
                "error": "jd_not_ready",
            }

        existing = set(
            (
                await session.execute(
                    select(JobMatchResult.user_id).where(
                        JobMatchResult.job_id == job_id,
                        JobMatchResult.user_id.in_([u["user_id"] for u in users]),
                    )
                )
            ).scalars().all()
        )

    for idx, user in enumerate(users):
        uid = user["user_id"]
        if uid in existing:
            skipped += 1
            continue
        # Full ⇒ Phase B allowed; match-only ⇒ skip Phase B.
        skip_phase_b = not bool(user["auto_prepare_full"])
        # Stagger under fan-out so analysis queue is not slammed at once.
        defer_by = timedelta(seconds=min(idx * 0.25, 30.0)) if idx else None
        ok = await _enqueue_analyze(
            job_id,
            uid,
            extraction_id=ext_id,
            skip_phase_b=skip_phase_b,
            source="fanout",
            defer_by=defer_by,
        )
        if ok:
            enqueued += 1
        else:
            skipped += 1

    logger.info(
        "auto_prepare_fanout_complete",
        job_id=job_id,
        extraction_id=ext_id,
        users=len(users),
        enqueued=enqueued,
        skipped=skipped,
    )
    return {
        "job_id": job_id,
        "extraction_id": ext_id,
        "users": len(users),
        "enqueued": enqueued,
        "skipped": skipped,
    }


async def backfill_auto_prepare_for_user(
    user_id: str,
    *,
    match: bool,
    full: bool,
    limit: int = AUTO_PREPARE_BACKFILL_CHUNK,
) -> dict[str, Any]:
    """Chunked backfill when a user enables auto-prepare prefs."""
    if not match and not full:
        return {"user_id": user_id, "enqueued_analyze": 0, "enqueued_tailor": 0, "remaining": 0}

    if not await _auto_prepare_globally_enabled():
        logger.info("auto_prepare_backfill_paused", user_id=user_id)
        return {
            "user_id": user_id,
            "enqueued_analyze": 0,
            "enqueued_tailor": 0,
            "remaining": 0,
            "paused": True,
        }

    limit = max(1, min(int(limit), AUTO_PREPARE_BACKFILL_CHUNK))
    enqueued_analyze = 0
    enqueued_tailor = 0
    remaining = 0

    async with get_session() as session:
        # Prefer newer jobs over ancient inventory for backfill fairness.
        missing_match_stmt = (
            select(Job.id, Job.extraction_id)
            .outerjoin(
                UserJobStatus,
                and_(
                    UserJobStatus.job_id == Job.id,
                    UserJobStatus.user_id == user_id,
                ),
            )
            .outerjoin(
                JobMatchResult,
                and_(
                    JobMatchResult.job_id == Job.id,
                    JobMatchResult.user_id == user_id,
                ),
            )
            .join(JobExtraction, JobExtraction.id == Job.extraction_id)
            .where(
                Job.status != "blocked",
                Job.extraction_id.is_not(None),
                JobMatchResult.id.is_(None),
                or_(
                    UserJobStatus.status.is_(None),
                    UserJobStatus.status == "active",
                ),
                JobExtraction.status.in_(("extracted", "completed")),
            )
            .order_by(func.coalesce(Job.posted_date, Job.created_at).desc())
            .limit(limit + 1)
        )
        missing_rows = (await session.execute(missing_match_stmt)).all()
        remaining = max(0, len(missing_rows) - limit)
        analyze_targets = missing_rows[:limit]

        tailor_targets: list[tuple[str, str | None]] = []
        if full:
            # Already scored but missing tailored content / docs.
            tailor_stmt = (
                select(Job.id, Job.extraction_id)
                .join(
                    JobMatchResult,
                    and_(
                        JobMatchResult.job_id == Job.id,
                        JobMatchResult.user_id == user_id,
                    ),
                )
                .outerjoin(
                    ResumeBuildResult,
                    and_(
                        ResumeBuildResult.job_id == Job.id,
                        ResumeBuildResult.user_id == user_id,
                    ),
                )
                .outerjoin(
                    UserJobStatus,
                    and_(
                        UserJobStatus.job_id == Job.id,
                        UserJobStatus.user_id == user_id,
                    ),
                )
                .where(
                    Job.status != "blocked",
                    JobMatchResult.overall_score > 0,
                    or_(
                        UserJobStatus.status.is_(None),
                        UserJobStatus.status == "active",
                    ),
                    or_(
                        ResumeBuildResult.id.is_(None),
                        ResumeBuildResult.tailored_resume_data.is_(None),
                        ResumeBuildResult.cover_letter_data.is_(None),
                    ),
                )
                .order_by(JobMatchResult.overall_score.desc())
                .limit(limit)
            )
            tailor_targets = list((await session.execute(tailor_stmt)).all())

    skip_phase_b = not full
    for idx, (job_id, extraction_id) in enumerate(analyze_targets):
        defer_by = timedelta(seconds=min(idx * 0.5, 60.0)) if idx else None
        ok = await _enqueue_analyze(
            job_id,
            user_id,
            extraction_id=extraction_id,
            skip_phase_b=skip_phase_b,
            source="backfill",
            defer_by=defer_by,
        )
        if ok:
            enqueued_analyze += 1

    if full:
        from app.services.job_match_orchestrator import enqueue_tailored_content_generation

        for job_id, extraction_id in tailor_targets:
            # Skip if we just enqueued analyze for the same job (Phase B will chain).
            if any(j == job_id for j, _ in analyze_targets):
                continue
            if await enqueue_tailored_content_generation(job_id, user_id, extraction_id):
                enqueued_tailor += 1

    logger.info(
        "auto_prepare_backfill_complete",
        user_id=user_id,
        match=match,
        full=full,
        enqueued_analyze=enqueued_analyze,
        enqueued_tailor=enqueued_tailor,
        remaining=remaining,
    )
    return {
        "user_id": user_id,
        "enqueued_analyze": enqueued_analyze,
        "enqueued_tailor": enqueued_tailor,
        "remaining": remaining,
        "chunk": limit,
    }


async def _enqueue_analyze(
    job_id: str,
    user_id: str,
    *,
    extraction_id: str | None,
    skip_phase_b: bool,
    source: str,
    defer_by: timedelta | None = None,
) -> bool:
    """Enqueue personal analysis; returns False if queue unavailable / capped."""
    from app.core.redis_support import pipeline_job_id
    from app.models.database import JobMatchInProgress
    from app.storage.repository import JobMatchInProgressRepository
    from app.tasks.worker import ANALYSIS_QUEUE, get_analysis_pool

    try:
        pending_cap = await _pending_cap()
        daily_cap = await _daily_cap()

        async with get_session() as session:
            pending = (
                await session.execute(
                    select(func.count())
                    .select_from(JobMatchInProgress)
                    .where(JobMatchInProgress.user_id == user_id)
                )
            ).scalar_one()
            if int(pending or 0) >= pending_cap:
                logger.info(
                    "auto_prepare_pending_cap_hit",
                    user_id=user_id,
                    job_id=job_id,
                    pending=pending,
                    cap=pending_cap,
                    source=source,
                )
                return False

            # 0 = unlimited. When capped, count only auto-prepare enqueues
            # (Redis), not every JobMatchResult / manual Run.
            if daily_cap > 0:
                today_auto = await _auto_prepare_daily_count(user_id)
                if today_auto >= daily_cap:
                    logger.info(
                        "auto_prepare_daily_cap_hit",
                        user_id=user_id,
                        job_id=job_id,
                        soft_daily=today_auto,
                        cap=daily_cap,
                        source=source,
                    )
                    return False

            progress_repo = JobMatchInProgressRepository(session)
            await progress_repo.add(job_id, user_id)
            await session.commit()

        try:
            pool = await get_analysis_pool()
        except Exception as pool_err:
            async with get_session() as session:
                progress_repo = JobMatchInProgressRepository(session)
                await progress_repo.remove(job_id, user_id)
                await session.commit()
            logger.warning(
                "auto_prepare_no_analysis_pool",
                job_id=job_id,
                user_id=user_id,
                error=str(pool_err),
            )
            return False

        arq_id = pipeline_job_id("analyze", job_id, user_id)
        enqueue_kwargs: dict[str, Any] = {"_job_id": arq_id}
        if defer_by is not None and defer_by.total_seconds() > 0:
            enqueue_kwargs["_defer_by"] = defer_by
        job = await pool.enqueue_job(
            "analyze_job_match",
            job_id,
            user_id,
            extraction_id,
            skip_phase_b,
            **enqueue_kwargs,
        )
        # Count only newly enqueued auto-prepare work toward the daily budget.
        if job is not None:
            await _bump_auto_prepare_daily(user_id)
        logger.info(
            "auto_prepare_analyze_enqueued",
            job_id=job_id,
            user_id=user_id,
            queue=ANALYSIS_QUEUE,
            skip_phase_b=skip_phase_b,
            source=source,
            defer_by_s=defer_by.total_seconds() if defer_by else 0,
            already_queued=job is None,
            daily_cap=daily_cap,
        )
        return True
    except Exception as e:
        logger.warning(
            "auto_prepare_analyze_enqueue_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
            source=source,
        )
        try:
            async with get_session() as session:
                progress_repo = JobMatchInProgressRepository(session)
                await progress_repo.remove(job_id, user_id)
                await session.commit()
        except Exception:
            pass
        return False
