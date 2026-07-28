"""Extended analytics series: per-user activity and per-platform scrape vs applied."""

from __future__ import annotations

from datetime import date
from typing import Iterable

from sqlalchemy import and_, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import Date

from app.models.database import Job, UserJobStatus, ValidJobUserApplication
from app.services.dashboard_stats import (
    _dashboard_join,
    _is_remote_expr,
    _job_added_at_expr,
    _job_source_expr,
    _visible_job_clause,
)
from app.utils.date_bounds import days_in_month, month_bounds_for_timezone

USER_ACTIVITY_METRICS = ("jobs_added", "applied", "sheet_posted", "pumble_posted")


def _local_date_expr(column, tz_name: str | None):
    tz = (tz_name or "UTC").strip() or "UTC"
    as_utc = func.timezone("UTC", column)
    as_local = func.timezone(tz, as_utc)
    return cast(as_local, Date)


def _series_key(user_id: str, metric: str) -> str:
    # Recharts-friendly key (no colons).
    safe = user_id.replace("-", "")[:12]
    return f"{metric}_{safe}"


async def fetch_user_activity_series(
    session: AsyncSession,
    *,
    user_ids: list[str],
    metrics: list[str],
    year: int,
    month: int,
    tz_name: str | None,
    user_labels: dict[str, str],
) -> dict:
    """Daily activity lines for selected users × selected metrics."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    metrics = [m for m in metrics if m in USER_ACTIVITY_METRICS]
    if not user_ids or not metrics:
        return {
            "year": year,
            "month": month,
            "timezone": tz_name or "UTC",
            "days": [{"date": d.isoformat()} for d in day_list],
            "series": [],
            "totals": {},
        }

    # day -> key -> count
    buckets: dict[date, dict[str, int]] = {d: {} for d in day_list}
    series_meta: list[dict] = []

    for uid in user_ids:
        label = user_labels.get(uid) or uid[:8]

        if "jobs_added" in metrics:
            key = _series_key(uid, "jobs_added")
            series_meta.append(
                {
                    "key": key,
                    "label": f"{label} · Jobs added",
                    "user_id": uid,
                    "metric": "jobs_added",
                }
            )
            join = _dashboard_join(uid)
            visible = _visible_job_clause(uid)
            added_at = _job_added_at_expr()
            added_day = _local_date_expr(added_at, tz_name)
            rows = (
                await session.execute(
                    select(added_day.label("day"), func.count().label("cnt"))
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
            for row in rows:
                if row.day is None:
                    continue
                d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
                if d in buckets:
                    buckets[d][key] = int(row.cnt)

        if "applied" in metrics:
            key = _series_key(uid, "applied")
            series_meta.append(
                {
                    "key": key,
                    "label": f"{label} · Applied",
                    "user_id": uid,
                    "metric": "applied",
                }
            )
            applied_day = _local_date_expr(ValidJobUserApplication.applied_at, tz_name)
            rows = (
                await session.execute(
                    select(applied_day.label("day"), func.count().label("cnt"))
                    .where(
                        ValidJobUserApplication.user_id == uid,
                        ValidJobUserApplication.applied_at >= start_utc,
                        ValidJobUserApplication.applied_at < end_utc,
                    )
                    .group_by(applied_day)
                )
            ).all()
            for row in rows:
                if row.day is None:
                    continue
                d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
                if d in buckets:
                    buckets[d][key] = int(row.cnt)

        if "sheet_posted" in metrics:
            key = _series_key(uid, "sheet_posted")
            series_meta.append(
                {
                    "key": key,
                    "label": f"{label} · Sheet posted",
                    "user_id": uid,
                    "metric": "sheet_posted",
                }
            )
            join = _dashboard_join(uid)
            visible = _visible_job_clause(uid)
            posted_at = Job.sheet_posted_at
            posted_day = _local_date_expr(posted_at, tz_name)
            rows = (
                await session.execute(
                    select(posted_day.label("day"), func.count().label("cnt"))
                    .select_from(join)
                    .where(
                        visible,
                        posted_at.is_not(None),
                        posted_at >= start_utc,
                        posted_at < end_utc,
                    )
                    .group_by(posted_day)
                )
            ).all()
            for row in rows:
                if row.day is None:
                    continue
                d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
                if d in buckets:
                    buckets[d][key] = int(row.cnt)

        if "pumble_posted" in metrics:
            key = _series_key(uid, "pumble_posted")
            series_meta.append(
                {
                    "key": key,
                    "label": f"{label} · Pumble posted",
                    "user_id": uid,
                    "metric": "pumble_posted",
                }
            )
            join = _dashboard_join(uid)
            visible = _visible_job_clause(uid)
            posted_at = Job.pumble_posted_at
            posted_day = _local_date_expr(posted_at, tz_name)
            rows = (
                await session.execute(
                    select(posted_day.label("day"), func.count().label("cnt"))
                    .select_from(join)
                    .where(
                        visible,
                        posted_at.is_not(None),
                        posted_at >= start_utc,
                        posted_at < end_utc,
                    )
                    .group_by(posted_day)
                )
            ).all()
            for row in rows:
                if row.day is None:
                    continue
                d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
                if d in buckets:
                    buckets[d][key] = int(row.cnt)

    keys = [s["key"] for s in series_meta]
    days_out = []
    totals = {k: 0 for k in keys}
    for d in day_list:
        row: dict = {"date": d.isoformat()}
        for k in keys:
            val = int(buckets[d].get(k, 0))
            row[k] = val
            totals[k] += val
        days_out.append(row)

    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "days": days_out,
        "series": series_meta,
        "totals": totals,
    }


def _platform_key(source: str) -> str:
    return "src_" + "".join(ch if ch.isalnum() else "_" for ch in source.lower())[:40]


async def list_known_platforms(session: AsyncSession, user_id: str | None = None) -> list[str]:
    """Distinct platform sources from jobs (optionally scoped to a user's visible set)."""
    source_expr = _job_source_expr()
    if user_id:
        join = _dashboard_join(user_id)
        visible = _visible_job_clause(user_id)
        rows = (
            await session.execute(
                select(source_expr.label("source"))
                .select_from(join)
                .where(visible)
                .group_by(source_expr)
                .order_by(func.count().desc())
            )
        ).all()
    else:
        rows = (
            await session.execute(
                select(source_expr.label("source"))
                .select_from(Job)
                .where(Job.status != "blocked")
                .group_by(source_expr)
                .order_by(func.count().desc())
            )
        ).all()
    platforms = []
    for row in rows:
        src = (row.source or "unknown").strip() or "unknown"
        if src not in platforms:
            platforms.append(src)
    return platforms


async def fetch_platform_vs_applied_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
    platforms: list[str] | None = None,
    viewer_user_id: str | None = None,
) -> dict:
    """Daily jobs added per scrape platform vs all-users applied count.

    Platform counts use jobs visible to *viewer_user_id* when provided (same
    visibility as the dashboard); otherwise all non-blocked jobs.
    Applied counts are across all users (platform-wide activity).
    """
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)

    known = await list_known_platforms(session, viewer_user_id)
    if platforms:
        wanted = {p.strip().lower() for p in platforms if p and p.strip()}
        selected = [p for p in known if p.lower() in wanted]
        # Include explicitly requested platforms even if currently empty.
        for p in platforms:
            pl = (p or "").strip()
            if pl and pl not in selected and pl.lower() in wanted:
                selected.append(pl)
    else:
        selected = list(known)

    source_expr = _job_source_expr()
    added_at = _job_added_at_expr() if viewer_user_id else Job.created_at
    added_day = _local_date_expr(added_at, tz_name)

    if viewer_user_id:
        join = _dashboard_join(viewer_user_id)
        visible = _visible_job_clause(viewer_user_id)
        from_clause = join
        where_clause = and_(
            visible,
            added_at.is_not(None),
            added_at >= start_utc,
            added_at < end_utc,
        )
    else:
        from_clause = Job.__table__.outerjoin(
            UserJobStatus.__table__,
            UserJobStatus.job_id == Job.id,
        )
        where_clause = and_(
            Job.status != "blocked",
            Job.created_at >= start_utc,
            Job.created_at < end_utc,
        )
        added_at = Job.created_at
        added_day = _local_date_expr(Job.created_at, tz_name)

    platform_rows = (
        await session.execute(
            select(
                added_day.label("day"),
                source_expr.label("source"),
                func.count().label("cnt"),
            )
            .select_from(from_clause)
            .where(where_clause)
            .group_by(added_day, source_expr)
        )
    ).all()

    # day -> platform_key -> count
    buckets: dict[date, dict[str, int]] = {d: {} for d in day_list}
    series_meta: list[dict] = []
    key_by_platform: dict[str, str] = {}
    for p in selected:
        key = _platform_key(p)
        key_by_platform[p.lower()] = key
        series_meta.append({"key": key, "label": p, "platform": p, "kind": "platform"})

    for row in platform_rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        if d not in buckets:
            continue
        src = (row.source or "unknown").strip() or "unknown"
        if selected and src.lower() not in {p.lower() for p in selected}:
            continue
        key = key_by_platform.get(src.lower()) or _platform_key(src)
        if key not in {s["key"] for s in series_meta}:
            series_meta.append({"key": key, "label": src, "platform": src, "kind": "platform"})
            key_by_platform[src.lower()] = key
        buckets[d][key] = buckets[d].get(key, 0) + int(row.cnt)

    # Applied across all users
    applied_day = _local_date_expr(ValidJobUserApplication.applied_at, tz_name)
    applied_rows = (
        await session.execute(
            select(applied_day.label("day"), func.count().label("cnt"))
            .where(
                ValidJobUserApplication.applied_at >= start_utc,
                ValidJobUserApplication.applied_at < end_utc,
            )
            .group_by(applied_day)
        )
    ).all()
    applied_key = "applied_all"
    series_meta.append(
        {"key": applied_key, "label": "Applied (all users)", "platform": None, "kind": "applied"}
    )
    for row in applied_rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        if d in buckets:
            buckets[d][applied_key] = int(row.cnt)

    keys = [s["key"] for s in series_meta]
    days_out = []
    totals = {k: 0 for k in keys}
    for d in day_list:
        row: dict = {"date": d.isoformat()}
        for k in keys:
            val = int(buckets[d].get(k, 0))
            row[k] = val
            totals[k] += val
        days_out.append(row)

    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "platforms": selected,
        "days": days_out,
        "series": series_meta,
        "totals": totals,
    }


# Keep remote helper import used by other modules' expectations.
_ = (_is_remote_expr, or_, Iterable)
