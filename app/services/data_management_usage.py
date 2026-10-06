"""Admin AI usage analytics: tokens and estimated cost per user, feature and day.

Everything reads ``llm_usage_events``. A tailoring *run* is one request or
worker run (``run_id``) that made ``resume_tailoring`` calls for a job; the
resume and cover letter calls of the same run count once. Runs above the
number of distinct jobs are reruns: the same job tailored again.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from sqlalchemy import and_, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import LlmUsageEvent, User, ValidJobUserApplication
from app.services.data_management_stats import local_date_expr
from app.services.llm_usage import TAILORING_FEATURE
from app.storage.user_repository import user_applied_by_display_name
from app.utils.date_bounds import days_in_month, month_bounds_for_timezone

UsageMeasure = Literal["cost", "tokens"]
SYSTEM_USER_KEY = "system"


def _day(value) -> date | None:
    if value is None:
        return None
    return value if isinstance(value, date) else date.fromisoformat(str(value))


def _safe_key(raw: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in raw.lower())[:40]


def _in_month(start_utc, end_utc):
    return and_(LlmUsageEvent.created_at >= start_utc, LlmUsageEvent.created_at < end_utc)


def _run_key():
    return func.coalesce(LlmUsageEvent.run_id, LlmUsageEvent.id)


def _tailoring_clause():
    return and_(LlmUsageEvent.feature == TAILORING_FEATURE, LlmUsageEvent.job_id.is_not(None))


async def _user_labels(session: AsyncSession, user_ids: list[str]) -> dict[str, dict]:
    if not user_ids:
        return {}
    rows = (await session.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
    return {
        u.id: {
            "name": user_applied_by_display_name(u),
            "email": u.email,
            "approval_status": u.approval_status,
            "is_active": bool(u.is_active),
        }
        for u in rows
    }


def _empty_days(day_list: list[date]) -> dict[date, dict[str, float]]:
    return {d: {} for d in day_list}


def _days_out(buckets: dict[date, dict[str, float]], keys: list[str], *, money: bool) -> tuple[list[dict], dict]:
    totals = {k: 0.0 if money else 0 for k in keys}
    out = []
    for d in sorted(buckets):
        row: dict = {"date": d.isoformat()}
        for k in keys:
            v = buckets[d].get(k, 0)
            v = round(float(v), 4) if money else int(v)
            row[k] = v
            totals[k] += v
        out.append(row)
    if money:
        totals = {k: round(v, 4) for k, v in totals.items()}
    return out, totals


async def fetch_ai_usage_overview(
    session: AsyncSession, *, year: int, month: int, tz_name: str | None
) -> dict:
    """Month totals, a per-user table (spend, tailoring reruns, applications) and daily spend by feature."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    in_month = _in_month(start_utc, end_utc)
    E = LlmUsageEvent

    t = (
        await session.execute(
            select(
                func.count(),
                func.coalesce(func.sum(E.prompt_tokens), 0),
                func.coalesce(func.sum(E.completion_tokens), 0),
                func.coalesce(func.sum(E.reasoning_tokens), 0),
                func.coalesce(func.sum(E.total_tokens), 0),
                func.coalesce(func.sum(E.cost_usd), 0.0),
                func.count(distinct(E.user_id)),
                func.count().filter(E.cost_usd.is_(None)),
            ).where(in_month)
        )
    ).one()
    totals = {
        "calls": int(t[0]),
        "prompt_tokens": int(t[1]),
        "completion_tokens": int(t[2]),
        "reasoning_tokens": int(t[3]),
        "total_tokens": int(t[4]),
        "cost_usd": round(float(t[5]), 4),
        "users": int(t[6]),
        "unpriced_calls": int(t[7]),
    }

    per_user_rows = (
        await session.execute(
            select(
                E.user_id,
                func.count().label("calls"),
                func.coalesce(func.sum(E.prompt_tokens), 0).label("prompt"),
                func.coalesce(func.sum(E.completion_tokens), 0).label("completion"),
                func.coalesce(func.sum(E.total_tokens), 0).label("total"),
                func.coalesce(func.sum(E.cost_usd), 0.0).label("cost"),
                func.max(E.created_at).label("last_used"),
            )
            .where(in_month)
            .group_by(E.user_id)
        )
    ).all()

    feature_rows = (
        await session.execute(
            select(
                E.user_id,
                E.feature,
                func.coalesce(func.sum(E.total_tokens), 0).label("total"),
                func.coalesce(func.sum(E.cost_usd), 0.0).label("cost"),
            )
            .where(in_month)
            .group_by(E.user_id, E.feature)
        )
    ).all()

    runs_per_job = (
        select(
            E.user_id.label("user_id"),
            E.job_id.label("job_id"),
            func.count(distinct(_run_key())).label("runs"),
        )
        .where(in_month, _tailoring_clause())
        .group_by(E.user_id, E.job_id)
        .subquery()
    )
    tailor_rows = (
        await session.execute(
            select(
                runs_per_job.c.user_id,
                func.coalesce(func.sum(runs_per_job.c.runs), 0).label("runs"),
                func.count().label("jobs"),
                func.coalesce(func.max(runs_per_job.c.runs), 0).label("max_runs"),
            ).group_by(runs_per_job.c.user_id)
        )
    ).all()

    applied_rows = (
        await session.execute(
            select(ValidJobUserApplication.user_id, func.count())
            .where(
                ValidJobUserApplication.applied_at >= start_utc,
                ValidJobUserApplication.applied_at < end_utc,
            )
            .group_by(ValidJobUserApplication.user_id)
        )
    ).all()
    applied = {r[0]: int(r[1]) for r in applied_rows}
    tailoring = {r.user_id: r for r in tailor_rows}

    features_by_user: dict[str | None, list[dict]] = {}
    feature_totals: dict[str, dict] = {}
    for r in feature_rows:
        features_by_user.setdefault(r.user_id, []).append(
            {"feature": r.feature, "total_tokens": int(r.total), "cost_usd": round(float(r.cost), 4)}
        )
        ft = feature_totals.setdefault(r.feature, {"feature": r.feature, "total_tokens": 0, "cost_usd": 0.0})
        ft["total_tokens"] += int(r.total)
        ft["cost_usd"] += float(r.cost)

    labels = await _user_labels(session, [r.user_id for r in per_user_rows if r.user_id])
    users = []
    for r in per_user_rows:
        info = labels.get(r.user_id) if r.user_id else None
        tr = tailoring.get(r.user_id)
        runs = int(tr.runs) if tr else 0
        jobs = int(tr.jobs) if tr else 0
        n_applied = applied.get(r.user_id, 0) if r.user_id else 0
        cost = round(float(r.cost), 4)
        users.append(
            {
                "user_id": r.user_id or SYSTEM_USER_KEY,
                "name": info["name"] if info else ("System" if not r.user_id else r.user_id[:8]),
                "email": info["email"] if info else None,
                "approval_status": info["approval_status"] if info else None,
                "calls": int(r.calls),
                "prompt_tokens": int(r.prompt),
                "completion_tokens": int(r.completion),
                "total_tokens": int(r.total),
                "cost_usd": cost,
                "last_used_at": r.last_used.isoformat() if r.last_used else None,
                "tailor_runs": runs,
                "tailored_jobs": jobs,
                "reruns": max(0, runs - jobs),
                "max_runs_per_job": int(tr.max_runs) if tr else 0,
                "applied": n_applied,
                "cost_per_application": round(cost / n_applied, 4) if n_applied else None,
                "features": sorted(features_by_user.get(r.user_id, []), key=lambda f: -f["cost_usd"]),
            }
        )
    users.sort(key=lambda u: (-u["cost_usd"], -u["total_tokens"]))

    by_feature = sorted(
        ({**f, "cost_usd": round(f["cost_usd"], 4)} for f in feature_totals.values()),
        key=lambda f: -f["cost_usd"],
    )

    day_expr = local_date_expr(E.created_at, tz_name)
    daily = (
        await session.execute(
            select(day_expr.label("day"), E.feature, func.coalesce(func.sum(E.cost_usd), 0.0).label("cost"))
            .where(in_month)
            .group_by(day_expr, E.feature)
        )
    ).all()
    buckets = _empty_days(day_list)
    series = [{"key": f"feat_{_safe_key(f['feature'])}", "label": f["feature"], "feature": f["feature"]} for f in by_feature]
    key_of = {s["feature"]: s["key"] for s in series}
    for r in daily:
        d = _day(r.day)
        if d in buckets:
            k = key_of[r.feature]
            buckets[d][k] = buckets[d].get(k, 0.0) + float(r.cost)
    days_out, _ = _days_out(buckets, [s["key"] for s in series], money=True)

    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "totals": totals,
        "users": users,
        "by_feature": by_feature,
        "days": days_out,
        "series": series,
    }


async def fetch_ai_usage_user_series(
    session: AsyncSession,
    *,
    user_ids: list[str],
    measure: UsageMeasure,
    year: int,
    month: int,
    tz_name: str | None,
    user_labels: dict[str, str],
) -> dict:
    """Daily spend (or tokens) per selected user."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    E = LlmUsageEvent
    money = measure == "cost"
    value = func.coalesce(func.sum(E.cost_usd if money else E.total_tokens), 0)
    day_expr = local_date_expr(E.created_at, tz_name)
    rows = (
        await session.execute(
            select(E.user_id, day_expr.label("day"), value.label("v"))
            .where(_in_month(start_utc, end_utc), E.user_id.in_(user_ids))
            .group_by(E.user_id, day_expr)
        )
    ).all()
    series = [
        {"key": f"usage_{uid.replace('-', '')[:12]}", "label": user_labels.get(uid, uid[:8]), "user_id": uid}
        for uid in user_ids
    ]
    key_of = {s["user_id"]: s["key"] for s in series}
    buckets = _empty_days(day_list)
    for r in rows:
        d = _day(r.day)
        if d in buckets and r.user_id in key_of:
            buckets[d][key_of[r.user_id]] = float(r.v)
    days_out, totals = _days_out(buckets, [s["key"] for s in series], money=money)
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "measure": measure,
        "days": days_out,
        "series": series,
        "totals": totals,
    }


async def fetch_tailoring_runs_series(
    session: AsyncSession,
    *,
    user_ids: list[str],
    year: int,
    month: int,
    tz_name: str | None,
    user_labels: dict[str, str],
) -> dict:
    """Per user and day: tailoring runs and the distinct jobs they covered."""
    start_utc, end_utc = month_bounds_for_timezone(year, month, tz_name)
    day_list = days_in_month(year, month)
    E = LlmUsageEvent
    day_expr = local_date_expr(E.created_at, tz_name)
    rows = (
        await session.execute(
            select(
                E.user_id,
                day_expr.label("day"),
                func.count(distinct(_run_key())).label("runs"),
                func.count(distinct(E.job_id)).label("jobs"),
            )
            .where(_in_month(start_utc, end_utc), _tailoring_clause(), E.user_id.in_(user_ids))
            .group_by(E.user_id, day_expr)
        )
    ).all()
    series: list[dict] = []
    keys: dict[tuple[str, str], str] = {}
    for uid in user_ids:
        safe = uid.replace("-", "")[:12]
        label = user_labels.get(uid, uid[:8])
        for metric, suffix in (("runs", "runs"), ("jobs", "unique jobs")):
            key = f"tailor_{metric}_{safe}"
            keys[(uid, metric)] = key
            series.append({"key": key, "label": f"{label} · {suffix}", "user_id": uid, "metric": metric})
    buckets = _empty_days(day_list)
    for r in rows:
        d = _day(r.day)
        if d not in buckets:
            continue
        buckets[d][keys[(r.user_id, "runs")]] = int(r.runs)
        buckets[d][keys[(r.user_id, "jobs")]] = int(r.jobs)
    days_out, totals = _days_out(buckets, [s["key"] for s in series], money=False)
    return {
        "year": year,
        "month": month,
        "timezone": tz_name or "UTC",
        "days": days_out,
        "series": series,
        "totals": totals,
    }
