"""Filter + mutate helpers for the Data Management page."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import (
    Job,
    JobExtraction,
    JobMatchResult,
    UserJobStatus,
    ValidJobUserApplication,
)
from app.models.schemas import ExtractionStatus
from app.services.dashboard_stats import (
    _is_remote_expr,
    _job_added_at_expr,
    _job_source_expr,
)
from app.utils.date_bounds import date_range_bounds_for_timezone

DateField = Literal["created_at", "posted_date", "added_at"]
Visibility = Literal["visible", "hidden", "all"]
WorkModeFilter = Literal["any", "remote", "hybrid", "onsite"]
TriState = Literal["any", "true", "false"]

MAX_MATCH_LIMIT = 5000
SAMPLE_LIMIT = 25


def _parse_bool_tristate(value: TriState | bool | None) -> bool | None:
    if value is None or value == "any":
        return None
    if value is True or value == "true":
        return True
    if value is False or value == "false":
        return False
    return None


def _date_column(date_field: DateField):
    if date_field == "posted_date":
        return Job.posted_date
    if date_field == "added_at":
        return _job_added_at_expr()
    return Job.created_at


def build_management_filter_query(
    user_id: str,
    *,
    date_field: DateField,
    date_from: date,
    date_to: date,
    timezone: str | None,
    visibility: Visibility = "visible",
    work_mode: WorkModeFilter = "any",
    extraction_status: str = "any",
    is_job_posting: TriState | bool | None = "any",
    source: str | None = None,
    min_match_score: int | None = None,
    max_match_score: int | None = None,
    has_application: TriState | bool | None = "any",
):
    """Return (select of Job.id + display cols, start_utc, end_utc)."""
    start_utc, end_utc = date_range_bounds_for_timezone(date_from, date_to, timezone)

    join = (
        Job.__table__.outerjoin(
            UserJobStatus.__table__,
            and_(UserJobStatus.job_id == Job.id, UserJobStatus.user_id == user_id),
        )
        .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
        .outerjoin(
            JobMatchResult,
            and_(JobMatchResult.job_id == Job.id, JobMatchResult.user_id == user_id),
        )
        .outerjoin(
            ValidJobUserApplication,
            and_(
                ValidJobUserApplication.job_id == Job.id,
                ValidJobUserApplication.user_id == user_id,
            ),
        )
    )

    conditions: list[Any] = [Job.status != "blocked"]

    if visibility == "visible":
        conditions.append(
            or_(UserJobStatus.status.is_(None), UserJobStatus.status == "active")
        )
    elif visibility == "hidden":
        conditions.append(UserJobStatus.status.in_(("duplicated", "manual_hidden")))
    # visibility == "all": no extra UJS filter

    date_col = _date_column(date_field)
    conditions.append(date_col.is_not(None))
    conditions.append(date_col >= start_utc)
    conditions.append(date_col < end_utc)

    if work_mode == "remote":
        conditions.append(_is_remote_expr() == True)  # noqa: E712
    elif work_mode == "hybrid":
        conditions.append(
            or_(
                Job.work_mode.ilike("hybrid"),
                JobExtraction.work_mode.ilike("hybrid"),
            )
        )
    elif work_mode == "onsite":
        conditions.append(
            and_(
                _is_remote_expr() == False,  # noqa: E712
                or_(
                    Job.work_mode.ilike("onsite"),
                    Job.work_mode.ilike("on-site"),
                    Job.work_mode.ilike("office"),
                    JobExtraction.work_mode.ilike("onsite"),
                    JobExtraction.work_mode.ilike("on-site"),
                    and_(Job.work_mode.is_(None), JobExtraction.work_mode.is_(None)),
                ),
            )
        )

    if extraction_status and extraction_status != "any":
        try:
            status_enum = ExtractionStatus(extraction_status)
        except ValueError as e:
            raise ValueError(f"Invalid extraction_status: {extraction_status}") from e
        conditions.append(JobExtraction.status == status_enum)

    posting_flag = _parse_bool_tristate(is_job_posting)
    if posting_flag is True:
        conditions.append(JobExtraction.is_job_posting.is_(True))
    elif posting_flag is False:
        conditions.append(
            or_(
                JobExtraction.is_job_posting.is_(False),
                JobExtraction.is_job_posting.is_(None),
            )
        )

    if source and source.strip():
        src = source.strip().lower()
        conditions.append(func.lower(_job_source_expr()) == src)

    if min_match_score is not None:
        conditions.append(JobMatchResult.overall_score >= int(min_match_score))
    if max_match_score is not None:
        conditions.append(JobMatchResult.overall_score <= int(max_match_score))

    app_flag = _parse_bool_tristate(has_application)
    if app_flag is True:
        conditions.append(ValidJobUserApplication.id.is_not(None))
    elif app_flag is False:
        conditions.append(ValidJobUserApplication.id.is_(None))

    stmt = (
        select(
            Job.id.label("job_id"),
            Job.title.label("title"),
            Job.company.label("company"),
            Job.source_url.label("source_url"),
            Job.created_at.label("created_at"),
            Job.posted_date.label("posted_date"),
            JobExtraction.status.label("extraction_status"),
            JobMatchResult.overall_score.label("match_score"),
        )
        .select_from(join)
        .where(and_(*conditions))
        .order_by(Job.created_at.desc())
        .limit(MAX_MATCH_LIMIT)
    )
    return stmt, start_utc, end_utc


async def preview_jobs(
    session: AsyncSession,
    user_id: str,
    filters: dict[str, Any],
) -> dict:
    stmt, start_utc, end_utc = build_management_filter_query(user_id, **filters)
    rows = (await session.execute(stmt)).all()
    sample = []
    for row in rows[:SAMPLE_LIMIT]:
        sample.append(
            {
                "job_id": row.job_id,
                "title": row.title,
                "company": row.company,
                "source_url": row.source_url,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "posted_date": row.posted_date.isoformat() if row.posted_date else None,
                "extraction_status": (
                    row.extraction_status.value
                    if hasattr(row.extraction_status, "value")
                    else row.extraction_status
                ),
                "match_score": row.match_score,
            }
        )
    return {
        "matched_count": len(rows),
        "capped": len(rows) >= MAX_MATCH_LIMIT,
        "limit": MAX_MATCH_LIMIT,
        "date_start_utc": start_utc.isoformat(),
        "date_end_utc": end_utc.isoformat(),
        "job_ids": [row.job_id for row in rows],
        "sample": sample,
    }


# Public surface for the data-management API layer.
__all__ = [
    "MAX_MATCH_LIMIT",
    "SAMPLE_LIMIT",
    "build_management_filter_query",
    "preview_jobs",
]
