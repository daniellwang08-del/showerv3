"""Aggregate stats for the jobs dashboard (user-scoped, jobs table)."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import and_, bindparam, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import (
    Job,
    JobExtraction,
    JobMatchResult,
    ResumeBuildResult,
    User,
    UserJobStatus,
    ValidJobUserApplication,
)
from app.models.schemas import ExtractionStatus

BEST_MATCH_SCORE = 75
GOOD_MATCH_SCORE = 50


def _visible_job_clause(user_id: str):
    """Same visibility rules as GET /jobs/dashboard."""
    return and_(
        Job.status != "blocked",
        or_(UserJobStatus.status.is_(None), UserJobStatus.status == "active"),
    )


def _dashboard_join(user_id: str):
    return (
        Job.__table__.outerjoin(
            UserJobStatus.__table__,
            and_(UserJobStatus.job_id == Job.id, UserJobStatus.user_id == user_id),
        )
    )


def _job_added_at_expr():
    """When the job entered (or re-entered) the user's dashboard."""
    return func.coalesce(UserJobStatus.created_at, Job.created_at)


def _is_remote_expr():
    """True when the job is remote by the same signals as the dashboard filter/UI.

    Root cause of the board showing 0 remote while the table listed remote jobs:
    stats previously only checked ``raw_metadata.is_remote``, while the list filter
    and Work Mode badge also honour ``Job.work_mode`` and location text
    (e.g. "Remote, US").
    """
    return case(
        (
            or_(
                Job.work_mode == "remote",
                Job.raw_metadata["is_remote"].as_boolean() == True,  # noqa: E712
                Job.location.ilike("%remote%"),
            ),
            True,
        ),
        else_=False,
    )


def _job_source_expr():
    return func.coalesce(
        Job.raw_metadata["source"].as_string(),
        Job.raw_metadata["scraped_source"].as_string(),
        case((Job.raw_metadata["submitted_data"].isnot(None), "manual"), else_="unknown"),
    )


async def fetch_dashboard_stats(
    session: AsyncSession,
    user_id: str,
    *,
    day_start: datetime,
    day_end: datetime,
    min_match_score: int = GOOD_MATCH_SCORE,
) -> dict:
    join = _dashboard_join(user_id)
    visible = _visible_job_clause(user_id)
    added_at = _job_added_at_expr()
    is_remote = _is_remote_expr()
    qualified_min = max(0, int(min_match_score or 0))

    ext_join = join.outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
    rb_join = ext_join.outerjoin(
        ResumeBuildResult,
        and_(
            ResumeBuildResult.job_id == Job.id,
            ResumeBuildResult.user_id == user_id,
        ),
    )
    match_join = rb_join.outerjoin(
        JobMatchResult,
        and_(
            JobMatchResult.job_id == Job.id,
            JobMatchResult.user_id == user_id,
        ),
    )
    app_join = match_join.outerjoin(
        ValidJobUserApplication,
        and_(
            ValidJobUserApplication.job_id == Job.id,
            ValidJobUserApplication.user_id == user_id,
        ),
    )

    stats_row = (
        await session.execute(
            select(
                func.count().label("total_jobs"),
                func.count().filter(is_remote == True).label("total_remote"),  # noqa: E712
                func.count().filter(
                    and_(added_at >= day_start, added_at < day_end)
                ).label("today_added"),
                func.count().filter(
                    and_(added_at >= day_start, added_at < day_end, is_remote == True)  # noqa: E712
                ).label("today_remote"),
                func.count().filter(
                    and_(
                        Job.posted_date.is_not(None),
                        Job.posted_date >= day_start,
                        Job.posted_date < day_end,
                    )
                ).label("today_posted"),
                func.count().filter(
                    and_(
                        UserJobStatus.status == "active",
                        Job.raw_metadata["submitted_data"].isnot(None),
                    )
                ).label("my_jobs"),
                func.count().filter(
                    JobExtraction.status == ExtractionStatus.COMPLETED
                ).label("extracted_jobs"),
                func.count().filter(
                    and_(
                        ResumeBuildResult.resume_docx_status == "completed",
                        ValidJobUserApplication.id.is_(None),
                    )
                ).label("ready_jobs"),
                func.count().filter(
                    JobMatchResult.overall_score >= BEST_MATCH_SCORE
                ).label("best_jobs"),
                func.count().filter(
                    and_(
                        JobMatchResult.overall_score >= GOOD_MATCH_SCORE,
                        JobMatchResult.overall_score < BEST_MATCH_SCORE,
                    )
                ).label("good_jobs"),
                func.count().filter(
                    JobMatchResult.overall_score >= qualified_min
                ).label("qualified_jobs"),
                func.count().filter(
                    JobMatchResult.overall_score.is_not(None)
                ).label("scored_jobs"),
                func.coalesce(func.avg(JobMatchResult.overall_score), 0).label("avg_match_score"),
                func.count().filter(
                    ValidJobUserApplication.id.is_(None)
                ).label("available_jobs"),
                func.count().filter(
                    ValidJobUserApplication.id.is_not(None)
                ).label("applied_jobs"),
                func.count().filter(
                    and_(
                        ValidJobUserApplication.applied_at.is_not(None),
                        ValidJobUserApplication.applied_at >= day_start,
                        ValidJobUserApplication.applied_at < day_end,
                    )
                ).label("applied_today"),
                func.count().filter(
                    Job.sheet_posted_at.is_not(None)
                ).label("sheet_posted_jobs"),
                func.count().filter(
                    Job.pumble_posted_at.is_not(None)
                ).label("pumble_posted_jobs"),
            )
            .select_from(app_join)
            .where(visible)
        )
    ).one()

    source_expr = _job_source_expr()
    source_rows = (
        await session.execute(
            select(
                source_expr.label("source"),
                func.count().label("cnt"),
                func.max(added_at).label("latest_added"),
            )
            .select_from(join)
            .where(visible)
            .group_by(source_expr)
            .order_by(func.count().desc())
        )
    ).all()

    sources = [
        {
            "source": row.source or "unknown",
            "count": row.cnt,
            "latest_scraped": row.latest_added,
        }
        for row in source_rows
    ]

    runs_result = await session.execute(
        text(
            "SELECT id, spider_name, started_at, finished_at, items_scraped, "
            "items_new, items_updated, errors, status "
            "FROM scrape_runs ORDER BY started_at DESC LIMIT 10"
        )
    )
    recent_runs = [dict(row._mapping) for row in runs_result]

    return {
        "total_jobs": stats_row.total_jobs or 0,
        "total_remote": stats_row.total_remote or 0,
        "today_scraped": stats_row.today_added or 0,
        "today_remote": stats_row.today_remote or 0,
        "today_posted": stats_row.today_posted or 0,
        "my_jobs": stats_row.my_jobs or 0,
        "extracted_jobs": stats_row.extracted_jobs or 0,
        "ready_jobs": stats_row.ready_jobs or 0,
        "best_jobs": stats_row.best_jobs or 0,
        "good_jobs": stats_row.good_jobs or 0,
        "qualified_jobs": stats_row.qualified_jobs or 0,
        "scored_jobs": stats_row.scored_jobs or 0,
        "avg_match_score": int(round(float(stats_row.avg_match_score or 0))),
        "available_jobs": stats_row.available_jobs or 0,
        "applied_jobs": stats_row.applied_jobs or 0,
        "applied_today": stats_row.applied_today or 0,
        "sheet_posted_jobs": stats_row.sheet_posted_jobs or 0,
        "pumble_posted_jobs": stats_row.pumble_posted_jobs or 0,
        "sources": sources,
        "recent_runs": recent_runs,
    }


def _admin_system_visible_clause():
    """System-wide pool for admin ops metrics (not per-user match/resume)."""
    return Job.status != "blocked"


def _admin_needs_extraction_expr():
    """Jobs without a completed JD extraction (excludes hard failures)."""
    return or_(
        Job.extraction_id.is_(None),
        JobExtraction.status.is_(None),
        JobExtraction.status.in_(
            (
                ExtractionStatus.PENDING,
                ExtractionStatus.PROCESSING,
                ExtractionStatus.EXTRACTED,
            )
        ),
    )


async def fetch_admin_dashboard_stats(
    session: AsyncSession,
    *,
    day_start: datetime,
    day_end: datetime,
) -> dict:
    """Platform-wide fetch → extract → post funnel for the admin Jobs board."""
    visible = _admin_system_visible_clause()
    is_remote = _is_remote_expr()
    added_at = Job.created_at
    needs_ext = _admin_needs_extraction_expr()

    frm = Job.__table__.outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)

    stats_row = (
        await session.execute(
            select(
                func.count().label("total_jobs"),
                func.count().filter(is_remote == True).label("total_remote"),  # noqa: E712
                func.count().filter(
                    and_(added_at >= day_start, added_at < day_end)
                ).label("today_fetched"),
                func.count().filter(
                    and_(added_at >= day_start, added_at < day_end, is_remote == True)  # noqa: E712
                ).label("today_remote"),
                func.count().filter(
                    and_(
                        Job.posted_date.is_not(None),
                        Job.posted_date >= day_start,
                        Job.posted_date < day_end,
                    )
                ).label("today_posted"),
                func.count().filter(
                    JobExtraction.status == ExtractionStatus.COMPLETED
                ).label("extracted_jobs"),
                func.count().filter(needs_ext).label("needs_extraction_jobs"),
                func.count().filter(
                    JobExtraction.status == ExtractionStatus.FAILED
                ).label("extraction_failed_jobs"),
                func.count().filter(
                    JobExtraction.status.in_(
                        (ExtractionStatus.PENDING, ExtractionStatus.PROCESSING)
                    )
                ).label("extraction_pending_jobs"),
                func.count().filter(
                    Job.sheet_posted_at.is_not(None)
                ).label("sheet_posted_jobs"),
                func.count().filter(
                    Job.pumble_posted_at.is_not(None)
                ).label("pumble_posted_jobs"),
                func.count().filter(
                    Job.raw_metadata["submitted_data"].isnot(None)
                ).label("manual_jobs"),
            )
            .select_from(frm)
            .where(visible)
        )
    ).one()

    team_applied_today = (
        await session.execute(
            select(func.count())
            .select_from(ValidJobUserApplication)
            .where(
                ValidJobUserApplication.applied_at.is_not(None),
                ValidJobUserApplication.applied_at >= day_start,
                ValidJobUserApplication.applied_at < day_end,
            )
        )
    ).scalar() or 0

    source_expr = _job_source_expr()
    source_rows = (
        await session.execute(
            select(
                source_expr.label("source"),
                func.count().label("cnt"),
                func.max(added_at).label("latest_added"),
            )
            .select_from(Job)
            .where(visible)
            .group_by(source_expr)
            .order_by(func.count().desc())
        )
    ).all()

    sources = [
        {
            "source": row.source or "unknown",
            "count": row.cnt,
            "latest_scraped": row.latest_added,
        }
        for row in source_rows
    ]

    runs_result = await session.execute(
        text(
            "SELECT id, spider_name, started_at, finished_at, items_scraped, "
            "items_new, items_updated, errors, status "
            "FROM scrape_runs ORDER BY started_at DESC LIMIT 10"
        )
    )
    recent_runs = [dict(row._mapping) for row in runs_result]

    last_sync_new = 0
    last_sync_errors = 0
    last_sync_scraped = 0
    last_sync_at = None
    last_sync_spider = None
    if recent_runs:
        last = recent_runs[0]
        last_sync_new = int(last.get("items_new") or 0)
        last_sync_errors = int(last.get("errors") or 0)
        last_sync_scraped = int(last.get("items_scraped") or 0)
        last_sync_at = last.get("finished_at") or last.get("started_at")
        last_sync_spider = last.get("spider_name")

    # Active sources = configured sync platforms (schedule), not distinct job
    # metadata strings. ``spider_names is None`` means all platforms.
    from app.services.job_sync_schedule_service import get_schedule
    from app.services.scraper_sync_service import list_sync_platforms
    from app.scraper.runner import SPIDER_META

    schedule = await get_schedule(session)
    spider_names = schedule.get("spider_names")
    all_platforms = list_sync_platforms()
    if isinstance(spider_names, list) and spider_names:
        platform_names = [n for n in spider_names if n in SPIDER_META]
    else:
        platform_names = [p["name"] for p in all_platforms]
    active_sources = len(platform_names)

    source_count_map: dict[str, int] = {}
    for row in source_rows:
        key = (row.source or "unknown").strip().lower()
        source_count_map[key] = int(row.cnt or 0)

    latest_by_spider: dict[str, dict] = {}
    if platform_names:
        # Latest scrape_runs row per registered spider (Postgres DISTINCT ON).
        latest_runs = await session.execute(
            text(
                "SELECT DISTINCT ON (spider_name) "
                "spider_name, started_at, finished_at, items_scraped, "
                "items_new, items_updated, errors, status "
                "FROM scrape_runs "
                "WHERE spider_name IN :names "
                "ORDER BY spider_name, started_at DESC"
            ).bindparams(bindparam("names", expanding=True)),
            {"names": list(platform_names)},
        )
        for row in latest_runs:
            mapping = dict(row._mapping)
            latest_by_spider[str(mapping.get("spider_name") or "")] = mapping

    platform_sync: list[dict] = []
    for name in platform_names:
        meta = SPIDER_META.get(name) or {}
        label = str(meta.get("label") or name)
        run = latest_by_spider.get(name) or {}
        platform_sync.append(
            {
                "name": name,
                "label": label,
                "job_count": int(source_count_map.get(name, 0)),
                "last_sync_at": run.get("finished_at") or run.get("started_at"),
                "last_items_new": int(run.get("items_new") or 0),
                "last_items_scraped": int(run.get("items_scraped") or 0),
                "last_items_updated": int(run.get("items_updated") or 0),
                "last_errors": int(run.get("errors") or 0),
                "last_status": run.get("status"),
            }
        )

    week_start = day_end - timedelta(days=7)
    user_row = (
        await session.execute(
            select(
                func.count().label("total_users"),
                func.count()
                .filter(User.created_at >= week_start)
                .label("new_users_week"),
            ).select_from(User)
        )
    ).one()

    return {
        "total_jobs": stats_row.total_jobs or 0,
        "total_remote": stats_row.total_remote or 0,
        "today_fetched": stats_row.today_fetched or 0,
        "today_scraped": stats_row.today_fetched or 0,
        "today_remote": stats_row.today_remote or 0,
        "today_posted": stats_row.today_posted or 0,
        "extracted_jobs": stats_row.extracted_jobs or 0,
        "needs_extraction_jobs": stats_row.needs_extraction_jobs or 0,
        "extraction_failed_jobs": stats_row.extraction_failed_jobs or 0,
        "extraction_pending_jobs": stats_row.extraction_pending_jobs or 0,
        "sheet_posted_jobs": stats_row.sheet_posted_jobs or 0,
        "pumble_posted_jobs": stats_row.pumble_posted_jobs or 0,
        "manual_jobs": stats_row.manual_jobs or 0,
        "team_applied_today": int(team_applied_today),
        "last_sync_items_new": last_sync_new,
        "last_sync_items_scraped": last_sync_scraped,
        "last_sync_errors": last_sync_errors,
        "last_sync_at": last_sync_at,
        "last_sync_spider": last_sync_spider,
        "active_sources": active_sources,
        "total_users": int(user_row.total_users or 0),
        "new_users_week": int(user_row.new_users_week or 0),
        "platform_sync": platform_sync,
        "sources": sources,
        "recent_runs": recent_runs,
    }
