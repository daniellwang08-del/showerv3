"""Aggregate stats for the jobs dashboard (user-scoped, jobs table)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import (
    Job,
    JobExtraction,
    JobMatchResult,
    ResumeBuildResult,
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
    return case(
        (Job.raw_metadata["is_remote"].as_boolean() == True, True),  # noqa: E712
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
) -> dict:
    join = _dashboard_join(user_id)
    visible = _visible_job_clause(user_id)
    added_at = _job_added_at_expr()
    is_remote = _is_remote_expr()

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
                    ResumeBuildResult.resume_docx_status == "completed"
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
