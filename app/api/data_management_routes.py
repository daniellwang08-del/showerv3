"""Data Management API: analytics series + period-scoped job operations."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.routes import (
    _get_job_for_rescrape,
    _prepare_job_rescrape_in_session,
    _purge_job_cascade,
    enqueue_extraction,
    require_admin,
)
from app.core.logging import get_logger
from app.models.database import Job, JobMatchInProgress
from app.models.schemas import ExtractionStatus
from app.services.data_management_ops import preview_jobs
from app.services.data_management_stats import (
    fetch_distribution_series,
    fetch_growth_series,
    fetch_pipeline_series,
    fetch_remote_vs_fetched_series,
    fetch_scrape_health_series,
    fetch_team_applied_vs_fetched_series,
)
from app.services.job_exclusion_types import (
    LOCATION_UNKNOWN_EXCLUSION,
    NON_US_LOCATION_EXCLUSION,
)
from app.services.job_location_classifier import LocationVerdict, classify_job_location
from app.storage.database import get_session
from app.storage.repository import (
    JobMatchInProgressRepository,
    JobMatchRepository,
    UserJobStatusRepository,
)
from app.utils.date_bounds import list_recent_months
from sqlalchemy import and_, select, text

logger = get_logger(__name__)

router = APIRouter(prefix="/data-management", tags=["data-management"])

DateField = Literal["created_at", "posted_date", "added_at"]
Visibility = Literal["visible", "hidden", "all"]
WorkModeFilter = Literal["any", "remote", "hybrid", "onsite"]
TriState = Literal["any", "true", "false"]


class DataManagementFilterBody(BaseModel):
    date_field: DateField = "created_at"
    date_from: date
    date_to: date
    timezone: str | None = "UTC"
    visibility: Visibility = "visible"
    work_mode: WorkModeFilter = "any"
    extraction_status: str = "any"
    is_job_posting: TriState = "any"
    source: str | None = None
    min_match_score: int | None = Field(default=None, ge=0, le=100)
    max_match_score: int | None = Field(default=None, ge=0, le=100)
    has_application: TriState = "any"
    confirm: bool = False


def _filters_dict(body: DataManagementFilterBody) -> dict[str, Any]:
    return {
        "date_field": body.date_field,
        "date_from": body.date_from,
        "date_to": body.date_to,
        "timezone": body.timezone,
        "visibility": body.visibility,
        "work_mode": body.work_mode,
        "extraction_status": body.extraction_status,
        "is_job_posting": body.is_job_posting,
        "source": body.source,
        "min_match_score": body.min_match_score,
        "max_match_score": body.max_match_score,
        "has_application": body.has_application,
    }


def _require_user(current_user: dict) -> str:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


@router.get("/months", dependencies=[Depends(require_admin)])
async def get_data_management_months(
    timezone: str | None = Query(default="UTC"),
    n: int = Query(default=12, ge=1, le=36),
):
    try:
        months = list_recent_months(n, timezone)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"timezone": timezone or "UTC", "months": months}


@router.get("/series/applied-vs-fetched", dependencies=[Depends(require_admin)])
@router.get("/series/applied-vs-posted", dependencies=[Depends(require_admin)])
async def get_applied_vs_fetched_series(
    year: int = Query(..., ge=1970, le=2100),
    month: int = Query(..., ge=1, le=12),
    timezone: str | None = Query(default="UTC"),
    current_user: dict = Depends(require_admin),
):
    """Platform-wide team applied vs jobs fetched. Old path kept as alias."""
    _require_user(current_user)
    try:
        async with get_session() as session:
            return await fetch_team_applied_vs_fetched_series(
                session, year=year, month=month, tz_name=timezone
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_applied_series_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load applied series: {e}") from e


@router.get("/series/remote-vs-fetched", dependencies=[Depends(require_admin)])
@router.get("/series/remote-vs-posted", dependencies=[Depends(require_admin)])
async def get_remote_vs_fetched_series(
    year: int = Query(..., ge=1970, le=2100),
    month: int = Query(..., ge=1, le=12),
    timezone: str | None = Query(default="UTC"),
    current_user: dict = Depends(require_admin),
):
    """Platform-wide remote vs fetched. Old path kept as alias."""
    _require_user(current_user)
    try:
        async with get_session() as session:
            return await fetch_remote_vs_fetched_series(
                session, year=year, month=month, tz_name=timezone
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_remote_series_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load remote series: {e}") from e


@router.get("/series/pipeline", dependencies=[Depends(require_admin)])
async def get_pipeline_series(
    year: int = Query(..., ge=1970, le=2100),
    month: int = Query(..., ge=1, le=12),
    timezone: str | None = Query(default="UTC"),
    current_user: dict = Depends(require_admin),
):
    _require_user(current_user)
    try:
        async with get_session() as session:
            return await fetch_pipeline_series(
                session, year=year, month=month, tz_name=timezone
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_pipeline_series_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load pipeline series: {e}") from e


@router.get("/series/distribution", dependencies=[Depends(require_admin)])
async def get_distribution_series(
    year: int = Query(..., ge=1970, le=2100),
    month: int = Query(..., ge=1, le=12),
    timezone: str | None = Query(default="UTC"),
    current_user: dict = Depends(require_admin),
):
    _require_user(current_user)
    try:
        async with get_session() as session:
            return await fetch_distribution_series(
                session, year=year, month=month, tz_name=timezone
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_distribution_series_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load distribution series: {e}") from e


@router.get("/series/growth", dependencies=[Depends(require_admin)])
async def get_growth_series(
    year: int = Query(..., ge=1970, le=2100),
    month: int = Query(..., ge=1, le=12),
    timezone: str | None = Query(default="UTC"),
    current_user: dict = Depends(require_admin),
):
    _require_user(current_user)
    try:
        async with get_session() as session:
            return await fetch_growth_series(
                session, year=year, month=month, tz_name=timezone
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_growth_series_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load growth series: {e}") from e


@router.get("/series/scrape-health", dependencies=[Depends(require_admin)])
async def get_scrape_health_series(
    year: int = Query(..., ge=1970, le=2100),
    month: int = Query(..., ge=1, le=12),
    timezone: str | None = Query(default="UTC"),
    current_user: dict = Depends(require_admin),
):
    _require_user(current_user)
    try:
        async with get_session() as session:
            return await fetch_scrape_health_series(
                session, year=year, month=month, tz_name=timezone
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_scrape_health_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load scrape health: {e}") from e


class UserActivitySeriesRequest(BaseModel):
    year: int = Field(..., ge=1970, le=2100)
    month: int = Field(..., ge=1, le=12)
    timezone: str | None = "UTC"
    # Cap keeps charts readable and queries bounded (one series per user × metric).
    user_ids: list[str] = Field(..., min_length=1, max_length=25)
    metrics: list[str] = Field(
        default_factory=lambda: ["board_added", "applied"],
        min_length=1,
        max_length=8,
    )


class PlatformSeriesRequest(BaseModel):
    year: int = Field(..., ge=1970, le=2100)
    month: int = Field(..., ge=1, le=12)
    timezone: str | None = "UTC"
    platforms: list[str] | None = Field(default=None, max_length=50)


@router.get("/users", dependencies=[Depends(require_admin)])
async def list_analysis_users(current_user: dict = Depends(require_admin)):
    """List active users for the activity multi-select."""
    _require_user(current_user)
    from app.storage.user_repository import UserRepository, user_applied_by_display_name

    async with get_session() as session:
        repo = UserRepository(session)
        users = await repo.list_active_users()
        return {
            "users": [
                {
                    "id": u.id,
                    "email": u.email,
                    "name": user_applied_by_display_name(u),
                }
                for u in users
            ]
        }


@router.get("/platforms", dependencies=[Depends(require_admin)])
async def list_analysis_platforms(current_user: dict = Depends(require_admin)):
    from app.services.data_management_activity import list_known_platforms

    _require_user(current_user)
    async with get_session() as session:
        platforms = await list_known_platforms(session)
    return {"platforms": platforms}


@router.post("/series/user-activity", dependencies=[Depends(require_admin)])
async def post_user_activity_series(
    body: UserActivitySeriesRequest,
    current_user: dict = Depends(require_admin),
):
    _require_user(current_user)
    from app.services.data_management_activity import (
        USER_ACTIVITY_METRICS,
        fetch_user_activity_series,
    )
    from app.storage.user_repository import user_applied_by_display_name

    metrics = [m for m in body.metrics if m in USER_ACTIVITY_METRICS or m == "jobs_added"]
    if not metrics:
        raise HTTPException(
            status_code=400,
            detail="metrics must include one of: board_added, applied",
        )

    try:
        async with get_session() as session:
            # Batch-load selected users instead of N get_by_id round-trips.
            from sqlalchemy import select
            from app.models.database import User

            rows = (
                await session.execute(
                    select(User).where(
                        User.id.in_(body.user_ids),
                        User.is_active.is_(True),
                    )
                )
            ).scalars().all()
            by_id = {u.id: u for u in rows}
            labels: dict[str, str] = {}
            valid_ids: list[str] = []
            for uid in body.user_ids:
                user = by_id.get(uid)
                if not user:
                    continue
                valid_ids.append(user.id)
                labels[user.id] = user_applied_by_display_name(user)
            if not valid_ids:
                raise HTTPException(status_code=400, detail="No valid active users selected.")
            return await fetch_user_activity_series(
                session,
                user_ids=valid_ids,
                metrics=metrics,
                year=body.year,
                month=body.month,
                tz_name=body.timezone,
                user_labels=labels,
            )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_user_activity_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load user activity: {e}") from e


@router.post("/series/platform-vs-applied", dependencies=[Depends(require_admin)])
async def post_platform_vs_applied_series(
    body: PlatformSeriesRequest,
    current_user: dict = Depends(require_admin),
):
    _require_user(current_user)
    from app.services.data_management_activity import fetch_platform_vs_applied_series

    try:
        async with get_session() as session:
            return await fetch_platform_vs_applied_series(
                session,
                year=body.year,
                month=body.month,
                tz_name=body.timezone,
                platforms=body.platforms,
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("data_mgmt_platform_series_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to load platform series: {e}") from e


@router.post("/preview", dependencies=[Depends(require_admin)])
async def preview_data_management(
    body: DataManagementFilterBody,
    current_user: dict = Depends(require_admin),
):
    user_id = _require_user(current_user)
    if body.date_to < body.date_from:
        raise HTTPException(status_code=400, detail="date_to must be on or after date_from")
    try:
        async with get_session() as session:
            result = await preview_jobs(session, user_id, _filters_dict(body))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Do not return full job_ids list to the client for preview — only sample + count.
    return {
        "matched_count": result["matched_count"],
        "capped": result["capped"],
        "limit": result["limit"],
        "date_start_utc": result["date_start_utc"],
        "date_end_utc": result["date_end_utc"],
        "sample": result["sample"],
    }


@router.post("/delete", dependencies=[Depends(require_admin)])
async def delete_data_management_jobs(
    body: DataManagementFilterBody,
    current_user: dict = Depends(require_admin),
):
    user_id = _require_user(current_user)
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true after reviewing the preview.")
    if body.date_to < body.date_from:
        raise HTTPException(status_code=400, detail="date_to must be on or after date_from")

    try:
        async with get_session() as session:
            preview = await preview_jobs(session, user_id, _filters_dict(body))
            job_ids = preview["job_ids"]
            deleted = 0
            failed = 0
            for jid in job_ids:
                try:
                    if await _purge_job_cascade(session, jid):
                        deleted += 1
                    else:
                        failed += 1
                except Exception:
                    failed += 1
            await session.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    logger.info(
        "data_mgmt_delete_complete",
        user_id=user_id,
        matched=preview["matched_count"],
        deleted=deleted,
        failed=failed,
    )
    return {
        "success": True,
        "matched_count": preview["matched_count"],
        "deleted": deleted,
        "failed": failed,
        "capped": preview["capped"],
    }


@router.post("/rescrape", status_code=202, dependencies=[Depends(require_admin)])
async def rescrape_data_management_jobs(
    body: DataManagementFilterBody,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_admin),
):
    user_id = _require_user(current_user)
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true after reviewing the preview.")
    if body.date_to < body.date_from:
        raise HTTPException(status_code=400, detail="date_to must be on or after date_from")

    try:
        async with get_session() as session:
            preview = await preview_jobs(session, user_id, _filters_dict(body))
            job_ids = list(preview["job_ids"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    jobs_out: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    for job_id in job_ids:
        async with get_session() as session:
            job = await _get_job_for_rescrape(session, job_id)
            if not job:
                skipped.append({"id": job_id, "reason": "not_found"})
                continue
            source_url = (job.source_url or "").strip()
            if not source_url:
                skipped.append({"id": job_id, "reason": "no_url"})
                continue
            try:
                # Admin inventory refresh: reset shared extraction only (no personal chain).
                extraction_id = await _prepare_job_rescrape_in_session(
                    session, job, source_url, None
                )
            except ValueError as e:
                skipped.append({"id": job_id, "reason": str(e)[:200]})
                continue
            await session.commit()

        await enqueue_extraction(
            extraction_id,
            source_url,
            user_id=None,
            background_tasks=background_tasks,
        )
        jobs_out.append({"job_id": job_id, "extraction_id": extraction_id})

    logger.info(
        "data_mgmt_rescrape_enqueued",
        user_id=user_id,
        enqueued=len(jobs_out),
        skipped=len(skipped),
    )
    return {
        "status": "queued",
        "matched_count": preview["matched_count"],
        "enqueued": len(jobs_out),
        "jobs": jobs_out,
        "skipped": skipped,
        "capped": preview["capped"],
    }


@router.post("/match-rerun", status_code=202, dependencies=[Depends(require_admin)])
async def match_rerun_data_management_jobs(
    body: DataManagementFilterBody,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_admin),
):
    from app.api.routes import _fallback_match_batch_parallel, try_get_analysis_pool

    user_id = _require_user(current_user)
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true after reviewing the preview.")
    if body.date_to < body.date_from:
        raise HTTPException(status_code=400, detail="date_to must be on or after date_from")

    try:
        async with get_session() as session:
            preview = await preview_jobs(session, user_id, _filters_dict(body))
            job_ids = list(preview["job_ids"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    enqueued_ids: list[str] = []
    skipped: list[dict[str, str]] = []

    for job_id in job_ids:
        async with get_session() as session:
            progress_repo = JobMatchInProgressRepository(session)
            match_repo = JobMatchRepository(session)
            in_prog = await session.execute(
                select(JobMatchInProgress).where(
                    JobMatchInProgress.job_id == job_id,
                    JobMatchInProgress.user_id == user_id,
                )
            )
            if in_prog.scalar_one_or_none():
                skipped.append({"id": job_id, "reason": "already_in_progress"})
                continue

            await match_repo.delete(job_id, user_id)
            await session.execute(
                text(
                    "DELETE FROM resume_build_results "
                    "WHERE job_id = :job_id AND user_id = :uid"
                ),
                {"job_id": job_id, "uid": user_id},
            )

            r = await session.execute(select(Job).where(Job.id == job_id, Job.status == "active"))
            job = r.scalar_one_or_none()
            if not job or not job.extraction_id:
                skipped.append({"id": job_id, "reason": "no_extraction"})
                continue

            from app.storage.repository import JobExtractionRepository

            extraction_repo = JobExtractionRepository(session)
            extraction = await extraction_repo.get_by_id(job.extraction_id)
            from app.services.job_pipeline_mode import extraction_has_shared_jd

            if not extraction_has_shared_jd(extraction):
                skipped.append({"id": job_id, "reason": "extraction_not_ready"})
                continue

            await progress_repo.add(job_id, user_id)
            await session.commit()
            enqueued_ids.append(job_id)

    if not enqueued_ids:
        return {
            "status": "accepted",
            "matched_count": preview["matched_count"],
            "enqueued": 0,
            "enqueued_ids": [],
            "skipped": skipped,
            "capped": preview["capped"],
            "message": "Nothing queued; fix skipped reasons or wait for in-progress jobs.",
        }

    ids_for_in_process = list(enqueued_ids)
    pool = await try_get_analysis_pool()
    if pool:
        from app.core.redis_support import pipeline_job_id
        import uuid

        redis_failed: list[str] = []
        for jid in enqueued_ids:
            try:
                await pool.enqueue_job(
                    "analyze_job_match",
                    jid,
                    user_id,
                    _job_id=pipeline_job_id(
                        "analyze", jid, user_id, uuid.uuid4().hex[:10]
                    ),
                )
            except Exception as e:
                logger.warning("data_mgmt_match_rerun_enqueue_failed", job_id=jid, error=str(e))
                redis_failed.append(jid)
        if not redis_failed:
            return {
                "status": "queued",
                "matched_count": preview["matched_count"],
                "enqueued": len(enqueued_ids),
                "enqueued_ids": enqueued_ids,
                "skipped": skipped,
                "capped": preview["capped"],
            }
        ids_for_in_process = redis_failed

    from app.core.redis_support import allow_in_process_job_fallback

    if allow_in_process_job_fallback() and background_tasks:
        background_tasks.add_task(_fallback_match_batch_parallel, user_id, ids_for_in_process)
        return {
            "status": "queued",
            "matched_count": preview["matched_count"],
            "enqueued": len(enqueued_ids),
            "enqueued_ids": enqueued_ids,
            "skipped": skipped,
            "capped": preview["capped"],
        }

    async with get_session() as session:
        progress_repo = JobMatchInProgressRepository(session)
        for jid in ids_for_in_process:
            await progress_repo.remove(jid, user_id)
    raise HTTPException(status_code=503, detail="Could not queue match analysis")


@router.post("/reconcile-locations", dependencies=[Depends(require_admin)])
async def reconcile_locations_data_management(
    body: DataManagementFilterBody,
    current_user: dict = Depends(require_admin),
):
    """Run location reconcile only on jobs matching the filter (plus restore US exclusions)."""
    from app.api.websocket import publish_ws_event
    from app.services.job_location_reconcile import _restore_us_location_exclusions

    user_id = _require_user(current_user)
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true after reviewing the preview.")
    if body.date_to < body.date_from:
        raise HTTPException(status_code=400, detail="date_to must be on or after date_from")

    try:
        async with get_session() as session:
            preview = await preview_jobs(session, user_id, _filters_dict(body))
            job_ids = set(preview["job_ids"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    restored = await _restore_us_location_exclusions(user_id)
    moved_non_us = 0
    moved_unknown = 0
    scanned = 0

    if job_ids:
        async with get_session() as session:
            from app.models.database import JobExtraction, JobMatchResult, UserJobStatus

            stmt = (
                select(Job, JobExtraction, JobMatchResult.overall_score)
                .outerjoin(
                    UserJobStatus,
                    and_(UserJobStatus.job_id == Job.id, UserJobStatus.user_id == user_id),
                )
                .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
                .outerjoin(
                    JobMatchResult,
                    and_(JobMatchResult.job_id == Job.id, JobMatchResult.user_id == user_id),
                )
                .where(
                    Job.id.in_(list(job_ids)),
                    Job.status != "blocked",
                )
            )
            rows = (await session.execute(stmt)).all()
            ujs_repo = UserJobStatusRepository(session)
            for job, extraction, overall_score in rows:
                scanned += 1
                # Only act on currently visible jobs
                ujs = await session.execute(
                    select(UserJobStatus).where(
                        UserJobStatus.user_id == user_id,
                        UserJobStatus.job_id == job.id,
                    )
                )
                status_row = ujs.scalar_one_or_none()
                if status_row and status_row.status not in (None, "active"):
                    continue

                verdict, detail = classify_job_location(
                    job.location,
                    remote_policy=extraction.remote_policy if extraction else None,
                )
                if verdict == LocationVerdict.US:
                    continue

                if verdict == LocationVerdict.NON_US:
                    exclusion_type = NON_US_LOCATION_EXCLUSION
                    reason = f"Non-US job location ({detail})."
                    moved_non_us += 1
                else:
                    exclusion_type = LOCATION_UNKNOWN_EXCLUSION
                    reason = (
                        f"Job location could not be verified as US ({detail}). "
                        "Review in Duplicates."
                    )
                    moved_unknown += 1

                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=job.id,
                    status="duplicated",
                    exclusion_type=exclusion_type,
                    reason=reason,
                    match_score_at_decision=(
                        float(overall_score) if overall_score is not None else None
                    ),
                )
                await publish_ws_event(
                    {
                        "type": "job_excluded_for_user",
                        "user_id": user_id,
                        "valid_job_id": job.id,
                        "exclusion_type": exclusion_type,
                        "reason": reason,
                    }
                )

    return {
        "success": True,
        "matched_count": preview["matched_count"],
        "scanned": scanned,
        "moved_non_us": moved_non_us,
        "moved_unknown": moved_unknown,
        "restored": restored,
        "capped": preview["capped"],
    }
