"""Weekly progress series for the assistant / dashboard home chart.

Per local calendar day (user timezone):
  * posted      — jobs added to the platform (same semantics as dashboard ``today``)
  * recommended — posted that day AND match score >= the user's effective min
                  (Preferences page threshold → dashboard ``suggested`` rule)
  * applied     — jobs the user marked applied that day
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import and_, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import Date

from app.models.database import (
    Job,
    JobMatchResult,
    ResumeBuildResult,
    UserJobStatus,
    ValidJobUserApplication,
)
from app.services.dashboard_stats import (
    BEST_MATCH_SCORE,
    _is_remote_expr,
    _job_added_at_expr,
    _visible_job_clause,
)
from app.storage.user_repository import UserRepository
from app.utils.date_bounds import recent_week_bounds_for_timezone


def _local_date_expr(column, tz_name: str | None):
    tz = (tz_name or "UTC").strip() or "UTC"
    as_utc = func.timezone("UTC", column)
    as_local = func.timezone(tz, as_utc)
    return cast(as_local, Date)


def _rows_to_day_map(rows) -> dict[date, int]:
    out: dict[date, int] = {}
    for row in rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        out[d] = int(row.cnt)
    return out


def _dashboard_from(
    user_id: str,
    *,
    with_match: bool = False,
    with_resume: bool = False,
    with_application: bool = False,
):
    frm = Job.__table__.outerjoin(
        UserJobStatus.__table__,
        and_(UserJobStatus.job_id == Job.id, UserJobStatus.user_id == user_id),
    )
    if with_match:
        frm = frm.outerjoin(
            JobMatchResult.__table__,
            and_(JobMatchResult.job_id == Job.id, JobMatchResult.user_id == user_id),
        )
    if with_resume:
        frm = frm.outerjoin(
            ResumeBuildResult.__table__,
            and_(ResumeBuildResult.job_id == Job.id, ResumeBuildResult.user_id == user_id),
        )
    if with_application:
        frm = frm.outerjoin(
            ValidJobUserApplication.__table__,
            and_(
                ValidJobUserApplication.job_id == Job.id,
                ValidJobUserApplication.user_id == user_id,
            ),
        )
    return frm


def _series_for_days(day_list: list[date], by_day: dict[date, int]) -> list[int]:
    return [by_day.get(d, 0) for d in day_list]


async def fetch_weekly_progress_series(
    session: AsyncSession,
    user_id: str,
    *,
    tz_name: str | None,
    days: int = 7,
) -> dict:
    start_utc, end_utc, day_list = recent_week_bounds_for_timezone(tz_name, days=days)
    min_score = await UserRepository(session).get_effective_min_match_score(user_id)

    visible = _visible_job_clause(user_id)
    added_at = _job_added_at_expr()
    added_day = _local_date_expr(added_at, tz_name)

    posted_rows = (
        await session.execute(
            select(added_day.label("day"), func.count().label("cnt"))
            .select_from(_dashboard_from(user_id))
            .where(
                visible,
                added_at.is_not(None),
                added_at >= start_utc,
                added_at < end_utc,
            )
            .group_by(added_day)
        )
    ).all()
    posted_by_day = _rows_to_day_map(posted_rows)

    # Recommended = added that day and currently qualifies under Preferences min score
    # (same threshold as dashboard ``suggested``).
    recommended_rows = (
        await session.execute(
            select(added_day.label("day"), func.count().label("cnt"))
            .select_from(_dashboard_from(user_id, with_match=True))
            .where(
                visible,
                added_at.is_not(None),
                added_at >= start_utc,
                added_at < end_utc,
                JobMatchResult.overall_score.is_not(None),
                JobMatchResult.overall_score >= min_score,
            )
            .group_by(added_day)
        )
    ).all()
    recommended_by_day = _rows_to_day_map(recommended_rows)

    applied_day = _local_date_expr(ValidJobUserApplication.applied_at, tz_name)
    applied_rows = (
        await session.execute(
            select(applied_day.label("day"), func.count().label("cnt"))
            .where(
                ValidJobUserApplication.user_id == user_id,
                ValidJobUserApplication.applied_at >= start_utc,
                ValidJobUserApplication.applied_at < end_utc,
            )
            .group_by(applied_day)
        )
    ).all()
    applied_by_day = _rows_to_day_map(applied_rows)

    series = [
        {
            "date": d.isoformat(),
            "label": d.strftime("%a") if days <= 7 else d.strftime("%d"),
            "posted": posted_by_day.get(d, 0),
            "recommended": recommended_by_day.get(d, 0),
            "applied": applied_by_day.get(d, 0),
        }
        for d in day_list
    ]
    return {
        "timezone": tz_name or "UTC",
        "days": days,
        "min_match_score": min_score,
        "series": series,
        "totals": {
            "posted": sum(x["posted"] for x in series),
            "recommended": sum(x["recommended"] for x in series),
            "applied": sum(x["applied"] for x in series),
        },
    }


async def fetch_board_trend_series(
    session: AsyncSession,
    user_id: str,
    *,
    tz_name: str | None,
    days: int = 7,
) -> dict:
    """Daily activity series for the four main board side tiles (last *days*).

    * ready     — resumes that became ready (docx completed) that day
    * best      — strong match analyses (score >= 75) completed that day
    * remote    — remote-friendly jobs added that day
    * available — jobs added that day that are still not marked applied
    """
    start_utc, end_utc, day_list = recent_week_bounds_for_timezone(tz_name, days=days)
    visible = _visible_job_clause(user_id)
    added_at = _job_added_at_expr()
    added_day = _local_date_expr(added_at, tz_name)
    is_remote = _is_remote_expr()

    ready_ts = ResumeBuildResult.updated_at
    ready_day = _local_date_expr(ready_ts, tz_name)
    ready_rows = (
        await session.execute(
            select(ready_day.label("day"), func.count().label("cnt"))
            .select_from(_dashboard_from(user_id, with_resume=True))
            .where(
                visible,
                ResumeBuildResult.resume_docx_status == "completed",
                ready_ts.is_not(None),
                ready_ts >= start_utc,
                ready_ts < end_utc,
            )
            .group_by(ready_day)
        )
    ).all()

    match_ts = JobMatchResult.created_at
    match_day = _local_date_expr(match_ts, tz_name)
    best_rows = (
        await session.execute(
            select(match_day.label("day"), func.count().label("cnt"))
            .select_from(_dashboard_from(user_id, with_match=True))
            .where(
                visible,
                JobMatchResult.overall_score >= BEST_MATCH_SCORE,
                match_ts.is_not(None),
                match_ts >= start_utc,
                match_ts < end_utc,
            )
            .group_by(match_day)
        )
    ).all()

    remote_rows = (
        await session.execute(
            select(added_day.label("day"), func.count().label("cnt"))
            .select_from(_dashboard_from(user_id))
            .where(
                visible,
                added_at.is_not(None),
                added_at >= start_utc,
                added_at < end_utc,
                is_remote == True,  # noqa: E712
            )
            .group_by(added_day)
        )
    ).all()

    available_rows = (
        await session.execute(
            select(added_day.label("day"), func.count().label("cnt"))
            .select_from(_dashboard_from(user_id, with_application=True))
            .where(
                visible,
                added_at.is_not(None),
                added_at >= start_utc,
                added_at < end_utc,
                ValidJobUserApplication.id.is_(None),
            )
            .group_by(added_day)
        )
    ).all()

    # Day-of-month numbers for the sparkline X-axis (e.g. 27, 28, …, 2).
    labels = [str(d.day) for d in day_list]
    return {
        "labels": labels,
        "ready": _series_for_days(day_list, _rows_to_day_map(ready_rows)),
        "best": _series_for_days(day_list, _rows_to_day_map(best_rows)),
        "remote": _series_for_days(day_list, _rows_to_day_map(remote_rows)),
        "available": _series_for_days(day_list, _rows_to_day_map(available_rows)),
    }
