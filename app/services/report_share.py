"""Report sharing between NAO accounts: the owner's interviews, applications and job activity.

An owner shares with other NAO users by their account email. Viewers find the
report under "Shared with me" once signed in; nothing is sent and there is no
public link. Access can expire or be removed per person. The report leaves
out anything that only works for, or exposes, the owner: mailbox deep links,
recruiter addresses and meeting join links. Private notes are included only
when the owner opts in for that person.
"""

from __future__ import annotations

import re
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


# ── Fields ──────────────────────────────────────────────────────────────────


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


def can_view_shares(user: User | None) -> bool:
    """Approved, active applicant accounts; admins have no applicant workspace to open a report in."""
    return bool(
        user
        and user.is_active
        and not user.is_admin
        and (user.approval_status or "approved") == "approved"
    )


def share_public(share: ReportShare, viewer: User | None = None, now: datetime | None = None) -> dict[str, Any]:
    return {
        "id": share.id,
        "email": share.email,
        "viewer_name": display_name(viewer) if viewer else None,
        "include_notes": bool(share.include_notes),
        "message": share.message,
        "expires_at": _iso(share.expires_at),
        "active": is_active(share, now),
        "last_viewed_at": _iso(share.last_viewed_at),
        "view_count": int(share.view_count or 0),
        "created_at": _iso(share.created_at),
    }


# ── Owner actions ───────────────────────────────────────────────────────────


async def list_shares(session: AsyncSession, owner_id: str) -> list[tuple[ReportShare, User | None]]:
    rows = await session.execute(
        select(ReportShare, User)
        .outerjoin(User, User.id == ReportShare.viewer_id)
        .where(ReportShare.owner_id == owner_id)
        .order_by(ReportShare.created_at.desc())
    )
    return [(share, viewer) for share, viewer in rows.all()]


async def users_by_email(session: AsyncSession, emails: list[str]) -> dict[str, User]:
    rows = await session.execute(select(User).where(func.lower(User.email).in_(emails)))
    return {u.email.lower(): u for u in rows.scalars()}


def resolve_viewers(emails: list[str], users: dict[str, User]) -> list[User]:
    """The NAO account for each email. Raises naming every address that cannot receive a report."""
    missing = [e for e in emails if not can_view_shares(users.get(e))]
    if missing:
        listed = ", ".join(missing)
        if len(missing) == 1:
            raise ShareError(f"{listed} does not have a NAO account yet. Ask them to sign up, then share again.")
        raise ShareError(f"These emails do not have NAO accounts yet: {listed}. Ask them to sign up, then share again.")
    return [users[e] for e in emails]


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
) -> list[tuple[ReportShare, User]]:
    """Give each NAO account access. Sharing with someone again updates their access settings."""
    wanted = clean_emails(emails, owner.email)
    expires_at = expiry_from_days(expires_in_days)
    message = (message or "").strip()[:500] or None
    viewers = resolve_viewers(wanted, await users_by_email(session, wanted))
    existing = {share.viewer_id: share for share, _ in await list_shares(session, owner.id)}
    new_count = sum(1 for v in viewers if v.id not in existing)
    if len(existing) + new_count > MAX_SHARES:
        raise ShareError(f"You can share with up to {MAX_SHARES} people. Remove someone first.")

    out: list[tuple[ReportShare, User]] = []
    for viewer in viewers:
        share = existing.get(viewer.id)
        if share is None:
            share = ReportShare(id=str(uuid.uuid4()), owner_id=owner.id, viewer_id=viewer.id, view_count=0)
            session.add(share)
        share.email = viewer.email.lower()
        share.include_notes = include_notes
        share.expires_at = expires_at
        share.message = message
        out.append((share, viewer))
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
    await session.flush()
    return share


async def delete_share(session: AsyncSession, owner_id: str, share_id: str) -> None:
    await session.delete(await _own_share(session, owner_id, share_id))
    await session.flush()


# ── Viewer side ─────────────────────────────────────────────────────────────


async def viewer_share(session: AsyncSession, viewer_id: str, share_id: str) -> tuple[ReportShare, User]:
    """An active share for this viewer and its owner. Raises ShareNotFound otherwise, also when expired."""
    row = (
        await session.execute(
            select(ReportShare, User)
            .join(User, User.id == ReportShare.owner_id)
            .where(ReportShare.id == share_id, ReportShare.viewer_id == viewer_id)
        )
    ).first()
    if row is None or not is_active(row[0]):
        raise ShareNotFound()
    return row[0], row[1]


def record_view(share: ReportShare, now: datetime | None = None) -> None:
    share.last_viewed_at = now or _utcnow()
    share.view_count = int(share.view_count or 0) + 1


def incoming_public(share: ReportShare, owner: User) -> dict[str, Any]:
    return {
        "id": share.id,
        "owner_name": display_name(owner),
        "owner_headline": owner.profile_title or None,
        "message": share.message,
        "shared_at": _iso(share.created_at),
        "expires_at": _iso(share.expires_at),
        "last_viewed_at": _iso(share.last_viewed_at),
    }


async def incoming(session: AsyncSession, viewer_id: str) -> list[dict[str, Any]]:
    """Active reports other people shared with this account, newest first."""
    rows = (
        await session.execute(
            select(ReportShare, User)
            .join(User, User.id == ReportShare.owner_id)
            .where(ReportShare.viewer_id == viewer_id, User.is_active.is_(True))
            .order_by(ReportShare.created_at.desc())
        )
    ).all()
    now = _utcnow()
    return [incoming_public(share, owner) for share, owner in rows if is_active(share, now)]


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
