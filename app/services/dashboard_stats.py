"""Aggregate stats for the jobs dashboard (user-scoped, jobs table)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import Job, JobExtraction, ResumeBuildResult, UserJobStatus
from app.models.schemas import ExtractionStatus


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
        "unknown",
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

    total_jobs = (
        await session.execute(
            select(func.count())
            .select_from(join)
            .where(visible)
        )
    ).scalar() or 0

    total_remote = (
        await session.execute(
            select(func.count())
            .select_from(join)
            .where(visible, _is_remote_expr() == True)  # noqa: E712
        )
    ).scalar() or 0

    today_added = (
        await session.execute(
            select(func.count())
            .select_from(join)
            .where(
                visible,
                added_at >= day_start,
                added_at < day_end,
            )
        )
    ).scalar() or 0

    today_remote = (
        await session.execute(
            select(func.count())
            .select_from(join)
            .where(
                visible,
                added_at >= day_start,
                added_at < day_end,
                _is_remote_expr() == True,  # noqa: E712
            )
        )
    ).scalar() or 0

    today_posted = (
        await session.execute(
            select(func.count())
            .select_from(join)
            .where(
                visible,
                Job.posted_date.is_not(None),
                Job.posted_date >= day_start,
                Job.posted_date < day_end,
            )
        )
    ).scalar() or 0

    extracted_jobs = (
        await session.execute(
            select(func.count())
            .select_from(
                join.outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            )
            .where(visible, JobExtraction.status == ExtractionStatus.COMPLETED)
        )
    ).scalar() or 0

    ready_jobs = (
        await session.execute(
            select(func.count())
            .select_from(
                join.outerjoin(
                    ResumeBuildResult,
                    and_(
                        ResumeBuildResult.job_id == Job.id,
                        ResumeBuildResult.user_id == user_id,
                    ),
                )
            )
            .where(
                visible,
                ResumeBuildResult.resume_docx_status == "completed",
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
        "total_jobs": total_jobs,
        "total_remote": total_remote,
        "today_scraped": today_added,
        "today_remote": today_remote,
        "today_posted": today_posted,
        "extracted_jobs": extracted_jobs,
        "ready_jobs": ready_jobs,
        "sources": sources,
        "recent_runs": recent_runs,
    }
