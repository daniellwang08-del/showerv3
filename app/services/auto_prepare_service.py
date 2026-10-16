"""Auto-prepare opted-in users after shared JD is ready (match and/or full).

Design:
  - Job-first fan-out: for each newly EXTRACTED job, enqueue analyze for every
    opted-in user missing a score (fair across users).
  - Match-only sets skip_phase_b so Phase B does not run.
  - Full keeps Phase B subject to the platform auto_generate kill-switch.
  - Backfill on preference enable is chunked with a per-user pending cap.
  - Platform ``auto_prepare_enabled`` pauses fan-out/backfill (manual Run OK).
  - Daily cap (0 = unlimited) counts only auto-prepare enqueues (fanout/backfill),
    never manual Run / all match results, and never free match-only scoring
    under the vector engine (no LLM is called).
  - Every path scores only jobs the user can see (``job_share_visibility_clause``):
    another person's private add is never scored for anyone else, and sharing
    an add later fans its jobs out to the people it now reaches.
  - Opening the Jobs page runs a throttled catch-up of unscored visible jobs,
    so nothing waits on a missed fan-out.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, or_, select

from app.core.logging import get_logger
from app.models.database import Job, JobExtraction, JobMatchResult, ResumeBuildResult, User, UserJobStatus
from app.services.job_add_batches import job_share_visibility_clause, users_who_can_see_job
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


async def _free_engine_active() -> bool:
    """True when match scoring makes no LLM call (vector engine)."""
    try:
        from app.services.system_settings_service import get_effective_value

        return str(await get_effective_value("match_engine") or "vector") == "vector"
    except Exception:
        from app.core.config import get_settings

        return str(get_settings().match_engine or "vector") == "vector"


async def _setting_int(key: str) -> int:
    try:
        from app.services.system_settings_service import get_effective_value

        return int(await get_effective_value(key))
    except Exception:
        from app.core.config import get_settings

        return int(getattr(get_settings(), key))


async def _scorable_user_ids(session, user_ids: list[str]) -> set[str]:
    """Users the free engine can score. Under another engine, everyone.

    A profile the vector engine cannot score fails every queued job and floods
    the page with errors; the profile editor already explains the gap.
    """
    if not user_ids or not await _free_engine_active():
        return set(user_ids)
    from sqlalchemy.orm import undefer

    from app.models.database import UserEncoding
    from app.services.vector_match_service import user_encoding_is_scorable

    encs = (
        await session.execute(
            select(UserEncoding)
            .options(undefer(UserEncoding.skills), undefer(UserEncoding.title_vecs))
            .where(UserEncoding.user_id.in_(user_ids))
        )
    ).scalars().all()
    return {e.user_id for e in encs if user_encoding_is_scorable(e)}


def _missing_match_stmt(user_id: str, limit: int, *extra):
    """Visible, extracted jobs the user has no score for and has not dismissed. Newest first."""
    return (
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
            job_share_visibility_clause(user_id),
            *extra,
        )
        .order_by(func.coalesce(Job.posted_date, Job.created_at).desc())
        .limit(limit)
    )


async def list_auto_prepare_users(
    *,
    match: bool = True,
    full: bool = False,
    user_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return opted-in approved users (id + flags), optionally limited to ``user_ids``."""
    from app.services.signup_approval_service import can_use_app_clause

    async with get_session() as session:
        conds = [can_use_app_clause()]
        if user_ids is not None:
            if not user_ids:
                return []
            conds.append(User.id.in_(user_ids))
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
    *,
    user_ids: list[str] | None = None,
    source: str = "fanout",
) -> dict[str, Any]:
    """After shared JD is ready: enqueue analyze for each opted-in user who can see the job.

    ``user_ids`` limits the fan-out (people a share just reached).
    """
    if not await _auto_prepare_globally_enabled():
        logger.info("auto_prepare_fanout_paused", job_id=job_id)
        return {"job_id": job_id, "enqueued": 0, "skipped": 0, "users": 0, "paused": True}

    users = await list_auto_prepare_users(match=True, full=True, user_ids=user_ids)
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

        candidate_ids = [u["user_id"] for u in users]
        existing = set(
            (
                await session.execute(
                    select(JobMatchResult.user_id).where(
                        JobMatchResult.job_id == job_id,
                        JobMatchResult.user_id.in_(candidate_ids),
                    )
                )
            ).scalars().all()
        )
        dismissed = set(
            (
                await session.execute(
                    select(UserJobStatus.user_id).where(
                        UserJobStatus.job_id == job_id,
                        UserJobStatus.user_id.in_(candidate_ids),
                        UserJobStatus.status != "active",
                    )
                )
            ).scalars().all()
        )
        visible = await users_who_can_see_job(session, job_id, candidate_ids)
        visible &= await _scorable_user_ids(session, sorted(visible))

    hidden = 0
    for idx, user in enumerate(users):
        uid = user["user_id"]
        if uid not in visible:
            hidden += 1
            continue
        if uid in existing or uid in dismissed:
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
            source=source,
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
        not_eligible=hidden,
        source=source,
    )
    return {
        "job_id": job_id,
        "extraction_id": ext_id,
        "users": len(users),
        "enqueued": enqueued,
        "skipped": skipped,
        "not_eligible": hidden,
    }


async def fanout_shared_batch(batch_id: str, user_ids: list[str] | None = None) -> dict[str, Any]:
    """Score a just-shared add session for the people it now reaches (free engine)."""
    from app.services.job_add_batches import batch_job_ids

    async with get_session() as session:
        job_ids = await batch_job_ids(session, batch_id)
    totals = {"batch_id": batch_id, "jobs": len(job_ids), "enqueued": 0}
    for job_id in job_ids:
        try:
            res = await fanout_auto_prepare_for_job(job_id, user_ids=user_ids, source="share")
            totals["enqueued"] += int(res.get("enqueued") or 0)
        except Exception as err:
            logger.warning("auto_prepare_share_fanout_failed", batch_id=batch_id, job_id=job_id, error=str(err))
    logger.info("auto_prepare_share_fanout_complete", **totals)
    return totals


def _visit_throttle_key(user_id: str) -> str:
    return f"auto_score_visit:{user_id}"


async def catch_up_free_scores_on_visit(user_id: str) -> dict[str, Any]:
    """Opening the Jobs page: score visible, unscored jobs with the free engine.

    Throttled per user, honours ``auto_prepare_match`` and the platform pause,
    and only runs under the vector engine so a page view never spends on LLMs
    (tailoring still follows the user's own "prepare documents" choice).
    """
    out: dict[str, Any] = {"user_id": user_id, "enqueued": 0}
    if not await _auto_prepare_globally_enabled() or not await _free_engine_active():
        return {**out, "skipped": "paused_or_paid_engine"}
    limit = max(0, await _setting_int("auto_score_on_visit_limit"))
    if limit == 0:
        return {**out, "skipped": "disabled"}
    cooldown = max(30, await _setting_int("auto_score_on_visit_cooldown_seconds"))
    try:
        from app.core.redis_support import get_broker_redis

        if not await get_broker_redis().set(_visit_throttle_key(user_id), "1", nx=True, ex=cooldown):
            return {**out, "skipped": "throttled"}
    except Exception as err:
        logger.warning("auto_score_visit_throttle_failed", user_id=user_id, error=str(err))
        return {**out, "skipped": "no_redis"}

    async with get_session() as session:
        user = (
            await session.execute(
                select(
                    User.auto_prepare_match,
                    User.auto_prepare_full,
                    User.is_active,
                    User.is_admin,
                    User.country_preferences,
                ).where(User.id == user_id)
            )
        ).one_or_none()
        if user is None or not user.is_active or not user.auto_prepare_match:
            return {**out, "skipped": "opted_out"}
        from app.models.database import JobMatchInProgress

        if user_id not in await _scorable_user_ids(session, [user_id]):
            return {**out, "skipped": "profile_not_scorable"}

        extra = [
            ~select(JobMatchInProgress.job_id)
            .where(JobMatchInProgress.job_id == Job.id, JobMatchInProgress.user_id == user_id)
            .exists()
        ]
        if not user.is_admin:
            from app.services.job_location_classifier import preferred_pool_visibility_clause

            countries = user.country_preferences if isinstance(user.country_preferences, list) else []
            pool = preferred_pool_visibility_clause(user_id, countries)
            if pool is not None:
                extra.append(pool)
        rows = (await session.execute(_missing_match_stmt(user_id, limit, *extra))).all()

    skip_phase_b = not bool(user.auto_prepare_full)
    for idx, (job_id, extraction_id) in enumerate(rows):
        defer_by = timedelta(seconds=min(idx * 0.2, 30.0)) if idx else None
        if await _enqueue_analyze(
            job_id,
            user_id,
            extraction_id=extraction_id,
            skip_phase_b=skip_phase_b,
            source="visit",
            defer_by=defer_by,
        ):
            out["enqueued"] += 1
    if rows:
        logger.info("auto_score_visit_catch_up", user_id=user_id, candidates=len(rows), enqueued=out["enqueued"])
    return out


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
        missing_rows = (await session.execute(_missing_match_stmt(user_id, limit + 1))).all()
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
                    job_share_visibility_clause(user_id),
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
        # The daily budget guards LLM spend; free match-only scoring has none.
        free = skip_phase_b and await _free_engine_active()
        daily_cap = 0 if free else await _daily_cap()

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
        if job is not None and not free:
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
