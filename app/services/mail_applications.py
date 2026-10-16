"""Applications from the inbox: confirmation emails stored, matched to jobs and charted.

An application confirmation ("Thanks for applying to Acme") is the source of
truth for "applied" once a mailbox is connected, because people also apply
outside NAO. Each confirmation is stored once per message and:

* marks jobs in the user's pool with the same company and role as applied
  ("Email confirmation"), and
* feeds the applied-company dedup rule for companies with no job in NAO.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import Job, MailApplication, MailConnection, UserJobStatus, ValidJobUserApplication
from app.services import interview_extraction as extraction

logger = get_logger(__name__)

EMAIL_APPLIED_LABEL = "Email confirmation"
# Two confirmations for the same company and role this close together are one application.
SAME_APPLICATION_WINDOW = timedelta(days=3)
LINK_LOOKBACK = timedelta(days=120)

_ROLE_NOISE = frozenset(
    {"remote", "hybrid", "onsite", "on", "site", "contract", "full", "part", "time", "fulltime",
     "parttime", "us", "usa", "the", "a", "an", "of", "and", "for", "to", "in", "at", "m", "f", "d", "x"}
)


def _utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


# ── Matching ────────────────────────────────────────────────────────────────


def role_tokens(title: str | None) -> frozenset[str]:
    value = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", (title or "").lower())
    value = value.replace("&", " and ")
    words = re.findall(r"[a-z0-9+#]+", value)
    return frozenset(w for w in words if w not in _ROLE_NOISE and not w.isdigit())


def roles_match(a: str | None, b: str | None) -> bool:
    """Same role, ignoring work mode, location notes and requisition numbers.

    Seniority words count: "Senior Engineer" and "Engineer" are different roles.
    """
    ta, tb = role_tokens(a), role_tokens(b)
    if not ta or not tb:
        return False
    if ta == tb:
        return True
    return len(ta & tb) / len(ta | tb) >= 0.8


def job_company_keys(job: Job) -> set[str]:
    meta = job.raw_metadata if isinstance(job.raw_metadata, dict) else {}
    keys = {extraction.company_key(job.company), extraction.company_key(meta.get("scraped_company_name"))}
    return {k for k in keys if k}


def _first_token(key: str) -> str:
    return key.split(" ")[0] if key else ""


# ── Mail links ──────────────────────────────────────────────────────────────


def email_url(conn: MailConnection | None, message_id: str | None, thread_id: str | None = None) -> str | None:
    """Link that opens this message in the user's own mailbox, or None when unknown."""
    if conn is None or not message_id:
        return None
    provider = (conn.provider or "").lower()
    account = quote(conn.email or "", safe="@.")
    if provider == "google":
        # Gmail web opens the conversation and scrolls to this message.
        return f"https://mail.google.com/mail/?authuser={account}#all/{quote(message_id, safe='')}"
    if provider in ("microsoft", "ews"):
        return f"https://outlook.office.com/mail/deeplink/read/{quote(message_id, safe='')}"
    if provider == "icloud":
        return "https://www.icloud.com/mail/"
    if provider == "yahoo":
        return "https://mail.yahoo.com/"
    return None


# ── Storing confirmations ───────────────────────────────────────────────────


async def record_application(
    session: AsyncSession, user_id: str, message: dict[str, Any], result: dict[str, Any]
) -> MailApplication | None:
    """Store one confirmation email. None when it repeats a stored application."""
    company = (result.get("company") or "").strip()
    key = extraction.company_key(company)
    applied_at: datetime | None = message.get("date")
    if not key or applied_at is None:
        return None

    existing = (
        await session.execute(
            select(MailApplication).where(
                MailApplication.user_id == user_id, MailApplication.company_key == key
            )
        )
    ).scalars().all()
    role = (result.get("role") or "").strip()[:300] or None
    for row in existing:
        if row.message_id == message["id"]:
            return None
        same_role = roles_match(row.role_title, role) or (not row.role_title and not role)
        if same_role and abs(row.applied_at - applied_at) <= SAME_APPLICATION_WINDOW:
            if role and not row.role_title:
                row.role_title = role
            return None

    row = MailApplication(
        id=str(uuid.uuid4()),
        user_id=user_id,
        company=company[:300],
        company_key=key,
        role_title=role,
        applied_at=applied_at,
        message_id=message["id"],
        thread_id=message.get("thread_id"),
        email_subject=(message.get("subject") or "")[:500] or None,
        email_from=(message.get("from") or "")[:500] or None,
        linked_job_ids=[],
    )
    session.add(row)
    await session.flush()
    return row


async def known_message_ids(session: AsyncSession, user_id: str, since: datetime) -> set[str]:
    rows = await session.execute(
        select(MailApplication.message_id).where(
            MailApplication.user_id == user_id, MailApplication.applied_at >= since
        )
    )
    return set(rows.scalars())


# ── Marking jobs applied ────────────────────────────────────────────────────


async def _mark_applied(session: AsyncSession, user_id: str, job_id: str, applied_at: datetime) -> bool:
    """Insert an applied row; never overwrites a mark the user (or an earlier email) made."""
    result = await session.execute(
        pg_insert(ValidJobUserApplication)
        .values(
            id=str(uuid.uuid4()),
            user_id=user_id,
            job_id=job_id,
            applied_at=applied_at,
            applied_by_name=EMAIL_APPLIED_LABEL,
        )
        .on_conflict_do_nothing(
            index_elements=[ValidJobUserApplication.user_id, ValidJobUserApplication.job_id]
        )
    )
    return bool(result.rowcount)


def _remember_link(app: MailApplication, job_id: str) -> None:
    linked = list(app.linked_job_ids or [])
    if job_id not in linked:
        app.linked_job_ids = [*linked, job_id]
    if app.job_id is None:
        app.job_id = job_id


async def link_jobs(session: AsyncSession, user_id: str) -> int:
    """Mark pool jobs applied when a recent confirmation names the same company and role.

    Runs after every sync so jobs scraped after the email still get marked.
    A job is only ever linked once per email, so unmarking it sticks.
    """
    since = _utcnow() - LINK_LOOKBACK
    apps = list(
        (
            await session.execute(
                select(MailApplication).where(
                    MailApplication.user_id == user_id,
                    MailApplication.applied_at >= since,
                    MailApplication.role_title.is_not(None),
                )
            )
        ).scalars()
    )
    if not apps:
        return 0

    by_token: dict[str, list[MailApplication]] = {}
    for app in apps:
        token = _first_token(app.company_key)
        if len(token) >= 2:
            by_token.setdefault(token, []).append(app)

    marked = 0
    for token, group in by_token.items():
        jobs = (
            await session.execute(
                select(Job)
                .join(UserJobStatus, (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id))
                .where(
                    Job.status == "active",
                    func.coalesce(Job.posted_date, Job.created_at) >= since,
                    func.lower(Job.company).contains(token, autoescape=True),
                )
                .limit(200)
            )
        ).scalars().all()
        for job in jobs:
            keys = job_company_keys(job)
            for app in group:
                if app.company_key not in keys or job.id in (app.linked_job_ids or []):
                    continue
                if not roles_match(app.role_title, job.title):
                    continue
                _remember_link(app, job.id)
                if await _mark_applied(session, user_id, job.id, app.applied_at):
                    marked += 1
    await session.flush()
    return marked


async def find_for_job(
    session: AsyncSession, user_id: str, job: Job, *, since: datetime
) -> tuple[MailApplication | None, MailApplication | None]:
    """(same-role confirmation, any confirmation) at this job's company since ``since``."""
    keys = job_company_keys(job)
    if not keys:
        return None, None
    rows = (
        await session.execute(
            select(MailApplication)
            .where(
                MailApplication.user_id == user_id,
                MailApplication.company_key.in_(sorted(keys)),
                MailApplication.applied_at >= since,
            )
            .order_by(MailApplication.applied_at.desc())
        )
    ).scalars().all()
    same_role = next((r for r in rows if roles_match(r.role_title, job.title)), None)
    return same_role, (rows[0] if rows else None)


async def mark_job_from_email(session: AsyncSession, user_id: str, job: Job, app: MailApplication) -> bool:
    _remember_link(app, job.id)
    return await _mark_applied(session, user_id, job.id, app.applied_at)


def dedup_reason(app: MailApplication) -> str:
    role = f" ({app.role_title})" if app.role_title else ""
    return (
        f"You applied to {app.company}{role} on {app.applied_at.strftime('%b %d, %Y')}, "
        "found in your email."
    )


async def company_keys_since(session: AsyncSession, user_id: str, since: datetime) -> dict[str, MailApplication]:
    """Newest confirmation per company key since ``since``."""
    rows = (
        await session.execute(
            select(MailApplication)
            .where(MailApplication.user_id == user_id, MailApplication.applied_at >= since)
            .order_by(MailApplication.applied_at.desc())
        )
    ).scalars().all()
    out: dict[str, MailApplication] = {}
    for row in rows:
        out.setdefault(row.company_key, row)
    return out


# ── Insights ────────────────────────────────────────────────────────────────


async def counts_from_inbox(session: AsyncSession, user_id: str) -> bool:
    """Confirmation emails are the applied count once the inbox has synced at least once.

    A mailbox that is connected but never synced (first sync failed or still
    running) holds no confirmations yet, so counting from it would show zero.
    """
    row = await session.execute(
        select(MailConnection.id).where(
            MailConnection.user_id == user_id, MailConnection.last_synced_at.is_not(None)
        )
    )
    return row.first() is not None


async def applied_by_day(
    session: AsyncSession, user_id: str, *, start_utc: datetime, end_utc: datetime, tz_name: str | None
) -> dict[date, int]:
    from app.services.weekly_progress import _local_date_expr, _rows_to_day_map

    day = _local_date_expr(MailApplication.applied_at, tz_name)
    rows = (
        await session.execute(
            select(day.label("day"), func.count().label("cnt"))
            .where(
                MailApplication.user_id == user_id,
                MailApplication.applied_at >= start_utc,
                MailApplication.applied_at < end_utc,
            )
            .group_by(day)
        )
    ).all()
    return _rows_to_day_map(rows)


def application_public(app: MailApplication, conn: MailConnection | None, jobs: dict[str, dict]) -> dict[str, Any]:
    return {
        "id": app.id,
        "company": app.company,
        "role_title": app.role_title,
        "applied_at": _iso(app.applied_at),
        "email_subject": app.email_subject,
        "email_from": app.email_from,
        "email_url": email_url(conn, app.message_id, app.thread_id),
        "job": jobs.get(app.job_id or ""),
    }


async def overview(
    session: AsyncSession, user_id: str, conn: MailConnection | None, *, tz_name: str | None, days: int
) -> dict[str, Any]:
    from app.utils.date_bounds import _resolve_tz, recent_week_bounds_for_timezone

    tz_name = _resolve_tz(tz_name).key
    start_utc, end_utc, day_list = recent_week_bounds_for_timezone(tz_name, days=days)
    by_day = await applied_by_day(session, user_id, start_utc=start_utc, end_utc=end_utc, tz_name=tz_name)
    series = [
        {"date": d.isoformat(), "label": d.strftime("%a") if days <= 7 else str(d.day), "count": by_day.get(d, 0)}
        for d in day_list
    ]

    in_range = (
        await session.execute(
            select(MailApplication)
            .where(
                MailApplication.user_id == user_id,
                MailApplication.applied_at >= start_utc,
                MailApplication.applied_at < end_utc,
            )
            .order_by(MailApplication.applied_at.desc())
        )
    ).scalars().all()
    total_all = (
        await session.execute(select(func.count()).where(MailApplication.user_id == user_id))
    ).scalar_one()

    recent = list(in_range[:12])
    job_ids = [a.job_id for a in recent if a.job_id]
    jobs: dict[str, dict] = {}
    if job_ids:
        for jid, title in (await session.execute(select(Job.id, Job.title).where(Job.id.in_(job_ids)))).all():
            jobs[jid] = {"id": jid, "title": title}

    companies: dict[str, dict[str, Any]] = {}
    for app in in_range:
        entry = companies.setdefault(app.company_key, {"company": app.company, "count": 0})
        entry["count"] += 1
    top = sorted(companies.values(), key=lambda c: (-c["count"], c["company"].lower()))[:6]

    week_start = day_list[-7] if len(day_list) >= 7 else day_list[0]
    today = day_list[-1]
    return {
        "connected": conn is not None,
        "connection": {
            "email": conn.email,
            "provider": conn.provider,
            "sync_status": conn.sync_status or "idle",
            "last_synced_at": _iso(conn.last_synced_at),
            "last_sync_error": conn.last_sync_error,
            "last_sync_stats": conn.last_sync_stats or None,
            "status": conn.status,
        }
        if conn
        else None,
        "timezone": tz_name or "UTC",
        "days": days,
        "series": series,
        "totals": {
            "range": len(in_range),
            "today": by_day.get(today, 0),
            "week": sum(v for d, v in by_day.items() if d >= week_start),
            "companies": len(companies),
            "linked_jobs": sum(1 for a in in_range if a.job_id),
            "all_time": int(total_all or 0),
        },
        "top_companies": top,
        "recent": [application_public(a, conn, jobs) for a in recent],
    }
