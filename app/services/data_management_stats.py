"""Month-scoped daily analytics for the admin Data Analysis page.

Vocabulary (platform-wide unless noted):
  * fetched, Job.created_at into the system (non-blocked)
  * employer_posted, Job.posted_date (employer post date; optional)
  * team_applied, ValidJobUserApplication across all users
  * remote, fetched jobs matching the shared remote expression
  * jd_ready, JobExtraction reached EXTRACTED or COMPLETED that day
                      (coalesce(completed_at, updated_at))
  * extraction_failed, JobExtraction status FAILED that day (updated_at;
                      failures do not set completed_at)
  * sheet/pumble, Job.sheet_posted_at / Job.pumble_posted_at (system-wide)
  * board_added, per-user coalesce(UJS.created_at, Job.created_at) for
                      that user's visible set (user-activity only)
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import and_, cast, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.types import Date

from app.models.database import Job, JobExtraction, User, ValidJobUserApplication
from app.models.schemas import ExtractionStatus
from app.services.dashboard_stats import (
    _admin_needs_extraction_expr,
    _admin_system_visible_clause,
    _is_remote_expr,
)
from app.utils.date_bounds import days_in_month, month_bounds_for_timezone


def local_date_expr(column, tz_name: str | None):
    """Calendar date of a naive-UTC timestamp in the viewer's timezone."""
    tz = (tz_name or "UTC").strip() or "UTC"
    as_utc = func.timezone("UTC", column)
    as_local = func.timezone(tz, as_utc)
    return cast(as_local, Date)


# Back-compat alias used by older imports / weekly_progress-style callers.
_local_date_expr = local_date_expr


def rows_to_day_map(rows) -> dict[date, int]:
    out: dict[date, int] = {}
    for row in rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        out[d] = int(row.cnt or 0)
    return out


def fill_month(
    day_list: list[date],
    maps: dict[str, dict[date, int]],
) -> tuple[list[dict], dict[str, int]]:
    days: list[dict] = []
    totals = {k: 0 for k in maps}
    for d in day_list:
        row: dict = {"date": d.isoformat()}
        for key, by_day in maps.items():
            val = int(by_day.get(d, 0))
            row[key] = val
            totals[key] += val
        days.append(row)
    return days, totals


async def fetch_team_applied_vs_fetched_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily team applications vs platform-wide jobs fetched."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    visible = _admin_system_visible_clause()

    applied_day = local_date_expr(ValidJobUserApplication.applied_at, tz_name)
    applied_rows = (
        await session.execute(
            select(applied_day.label("day"), func.count().label("cnt"))
            .where(
                ValidJobUserApplication.applied_at.is_not(None),
                ValidJobUserApplication.applied_at >= start_utc,
                ValidJobUserApplication.applied_at < end_utc,
            )
            .group_by(applied_day)
        )
    ).all()

    fetched_day = local_date_expr(Job.created_at, tz_name)
    fetched_rows = (
        await session.execute(
            select(fetched_day.label("day"), func.count().label("cnt"))
            .select_from(Job)
            .where(
                visible,
                Job.created_at.is_not(None),
                Job.created_at >= start_utc,
                Job.created_at < end_utc,
            )
            .group_by(fetched_day)
        )
    ).all()

    days, totals = fill_month(
        day_list,
        {
            "applied_count": rows_to_day_map(applied_rows),
            "fetched_count": rows_to_day_map(fetched_rows),
        },
    )
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "metric": "platform_fetched",
        "days": days,
        "totals": totals,
    }


# Legacy name kept so any external import still resolves; behaviour is platform-wide.
async def fetch_applied_vs_posted_series(
    session: AsyncSession,
    user_id: str | None = None,  # noqa: ARG001, ignored; admin platform scope
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    result = await fetch_team_applied_vs_fetched_series(
        session, year=year, month=month, tz_name=tz_name
    )
    # Temporary aliases so any stale client reading posted_count still works.
    for day in result["days"]:
        day["posted_count"] = day["fetched_count"]
    result["totals"]["posted_count"] = result["totals"]["fetched_count"]
    return result


async def fetch_remote_vs_fetched_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily remote jobs fetched vs all jobs fetched (platform-wide)."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    visible = _admin_system_visible_clause()
    fetched_day = local_date_expr(Job.created_at, tz_name)
    is_remote = _is_remote_expr()

    rows = (
        await session.execute(
            select(
                fetched_day.label("day"),
                func.count().label("fetched_cnt"),
                func.count().filter(is_remote == True).label("remote_cnt"),  # noqa: E712
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
            .group_by(fetched_day)
        )
    ).all()

    fetched_by: dict[date, int] = {}
    remote_by: dict[date, int] = {}
    for row in rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        fetched_by[d] = int(row.fetched_cnt or 0)
        remote_by[d] = int(row.remote_cnt or 0)

    days, totals = fill_month(
        day_list,
        {"remote_count": remote_by, "fetched_count": fetched_by},
    )
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "metric": "platform_fetched",
        "days": days,
        "totals": totals,
    }


async def fetch_remote_vs_posted_series(
    session: AsyncSession,
    user_id: str | None = None,  # noqa: ARG001
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    result = await fetch_remote_vs_fetched_series(
        session, year=year, month=month, tz_name=tz_name
    )
    for day in result["days"]:
        day["posted_count"] = day["fetched_count"]
    result["totals"]["posted_count"] = result["totals"]["fetched_count"]
    return result


async def fetch_pipeline_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily intake + extraction outcomes (platform-wide).

    * fetched_count, jobs created that day
    * jd_ready_count, extractions that reached EXTRACTED or COMPLETED that day
    * extraction_failed_count, extractions marked FAILED that day (updated_at)
    * backlog_now, point-in-time unfinished JD pool (not a daily event)
    """
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    visible = _admin_system_visible_clause()
    needs_ext = _admin_needs_extraction_expr()

    fetched_day = local_date_expr(Job.created_at, tz_name)
    fetched_rows = (
        await session.execute(
            select(fetched_day.label("day"), func.count().label("cnt"))
            .select_from(Job)
            .where(
                visible,
                Job.created_at.is_not(None),
                Job.created_at >= start_utc,
                Job.created_at < end_utc,
            )
            .group_by(fetched_day)
        )
    ).all()

    # Same completion timestamp rule as fetch_admin_board_trend_series.
    ready_ts = func.coalesce(JobExtraction.completed_at, JobExtraction.updated_at)
    ready_day = local_date_expr(ready_ts, tz_name)
    job_ext = Job.__table__.outerjoin(
        JobExtraction.__table__,
        Job.extraction_id == JobExtraction.id,
    )
    ready_rows = (
        await session.execute(
            select(ready_day.label("day"), func.count().label("cnt"))
            .select_from(job_ext)
            .where(
                visible,
                JobExtraction.status.in_(
                    (ExtractionStatus.EXTRACTED, ExtractionStatus.COMPLETED)
                ),
                ready_ts.is_not(None),
                ready_ts >= start_utc,
                ready_ts < end_utc,
            )
            .group_by(ready_day)
        )
    ).all()

    # Failures never set completed_at (see JobExtractionRepository.update_status).
    failed_ts = JobExtraction.updated_at
    failed_day = local_date_expr(failed_ts, tz_name)
    failed_rows = (
        await session.execute(
            select(failed_day.label("day"), func.count().label("cnt"))
            .select_from(job_ext)
            .where(
                visible,
                JobExtraction.status == ExtractionStatus.FAILED,
                failed_ts.is_not(None),
                failed_ts >= start_utc,
                failed_ts < end_utc,
            )
            .group_by(failed_day)
        )
    ).all()

    backlog_now = (
        await session.execute(
            select(func.count())
            .select_from(job_ext)
            .where(visible, needs_ext)
        )
    ).scalar() or 0

    days, totals = fill_month(
        day_list,
        {
            "fetched_count": rows_to_day_map(fetched_rows),
            "jd_ready_count": rows_to_day_map(ready_rows),
            "extraction_failed_count": rows_to_day_map(failed_rows),
        },
    )
    series = [
        {"key": "fetched_count", "label": "Fetched", "kind": "fetched"},
        {"key": "jd_ready_count", "label": "JD ready", "kind": "jd_ready"},
        {
            "key": "extraction_failed_count",
            "label": "Extraction failed",
            "kind": "extraction_failed",
        },
    ]
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "days": days,
        "series": series,
        "totals": {
            **totals,
            "backlog_now": int(backlog_now),
        },
    }


async def fetch_distribution_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily system-wide Sheet / Pumble posts (not per-user)."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    visible = _admin_system_visible_clause()

    sheet_day = local_date_expr(Job.sheet_posted_at, tz_name)
    sheet_rows = (
        await session.execute(
            select(sheet_day.label("day"), func.count().label("cnt"))
            .select_from(Job)
            .where(
                visible,
                Job.sheet_posted_at.is_not(None),
                Job.sheet_posted_at >= start_utc,
                Job.sheet_posted_at < end_utc,
            )
            .group_by(sheet_day)
        )
    ).all()

    pumble_day = local_date_expr(Job.pumble_posted_at, tz_name)
    pumble_rows = (
        await session.execute(
            select(pumble_day.label("day"), func.count().label("cnt"))
            .select_from(Job)
            .where(
                visible,
                Job.pumble_posted_at.is_not(None),
                Job.pumble_posted_at >= start_utc,
                Job.pumble_posted_at < end_utc,
            )
            .group_by(pumble_day)
        )
    ).all()

    days, totals = fill_month(
        day_list,
        {
            "sheet_posted_count": rows_to_day_map(sheet_rows),
            "pumble_posted_count": rows_to_day_map(pumble_rows),
        },
    )
    series = [
        {"key": "sheet_posted_count", "label": "Sheet posted", "kind": "sheet"},
        {"key": "pumble_posted_count", "label": "Pumble posted", "kind": "pumble"},
    ]
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "days": days,
        "series": series,
        "totals": totals,
    }


async def fetch_growth_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily new user signups and team applications."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)

    user_day = local_date_expr(User.created_at, tz_name)
    user_rows = (
        await session.execute(
            select(user_day.label("day"), func.count().label("cnt"))
            .select_from(User)
            .where(
                User.created_at.is_not(None),
                User.created_at >= start_utc,
                User.created_at < end_utc,
            )
            .group_by(user_day)
        )
    ).all()

    applied_day = local_date_expr(ValidJobUserApplication.applied_at, tz_name)
    applied_rows = (
        await session.execute(
            select(applied_day.label("day"), func.count().label("cnt"))
            .where(
                ValidJobUserApplication.applied_at.is_not(None),
                ValidJobUserApplication.applied_at >= start_utc,
                ValidJobUserApplication.applied_at < end_utc,
            )
            .group_by(applied_day)
        )
    ).all()

    days, totals = fill_month(
        day_list,
        {
            "new_users_count": rows_to_day_map(user_rows),
            "team_applied_count": rows_to_day_map(applied_rows),
        },
    )
    series = [
        {"key": "new_users_count", "label": "New users", "kind": "users"},
        {"key": "team_applied_count", "label": "Team applied", "kind": "applied"},
    ]
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "days": days,
        "series": series,
        "totals": totals,
    }


async def fetch_scrape_health_series(
    session: AsyncSession,
    *,
    year: int,
    month: int,
    tz_name: str | None,
) -> dict:
    """Daily scrape_runs aggregates: items_new and errors.

    Buckets by coalesce(finished_at, started_at) in the viewer timezone, the
    same wall-clock conversion used for Job timestamps. Uses raw SQL against
    scrape_runs (owned by the sync scraper ORM) to avoid mixing ORM bases.
    """
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    tz = (tz_name or "UTC").strip() or "UTC"

    # Mirror local_date_expr: treat naive columns as UTC, then convert to local.
    rows = (
        await session.execute(
            text(
                """
                SELECT
                  CAST(
                    (timezone(:tz, timezone('UTC', coalesce(finished_at, started_at))))
                    AS date
                  ) AS day,
                  COALESCE(SUM(items_new), 0) AS items_new,
                  COALESCE(SUM(errors), 0) AS errors,
                  COUNT(*) AS runs
                FROM scrape_runs
                WHERE coalesce(finished_at, started_at) IS NOT NULL
                  AND coalesce(finished_at, started_at) >= :start_utc
                  AND coalesce(finished_at, started_at) < :end_utc
                GROUP BY 1
                ORDER BY 1
                """
            ),
            {"tz": tz, "start_utc": start_utc, "end_utc": end_utc},
        )
    ).all()

    new_by: dict[date, int] = {}
    err_by: dict[date, int] = {}
    runs_by: dict[date, int] = {}
    for row in rows:
        if row.day is None:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        new_by[d] = int(row.items_new or 0)
        err_by[d] = int(row.errors or 0)
        runs_by[d] = int(row.runs or 0)

    # Per-spider items_new for the multi-line chart (top spiders by volume).
    spider_rows = (
        await session.execute(
            text(
                """
                SELECT
                  CAST(
                    (timezone(:tz, timezone('UTC', coalesce(finished_at, started_at))))
                    AS date
                  ) AS day,
                  spider_name,
                  COALESCE(SUM(items_new), 0) AS items_new
                FROM scrape_runs
                WHERE coalesce(finished_at, started_at) IS NOT NULL
                  AND coalesce(finished_at, started_at) >= :start_utc
                  AND coalesce(finished_at, started_at) < :end_utc
                GROUP BY 1, 2
                """
            ),
            {"tz": tz, "start_utc": start_utc, "end_utc": end_utc},
        )
    ).all()

    spider_totals: dict[str, int] = {}
    spider_day: dict[date, dict[str, int]] = {d: {} for d in day_list}
    for row in spider_rows:
        if row.day is None or not row.spider_name:
            continue
        d = row.day if isinstance(row.day, date) else date.fromisoformat(str(row.day))
        if d not in spider_day:
            continue
        name = str(row.spider_name)
        cnt = int(row.items_new or 0)
        spider_day[d][name] = spider_day[d].get(name, 0) + cnt
        spider_totals[name] = spider_totals.get(name, 0) + cnt

    # Cap spider lines so the chart stays readable; keep the busiest ones.
    top_spiders = [
        name
        for name, _ in sorted(spider_totals.items(), key=lambda kv: kv[1], reverse=True)[:12]
    ]
    series_meta = [
        {"key": "items_new", "label": "Items new (all spiders)", "kind": "aggregate"},
        {"key": "errors", "label": "Scrape errors", "kind": "aggregate"},
    ]
    for name in top_spiders:
        key = "spider_" + "".join(ch if ch.isalnum() else "_" for ch in name.lower())[:40]
        series_meta.append(
            {"key": key, "label": f"{name} · new", "kind": "spider", "platform": name}
        )

    days_out: list[dict] = []
    totals: dict[str, int] = {s["key"]: 0 for s in series_meta}
    totals["runs"] = 0
    for d in day_list:
        row: dict = {
            "date": d.isoformat(),
            "items_new": int(new_by.get(d, 0)),
            "errors": int(err_by.get(d, 0)),
            "runs": int(runs_by.get(d, 0)),
        }
        totals["items_new"] += row["items_new"]
        totals["errors"] += row["errors"]
        totals["runs"] += row["runs"]
        for name in top_spiders:
            key = "spider_" + "".join(ch if ch.isalnum() else "_" for ch in name.lower())[:40]
            val = int(spider_day[d].get(name, 0))
            row[key] = val
            totals[key] = totals.get(key, 0) + val
        days_out.append(row)

    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "days": days_out,
        "series": series_meta,
        "totals": totals,
        "spiders": top_spiders,
    }
