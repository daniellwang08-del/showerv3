"""Read-only report links: the owner's interviews, applications and job activity.

Each invited person gets their own link so access can be revoked or expire per
person. The report leaves out anything that only works for, or exposes, the
owner: mailbox deep links, recruiter addresses and meeting join links. Private
notes are included only when the owner opts in for that person.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any, Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import (
    Job,
    JobMatchResult,
    MailApplication,
    ReportShare,
    User,
    ValidJobUserApplication,
)
from app.services import interview_extraction as extraction
from app.services import interview_service, mail_applications, nylas_service
from app.utils.secret_encryption import decrypt_secret, encrypt_secret

logger = get_logger(__name__)

MAX_SHARES = 25
MAX_EMAILS_PER_REQUEST = 10
EXPIRY_CHOICES = (7, 30, 90)
APPLICATIONS_LOOKBACK = timedelta(days=90)
MAX_APPLICATIONS = 1000
ACTIVITY_DAYS = 30

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
_EVENT_PRIVATE = ("meeting_url", "email_url", "email_from")
_CLOSED_STAGES = ("rejected", "withdrawn")


class ShareError(Exception):
    """A request the owner can fix; the message is shown as is."""


class ShareNotFound(Exception):
    pass


def _utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


# ── Tokens and fields ───────────────────────────────────────────────────────


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(24)
    return token, hash_token(token)


def normalize_email(value: str | None) -> str | None:
    email = (value or "").strip().strip("<>").strip().lower()
    return email if len(email) <= 255 and _EMAIL_RE.match(email) else None


def expiry_from_days(days: int | None, now: datetime | None = None) -> datetime | None:
    if days is None:
        return None
    if days not in EXPIRY_CHOICES:
        raise ShareError(f"Access can last {', '.join(map(str, EXPIRY_CHOICES))} days or have no end date.")
    return (now or _utcnow()) + timedelta(days=days)


def is_active(share: ReportShare, now: datetime | None = None) -> bool:
    return share.expires_at is None or share.expires_at > (now or _utcnow())


def display_name(user: User | None) -> str:
    if user is None:
        return "A NAO user"
    full = " ".join(p for p in (user.name_first, user.name_last) if p and p.strip()).strip()
    name = (user.name or "").strip()
    if name and "@" not in name:
        return name
    if full:
        return full
    return (user.email or "A NAO user").split("@")[0]


def share_public(share: ReportShare, now: datetime | None = None) -> dict[str, Any]:
    try:
        token = decrypt_secret(share.token_enc)
    except ValueError:
        token = None
    return {
        "id": share.id,
        "email": share.email,
        "token": token,
        "include_notes": bool(share.include_notes),
        "message": share.message,
        "expires_at": _iso(share.expires_at),
        "active": is_active(share, now),
        "last_viewed_at": _iso(share.last_viewed_at),
        "view_count": int(share.view_count or 0),
        "created_at": _iso(share.created_at),
    }


# ── Owner actions ───────────────────────────────────────────────────────────


async def list_shares(session: AsyncSession, owner_id: str) -> list[ReportShare]:
    rows = await session.execute(
        select(ReportShare).where(ReportShare.owner_id == owner_id).order_by(ReportShare.created_at.desc())
    )
    return list(rows.scalars())


def clean_emails(raw: Iterable[str], owner_email: str | None) -> list[str]:
    """Valid, unique, lower-cased invitee emails. Raises on a bad address or the owner's own."""
    out: list[str] = []
    own = (owner_email or "").strip().lower()
    for value in raw:
        email = normalize_email(value)
        if email is None:
            raise ShareError(f"{(value or '').strip() or 'An empty value'} is not a valid email address.")
        if email == own:
            raise ShareError("That is your own email. Add the people you want to share with.")
        if email not in out:
            out.append(email)
    if not out:
        raise ShareError("Add at least one email address.")
    if len(out) > MAX_EMAILS_PER_REQUEST:
        raise ShareError(f"Share with up to {MAX_EMAILS_PER_REQUEST} people at a time.")
    return out


async def share_with(
    session: AsyncSession,
    owner: User,
    emails: Iterable[str],
    *,
    expires_in_days: int | None,
    include_notes: bool,
    message: str | None,
) -> list[ReportShare]:
    """Create a link per person. Inviting someone again renews their access and keeps their link."""
    wanted = clean_emails(emails, owner.email)
    expires_at = expiry_from_days(expires_in_days)
    message = (message or "").strip()[:500] or None
    existing = {s.email: s for s in await list_shares(session, owner.id)}
    new_count = sum(1 for e in wanted if e not in existing)
    if len(existing) + new_count > MAX_SHARES:
        raise ShareError(f"You can share with up to {MAX_SHARES} people. Remove someone first.")

    out: list[ReportShare] = []
    for email in wanted:
        share = existing.get(email)
        if share is None:
            token, token_hash = new_token()
            share = ReportShare(
                id=str(uuid.uuid4()),
                owner_id=owner.id,
                email=email,
                token_hash=token_hash,
                token_enc=encrypt_secret(token),
                view_count=0,
            )
            session.add(share)
        share.include_notes = include_notes
        share.expires_at = expires_at
        share.message = message
        out.append(share)
    await session.flush()
    return out


async def _own_share(session: AsyncSession, owner_id: str, share_id: str) -> ReportShare:
    share = await session.get(ReportShare, share_id)
    if share is None or share.owner_id != owner_id:
        raise ShareNotFound()
    return share


async def update_share(session: AsyncSession, owner_id: str, share_id: str, changes: dict[str, Any]) -> ReportShare:
    share = await _own_share(session, owner_id, share_id)
    if "expires_in_days" in changes:
        share.expires_at = expiry_from_days(changes["expires_in_days"])
    if "include_notes" in changes and changes["include_notes"] is not None:
        share.include_notes = bool(changes["include_notes"])
    if changes.get("reset_link"):
        token, token_hash = new_token()
        share.token_hash = token_hash
        share.token_enc = encrypt_secret(token)
        share.view_count = 0
        share.last_viewed_at = None
    await session.flush()
    return share


async def delete_share(session: AsyncSession, owner_id: str, share_id: str) -> None:
    await session.delete(await _own_share(session, owner_id, share_id))
    await session.flush()


# ── Viewer side ─────────────────────────────────────────────────────────────


async def find_active(session: AsyncSession, token: str) -> tuple[ReportShare | None, bool]:
    """(share, expired). The share is None when the token is unknown or revoked."""
    if not token or len(token) > 128:
        return None, False
    share = (
        await session.execute(select(ReportShare).where(ReportShare.token_hash == hash_token(token)))
    ).scalar_one_or_none()
    if share is None:
        return None, False
    return share, not is_active(share)


def record_view(share: ReportShare, now: datetime | None = None) -> None:
    share.last_viewed_at = now or _utcnow()
    share.view_count = int(share.view_count or 0) + 1


async def incoming(session: AsyncSession, email: str | None, user_id: str) -> list[dict[str, Any]]:
    """Active reports shared with this account's email."""
    email = normalize_email(email)
    if not email:
        return []
    rows = (
        await session.execute(
            select(ReportShare, User)
            .join(User, User.id == ReportShare.owner_id)
            .where(ReportShare.email == email, ReportShare.owner_id != user_id)
            .order_by(ReportShare.created_at.desc())
        )
    ).all()
    now = _utcnow()
    out = []
    for share, owner in rows:
        if not is_active(share, now):
            continue
        public = share_public(share, now)
        if not public["token"]:
            continue
        out.append(
            {
                "id": share.id,
                "token": public["token"],
                "owner_name": display_name(owner),
                "shared_at": public["created_at"],
                "expires_at": public["expires_at"],
                "last_viewed_at": public["last_viewed_at"],
            }
        )
    return out


# ── Report ──────────────────────────────────────────────────────────────────


def sanitize_event(event: dict[str, Any] | None) -> dict[str, Any] | None:
    if event is None:
        return None
    return {**event, **{k: None for k in _EVENT_PRIVATE}}


def sanitize_process(process: dict[str, Any], *, include_notes: bool) -> dict[str, Any]:
    return {
        **process,
        "notes": process.get("notes") if include_notes else None,
        "email_url": None,
        "events": [sanitize_event(e) for e in process.get("events") or []],
        "next_event": sanitize_event(process.get("next_event")),
    }


def _activity_time(process: dict[str, Any]) -> str:
    return process.get("last_activity_at") or process.get("created_at") or ""


def link_applications(applications: list[dict[str, Any]], processes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give each application the stage of its interview process, matched by job, then by company."""
    by_job: dict[str, dict[str, Any]] = {}
    by_company: dict[str, dict[str, Any]] = {}
    for p in sorted(processes, key=_activity_time):
        job_id = (p.get("job") or {}).get("id")
        if job_id:
            by_job[job_id] = p
        key = extraction.company_key(p.get("company"))
        if key:
            by_company[key] = p
    out = []
    for app in applications:
        process = by_job.get(app.get("job_id") or "") or by_company.get(extraction.company_key(app.get("company")))
        out.append(
            {
                **app,
                "stage": process["stage"] if process else "applied",
                "process_id": process["id"] if process else None,
                "process_active": bool(process and process["status"] == "active" and process["stage"] not in _CLOSED_STAGES),
            }
        )
    return out


async def _applications(session: AsyncSession, owner_id: str, since: datetime) -> list[dict[str, Any]]:
    marked = (
        await session.execute(
            select(
                ValidJobUserApplication.applied_at,
                ValidJobUserApplication.applied_by_name,
                Job.id,
                Job.title,
                Job.company,
                Job.location,
                Job.source_url,
                JobMatchResult.overall_score,
            )
            .join(Job, Job.id == ValidJobUserApplication.job_id)
            .outerjoin(
                JobMatchResult,
                (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == owner_id),
            )
            .where(ValidJobUserApplication.user_id == owner_id, ValidJobUserApplication.applied_at >= since)
            .order_by(ValidJobUserApplication.applied_at.desc())
            .limit(MAX_APPLICATIONS)
        )
    ).all()
    apps = [
        {
            "id": f"job:{job_id}",
            "job_id": job_id,
            "title": title,
            "company": company,
            "location": location,
            "url": url,
            "applied_at": _iso(applied_at),
            "source": "email" if by == mail_applications.EMAIL_APPLIED_LABEL else "nao",
            "match_score": round(score) if score is not None else None,
        }
        for applied_at, by, job_id, title, company, location, url, score in marked
    ]
    inbox_only = (
        await session.execute(
            select(MailApplication)
            .where(
                MailApplication.user_id == owner_id,
                MailApplication.applied_at >= since,
                MailApplication.job_id.is_(None),
            )
            .order_by(MailApplication.applied_at.desc())
            .limit(MAX_APPLICATIONS)
        )
    ).scalars()
    apps += [
        {
            "id": f"mail:{a.id}",
            "job_id": None,
            "title": a.role_title,
            "company": a.company,
            "location": None,
            "url": None,
            "applied_at": _iso(a.applied_at),
            "source": "email",
            "match_score": None,
        }
        for a in inbox_only
    ]
    apps.sort(key=lambda a: a["applied_at"] or "", reverse=True)
    return apps[:MAX_APPLICATIONS]


async def _applications_total(session: AsyncSession, owner_id: str, since: datetime) -> int:
    marked = await session.execute(
        select(func.count()).where(
            ValidJobUserApplication.user_id == owner_id, ValidJobUserApplication.applied_at >= since
        )
    )
    inbox_only = await session.execute(
        select(func.count()).where(
            MailApplication.user_id == owner_id,
            MailApplication.applied_at >= since,
            MailApplication.job_id.is_(None),
        )
    )
    return int(marked.scalar_one() or 0) + int(inbox_only.scalar_one() or 0)


async def _job_pool(session: AsyncSession, owner_id: str, tz_name: str | None) -> dict[str, Any] | None:
    from app.services.dashboard_stats import fetch_dashboard_stats
    from app.storage.user_repository import UserRepository
    from app.utils.date_bounds import day_bounds_for_timezone

    try:
        day_start, day_end = day_bounds_for_timezone(tz_name)
        min_score = await UserRepository(session).get_effective_min_match_score(owner_id)
        data = await fetch_dashboard_stats(
            session, owner_id, day_start=day_start, day_end=day_end, min_match_score=min_score
        )
    except Exception as e:  # The rest of the report is still useful without pool numbers.
        logger.warning("report_share_pool_failed", owner_id=owner_id, error=str(e))
        return None
    keys = ("total_jobs", "scored_jobs", "ready_jobs", "applied_jobs", "best_jobs", "good_jobs", "today_scraped")
    out = {k: int(data.get(k) or 0) for k in keys}
    out["avg_match_score"] = round(float(data.get("avg_match_score") or 0))
    out["min_match_score"] = int(min_score)
    return out


async def build_report(
    session: AsyncSession, owner_id: str, *, include_notes: bool, tz_name: str | None
) -> dict[str, Any]:
    from app.services.weekly_progress import fetch_weekly_progress_series
    from app.utils.date_bounds import _resolve_tz

    tz_name = _resolve_tz(tz_name).key
    owner = await session.get(User, owner_id)
    conn = await nylas_service.get_connection(session, owner_id)
    processes = await interview_service.list_processes(session, owner_id, None)
    clean = [sanitize_process(p, include_notes=include_notes) for p in processes]
    since = _utcnow() - APPLICATIONS_LOOKBACK
    applications = link_applications(await _applications(session, owner_id, since), clean)
    activity = await fetch_weekly_progress_series(session, owner_id, tz_name=tz_name, days=ACTIVITY_DAYS)
    total_applied = (
        await session.execute(select(func.count()).where(ValidJobUserApplication.user_id == owner_id))
    ).scalar_one()
    return {
        "owner": {
            "name": display_name(owner),
            "headline": (owner.profile_title or None) if owner else None,
        },
        "generated_at": _iso(_utcnow()),
        "include_notes": include_notes,
        "interviews": {
            "connected": conn is not None,
            "last_synced_at": _iso(conn.last_synced_at) if conn else None,
            "processes": clean,
            "summary": interview_service.summarize(clean),
        },
        "activity": activity,
        "applications": {
            "items": applications,
            "total": await _applications_total(session, owner_id, since),
            "lookback_days": APPLICATIONS_LOOKBACK.days,
            "all_time": int(total_applied or 0),
        },
        "pool": await _job_pool(session, owner_id, tz_name),
    }
