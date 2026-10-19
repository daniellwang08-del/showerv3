"""Applications from the inbox: confirmation emails stored, matched to jobs and charted.

An application confirmation ("Thanks for applying to Acme") is the source of
truth for "applied" once a mailbox is connected, because people also apply
outside NAO. One application often sends several emails (a resend, a
recruiting platform and the employer, a generic and a role-specific note), so
each application is stored once, and each stored application:

* links to at most one job: the job the user marked applied in NAO around
  the same time, else one pool job with the same company and role, which is
  then marked applied ("Email confirmation"), and
* feeds the applied-company dedup rule for companies with no job in NAO.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import Job, MailApplication, MailConnection, UserJobStatus, ValidJobUserApplication
from app.services import interview_extraction as extraction

logger = get_logger(__name__)

EMAIL_APPLIED_LABEL = "Email confirmation"
# Two confirmations for the same company and role this close together are one
# application. A confirmation without a role can't tell roles apart, so it
# repeats any application at that company in the window.
SAME_APPLICATION_WINDOW = timedelta(days=3)
# A recruiting platform ("Thanks for applying to Clera") and the employer
# ("Your application through Clera") confirm one application minutes apart.
RELAY_WINDOW = timedelta(hours=1)
# NAO marks a job applied when the user applies; the employer's email follows.
MARK_WINDOW = timedelta(days=2)
LINK_LOOKBACK = timedelta(days=120)

_ROLE_NOISE = frozenset(
    {"remote", "hybrid", "onsite", "on", "site", "contract", "full", "part", "time", "fulltime",
     "parttime", "us", "usa", "the", "a", "an", "of", "and", "for", "to", "in", "at", "m", "f", "d", "x",
     "position", "role"}
)
_ROLE_SYNONYMS = {"sr": "senior", "snr": "senior", "jr": "junior", "mgr": "manager"}
_REQUISITION = re.compile(r"(?:r|jr|req)\d{2,}")
# Account, verification and survey mail sent around an application. Some of
# these are the only confirmation an employer sends ("Finish your Humana
# application" opens with "We received your application"), so they only
# repeat an application already stored for that company.
_FOLLOW_UP = re.compile(
    r"^\s*(welcome to|confirm your|verify your|please verify|activate your|finish your|complete your)\b"
    r"|\bsurvey\b",
    re.IGNORECASE,
)


def _utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


# ── Matching ────────────────────────────────────────────────────────────────


def role_tokens(title: str | None) -> frozenset[str]:
    value = (title or "").lower().replace("&", " and ")
    value = re.sub(r"\b(back|front|full)[\s-]+(end|stack)\b", r"\1\2", value)
    words = (_ROLE_SYNONYMS.get(w, w) for w in re.findall(r"[a-z0-9+#]+", value))
    return frozenset(
        w for w in words if w not in _ROLE_NOISE and not w.isdigit() and not _REQUISITION.fullmatch(w)
    )


def roles_match(a: str | None, b: str | None) -> bool:
    """Same role, ignoring work mode, punctuation and requisition numbers.

    Every other word counts: seniority ("Senior Engineer" vs "Engineer"), team
    ("Backend (Card)" vs "Backend (Lakehouse)") and location ("Canada").
    """
    ta, tb = role_tokens(a), role_tokens(b)
    return bool(ta) and ta == tb


def roles_compatible(email_role: str | None, job_title: str | None) -> bool:
    """The email may confirm this job: same role, one title is a shorter form of the other, or either has none."""
    ta, tb = role_tokens(email_role), role_tokens(job_title)
    return not ta or not tb or ta <= tb or tb <= ta


def is_follow_up(subject: str | None) -> bool:
    return bool(_FOLLOW_UP.search(subject or ""))


def _company_variant(a: str, b: str) -> bool:
    """'randstad' and 'randstad usa': one name is the other plus extra words."""
    return a == b or a.startswith(b + " ") or b.startswith(a + " ")


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


def _names_company(text: str, key: str) -> bool:
    token = _first_token(key)
    return len(token) >= 3 and re.search(rf"\b{re.escape(token)}\b", text.lower()) is not None


def repeated_application(
    rows: list[MailApplication],
    *,
    company: str,
    key: str,
    role: str | None,
    applied_at: datetime,
    subject: str | None,
    sender: str | None,
) -> MailApplication | None:
    """The stored application this confirmation repeats (updated in place), or None when it is new."""
    text = f"{subject or ''} {sender or ''}"
    follow_up = is_follow_up(subject)
    for row in rows:
        if not _company_variant(row.company_key, key) or abs(row.applied_at - applied_at) > SAME_APPLICATION_WINDOW:
            continue
        if row.role_title and role and not roles_match(row.role_title, role):
            continue
        if follow_up:
            return row
        if is_follow_up(row.email_subject):
            # The confirmation itself arrived after an account or survey email: it describes the application.
            row.company, row.company_key = company[:300], key
            row.role_title = role or row.role_title
            row.email_subject, row.email_from = (subject or "")[:500] or None, (sender or "")[:500] or None
            return row
    for row in rows:
        if row.company_key != key or abs(row.applied_at - applied_at) > SAME_APPLICATION_WINDOW:
            continue
        if not row.role_title or not role or roles_match(row.role_title, role):
            if role and not row.role_title:
                row.role_title = role
            return row
    for row in rows:
        if row.company_key == key or abs(row.applied_at - applied_at) > RELAY_WINDOW:
            continue
        if not roles_match(row.role_title, role):
            continue
        if _names_company(text, row.company_key):
            # This is the employer's note about an application sent through row's platform.
            row.company, row.company_key = company[:300], key
            return row
        if _names_company(f"{row.email_subject or ''} {row.email_from or ''}", key):
            return row
    return None


async def record_application(
    session: AsyncSession, user_id: str, message: dict[str, Any], result: dict[str, Any]
) -> MailApplication | None:
    """Store one confirmation email. None when it repeats a stored application."""
    company = (result.get("company") or "").strip()
    key = extraction.company_key(company)
    applied_at: datetime | None = message.get("date")
    if not key or applied_at is None:
        return None

    existing = list(
        (
            await session.execute(
                select(MailApplication).where(
                    MailApplication.user_id == user_id,
                    or_(
                        MailApplication.company_key.startswith(_first_token(key), autoescape=True),
                        MailApplication.applied_at.between(applied_at - RELAY_WINDOW, applied_at + RELAY_WINDOW),
                    ),
                )
            )
        ).scalars().all()
    )
    if any(row.message_id == message["id"] for row in existing):
        return None
    role = (result.get("role") or "").strip()[:300] or None
    if repeated_application(
        existing,
        company=company,
        key=key,
        role=role,
        applied_at=applied_at,
        subject=message.get("subject"),
        sender=message.get("from"),
    ):
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


def _pick_marked(
    app: MailApplication, marked: list[tuple[Job, datetime, str | None]], claimed: set[str]
) -> Job | None:
    """The job already marked applied that this email confirms, preferring the user's own marks."""
    options = [
        (job, at, by)
        for job, at, by in marked
        if job.id not in claimed
        and app.company_key in job_company_keys(job)
        and abs(at - app.applied_at) <= MARK_WINDOW
        and roles_compatible(app.role_title, job.title)
    ]
    if not options:
        return None
    best = min(
        options,
        key=lambda o: (not roles_match(app.role_title, o[0].title), o[2] == EMAIL_APPLIED_LABEL, abs(o[1] - app.applied_at)),
    )
    return best[0]


def _pick_pool_job(app: MailApplication, jobs: list[Job], claimed: set[str]) -> Job | None:
    """One pool job with the same company and role; the newest when the posting is listed twice."""
    options = [
        job
        for job in jobs
        if job.id not in claimed and app.company_key in job_company_keys(job) and roles_match(app.role_title, job.title)
    ]
    if not options:
        return None
    return max(options, key=lambda j: j.posted_date or j.created_at or datetime.min)


async def link_jobs(session: AsyncSession, user_id: str) -> int:
    """Link each recent unlinked confirmation to one job. Returns how many jobs were newly marked.

    A job the user marked applied in NAO around the email's date is the same
    application, so it is linked without a new mark (even when the email names
    no role). Otherwise one pool job with the same company and role is marked
    applied. Runs after every sync so jobs scraped after the email still get
    linked; a linked email is never relinked, so unmarking its job sticks.
    """
    since = _utcnow() - LINK_LOOKBACK
    apps = list(
        (
            await session.execute(
                select(MailApplication)
                .where(
                    MailApplication.user_id == user_id,
                    MailApplication.applied_at >= since,
                    MailApplication.job_id.is_(None),
                )
                .order_by(MailApplication.applied_at)
            )
        ).scalars()
    )
    if not apps:
        return 0
    claimed = set(
        (
            await session.execute(
                select(MailApplication.job_id).where(
                    MailApplication.user_id == user_id, MailApplication.job_id.is_not(None)
                )
            )
        ).scalars()
    )

    by_token: dict[str, list[MailApplication]] = {}
    for app in apps:
        token = _first_token(app.company_key)
        if len(token) >= 2:
            by_token.setdefault(token, []).append(app)

    marked = 0
    for token, group in by_token.items():
        company_has = func.lower(Job.company).contains(token, autoescape=True)
        marked_jobs = [
            (job, at, by)
            for job, at, by in (
                await session.execute(
                    select(Job, ValidJobUserApplication.applied_at, ValidJobUserApplication.applied_by_name)
                    .join(ValidJobUserApplication, ValidJobUserApplication.job_id == Job.id)
                    .where(
                        ValidJobUserApplication.user_id == user_id,
                        ValidJobUserApplication.applied_at >= since - MARK_WINDOW,
                        company_has,
                    )
                )
            ).all()
        ]
        pool: list[Job] | None = None
        for app in group:
            job = _pick_marked(app, marked_jobs, claimed)
            if job is not None:
                _remember_link(app, job.id)
                claimed.add(job.id)
                continue
            if not app.role_title or app.linked_job_ids:
                continue
            if pool is None:
                pool = list(
                    (
                        await session.execute(
                            select(Job)
                            .join(UserJobStatus, (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id))
                            .where(
                                Job.status == "active",
                                func.coalesce(Job.posted_date, Job.created_at) >= since,
                                company_has,
                            )
                            .limit(200)
                        )
                    ).scalars()
                )
            job = _pick_pool_job(app, pool, claimed)
            if job is None:
                continue
            _remember_link(app, job.id)
            claimed.add(job.id)
            if await _mark_applied(session, user_id, job.id, app.applied_at):
                marked += 1
    await session.flush()
    return marked


async def find_for_job(
    session: AsyncSession, user_id: str, job: Job, *, since: datetime
) -> tuple[MailApplication | None, MailApplication | None]:
    """(same-role confirmation not linked to another job, newest confirmation) at this job's company."""
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
    same_role = next(
        (r for r in rows if r.job_id in (None, job.id) and roles_match(r.role_title, job.title)), None
    )
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
