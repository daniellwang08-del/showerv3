"""Month-scoped daily analytics for the Data Management page.

"Posted" / overall daily counts mean jobs **added to this platform** for the
user (same semantics as dashboard ``today_scraped`` / the ``today`` view):
``coalesce(UserJobStatus.created_at, Job.created_at)`` — not employer
``Job.posted_date``, and not Google Sheets / Pumble distribution.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import and_, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import Date

from app.models.database import ValidJobUserApplication
from app.services.dashboard_stats import (
    _dashboard_join,
    _is_remote_expr,
    _job_added_at_expr,
    _visible_job_clause,
)
from app.utils.date_bounds import days_in_month, month_bounds_for_timezone


def _local_date_expr(column, tz_name: str | None):
    """Calendar date of a naive-UTC timestamp in the user's timezone."""
    tz = (tz_name or "UTC").strip() or "UTC"
    # Treat stored naive timestamps as UTC, then convert to local wall time.
    as_utc = func.timezone("UTC", column)
    as_local = func.timezone(tz, as_utc)
    return cast(as_local, Date)


async def fetch_applied_vs_posted_series(
    session: AsyncSession,
    user_id: str,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily applied count vs daily jobs added to the platform."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    applied_day = _local_date_expr(ValidJobUserApplication.applied_at, tz_name)

    applied_rows = (
        await session.execute(
            select(
                applied_day.label("day"),
                func.count().label("cnt"),
            )
            .where(
                ValidJobUserApplication.user_id == user_id,
                ValidJobUserApplication.applied_at >= start_utc,
                ValidJobUserApplication.applied_at < end_utc,
            )
            .group_by(applied_day)
        )
    ).all()
    applied_by_day: dict[date, int] = {
        row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day)): int(row.cnt)
        for row in applied_rows
        if row.day is not None
    }

    join = _dashboard_join(user_id)
    visible = _visible_job_clause(user_id)
    # Platform-added timestamp (dashboard "today" / today_scraped semantics).
    added_at = _job_added_at_expr()
    added_day = _local_date_expr(added_at, tz_name)
    added_rows = (
        await session.execute(
            select(
                added_day.label("day"),
                func.count().label("cnt"),
            )
            .select_from(join)
            .where(
                visible,
                added_at.is_not(None),
                added_at >= start_utc,
                added_at < end_utc,
            )
            .group_by(added_day)
        )
    ).all()
    added_by_day: dict[date, int] = {
        row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day)): int(row.cnt)
        for row in added_rows
        if row.day is not None
    }

    days = [
        {
            "date": d.isoformat(),
            "applied_count": applied_by_day.get(d, 0),
            # posted_count = jobs added to Atomspace that day (not employer post date).
            "posted_count": added_by_day.get(d, 0),
        }
        for d in day_list
    ]
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "metric": "platform_added",
        "days": days,
        "totals": {
            "applied_count": sum(x["applied_count"] for x in days),
            "posted_count": sum(x["posted_count"] for x in days),
        },
    }


async def fetch_remote_vs_posted_series(
    session: AsyncSession,
    user_id: str,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily remote jobs added vs all jobs added to the platform."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)

    join = _dashboard_join(user_id)
    visible = _visible_job_clause(user_id)
    added_at = _job_added_at_expr()
    added_day = _local_date_expr(added_at, tz_name)
    is_remote = _is_remote_expr()

    rows = (
        await session.execute(
            select(
                added_day.label("day"),
                func.count().label("posted_cnt"),
                func.count().filter(is_remote == True).label("remote_cnt"),  # noqa: E712
            )
            .select_from(join)
            .where(
                and_(
                    visible,
                    added_at.is_not(None),
                    added_at >= start_utc,
                    added_at < end_utc,
                )
            )
            .group_by(added_day)
        )
    ).all()

    added_by_day: dict[date, int] = {}
    remote_by_day: dict[date, int] = {}
    for row in rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        added_by_day[d] = int(row.posted_cnt)
        remote_by_day[d] = int(row.remote_cnt)

    days = [
        {
            "date": d.isoformat(),
            "remote_count": remote_by_day.get(d, 0),
            "posted_count": added_by_day.get(d, 0),
        }
        for d in day_list
    ]
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "metric": "platform_added",
        "days": days,
        "totals": {
            "remote_count": sum(x["remote_count"] for x in days),
            "posted_count": sum(x["posted_count"] for x in days),
        },
    }
