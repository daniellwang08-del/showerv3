"""Extended analytics: per-user activity and per-platform fetch vs team applied."""

from __future__ import annotations

from datetime import date

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import Job, ValidJobUserApplication
from app.services.dashboard_stats import (
    _admin_system_visible_clause,
    _dashboard_join,
    _job_added_at_expr,
    _job_source_expr,
    _visible_job_clause,
)
from app.services.data_management_stats import local_date_expr
from app.utils.date_bounds import days_in_month, month_bounds_for_timezone

# board_added = jobs that appeared on that user's board (visibility-scoped).
# applied = that user's ValidJobUserApplication rows.
# sheet_posted / pumble_posted are intentionally NOT per-user — those are
# system-wide Job timestamps and live on the Distribution chart instead.
USER_ACTIVITY_METRICS = ("board_added", "applied", "jobs_added")
# jobs_added is a deprecated alias of board_added (same query, honest label).


def _series_key(user_id: str, metric: str) -> str:
    safe = user_id.replace("-", "")[:12]
    return f"{metric}_{safe}"


def _platform_key(source: str) -> str:
    return "src_" + "".join(ch if ch.isalnum() else "_" for ch in source.lower())[:40]


def _normalize_activity_metrics(metrics: list[str]) -> list[str]:
    out: list[str] = []
    for m in metrics:
        if m == "jobs_added":
            m = "board_added"
        if m in ("board_added", "applied") and m not in out:
            out.append(m)
    return out


async def list_known_platforms(session: AsyncSession, user_id: str | None = None) -> list[str]:
    """Distinct platform sources from non-blocked jobs.

    ``user_id`` is accepted for back-compat but ignored — admin Analysis always
    lists system-wide sources so the platform chart matches platform-wide counts.
    """
    del user_id  # platform list is admin-wide
    source_expr = _job_source_expr()
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
    """Daily activity lines for selected users × selected metrics.

    Metrics:
      * board_added — coalesce(UJS.created_at, Job.created_at) for jobs visible
                      to that user (personal board intake, not system fetch)
      * applied     — that user's applications
    """
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    metrics = _normalize_activity_metrics(metrics)
    if not user_ids or not metrics:
        return {
            "year": year,
            "month": month,
            "timezone": tz_name or "UTC",
            "days": [{"date": d.isoformat()} for d in day_list],
            "series": [],
            "totals": {},
        }

    buckets: dict[date, dict[str, int]] = {d: {} for d in day_list}
    series_meta: list[dict] = []

    for uid in user_ids:
        label = user_labels.get(uid) or uid[:8]

        if "board_added" in metrics:
            key = _series_key(uid, "board_added")
            series_meta.append(
                {
                    "key": key,
                    "label": f"{label} · Board added",
                    "user_id": uid,
                    "metric": "board_added",
                }
            )
            join = _dashboard_join(uid)
            visible = _visible_job_clause(uid)
            added_at = _job_added_at_expr()
            added_day = local_date_expr(added_at, tz_name)
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
            applied_day = local_date_expr(ValidJobUserApplication.applied_at, tz_name)
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


async def fetch_platform_vs_applied_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
    platforms: list[str] | None = None,
    viewer_user_id: str | None = None,  # noqa: ARG001 — ignored; always platform-wide
) -> dict:
    """Daily jobs fetched per scrape platform vs all-users applied count.

    Both axes are platform-wide:
      * platform lines — non-blocked Job.created_at by source
      * applied        — ValidJobUserApplication across all users

    No UserJobStatus join — that previously mixed admin-visible subsets with
    all-user applied counts and could double-count when unscoped.
    """
    del viewer_user_id
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)

    known = await list_known_platforms(session)
    if platforms:
        wanted = {p.strip().lower() for p in platforms if p and p.strip()}
        selected = [p for p in known if p.lower() in wanted]
        for p in platforms:
            pl = (p or "").strip()
            if pl and pl not in selected and pl.lower() in wanted:
                selected.append(pl)
    else:
        selected = list(known)

    source_expr = _job_source_expr()
    visible = _admin_system_visible_clause()
    fetched_day = local_date_expr(Job.created_at, tz_name)

    platform_rows = (
        await session.execute(
            select(
                fetched_day.label("day"),
                source_expr.label("source"),
                func.count().label("cnt"),
            )
            .select_from(Job)
            .where(
                and_(
                    visible,
                    Job.created_at.is_not(None),
                    Job.created_at >= start_utc,
                    Job.created_at < end_utc,
                )
            )
            .group_by(fetched_day, source_expr)
        )
    ).all()

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

    applied_day = local_date_expr(ValidJobUserApplication.applied_at, tz_name)
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

