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

from app.models.database import Job, JobMatchResult, UserJobStatus, ValidJobUserApplication
from app.services.dashboard_stats import _job_added_at_expr, _visible_job_clause
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


def _dashboard_from(user_id: str, *, with_match: bool = False):
    frm = Job.__table__.outerjoin(
        UserJobStatus.__table__,
        and_(UserJobStatus.job_id == Job.id, UserJobStatus.user_id == user_id),
    )
    if with_match:
        frm = frm.outerjoin(
            JobMatchResult.__table__,
            and_(JobMatchResult.job_id == Job.id, JobMatchResult.user_id == user_id),
        )
    return frm


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
