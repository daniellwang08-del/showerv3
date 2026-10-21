"""Team spaces: one per TEAM package, led by the person who created it.

The lead invites people by email; they join by accepting. A person belongs to
at most one space (a lead can own several). The lead sets each member's
default sharing for jobs they add, optionally locked, and sees each member's
activity: jobs added, applications, and interviews.

"team" sharing means the people who share a space with you: your lead and
fellow members, or for a lead, the members of the spaces they own.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any, Iterable

from sqlalchemy import delete, exists, func, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import (
    InterviewEvent,
    InterviewProcess,
    Job,
    JobAddBatch,
    MailApplication,
    TeamInvite,
    TeamMember,
    TeamSpace,
    User,
    UserPackage,
    ValidJobUserApplication,
)
from app.services import store_service
from app.services.report_share import display_name

logger = get_logger(__name__)

SHARE_DEFAULTS = ("private", "team", "all")
MAX_INVITES_PER_REQUEST = 10
MAX_PENDING_INVITES = 100
NAME_MAX = 80
STATS_DAYS = 30
FEED_DAYS = 14
FEED_LIMIT = 60
_CLOSED_STAGES = ("rejected", "withdrawn")


class TeamError(Exception):
    """A request the user can fix; the message is shown as is."""


class TeamNotFound(Exception):
    pass


def utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def _person(user: User | None) -> dict[str, Any] | None:
    if user is None:
        return None
    return {"id": user.id, "name": display_name(user), "email": user.email}


def clean_name(raw: str | None) -> str:
    name = " ".join((raw or "").split())
    if not name:
        raise TeamError("Give the team space a name.")
    if len(name) > NAME_MAX:
        raise TeamError(f"Keep the name under {NAME_MAX} characters.")
    return name


def clean_share(raw: str | None) -> str:
    value = str(raw or "").strip().lower()
    if value not in SHARE_DEFAULTS:
        raise TeamError("Sharing must be private, team, or all.")
    return value


async def new_public_id(session: AsyncSession) -> str:
    for _ in range(20):
        candidate = f"nao-{secrets.randbelow(10**8):08d}"
        taken = await session.execute(select(TeamSpace.id).where(TeamSpace.public_id == candidate))
        if taken.scalar_one_or_none() is None:
            return candidate
    raise RuntimeError("Could not allocate a team space id")


# ── Visibility ─────────────────────────────────────────────────────────────


def _participants(name: str):
    """(space_id, user_id) for every lead and member."""
    return union_all(
        select(TeamMember.team_space_id.label("space_id"), TeamMember.user_id.label("user_id")),
        select(TeamSpace.id.label("space_id"), TeamSpace.owner_user_id.label("user_id")),
    ).subquery(name)


def teammates_clause(owner_col, viewer_id: str):
    """SQL: ``owner_col`` and ``viewer_id`` share a team space."""
    owner_side = _participants("team_owner_side")
    viewer_side = _participants("team_viewer_side")
    return exists(
        select(1)
        .select_from(owner_side.join(viewer_side, owner_side.c.space_id == viewer_side.c.space_id))
        .where(owner_side.c.user_id == owner_col, viewer_side.c.user_id == viewer_id)
    )


async def space_ids_for(session: AsyncSession, user_id: str) -> set[str]:
    owned = await session.execute(select(TeamSpace.id).where(TeamSpace.owner_user_id == user_id))
    member = await session.execute(select(TeamMember.team_space_id).where(TeamMember.user_id == user_id))
    return {row[0] for row in owned.all()} | {row[0] for row in member.all()}


async def teammate_ids(session: AsyncSession, user_id: str) -> set[str]:
    """Everyone who shares a space with this person, themselves excluded."""
    spaces = await space_ids_for(session, user_id)
    if not spaces:
        return set()
    participants = _participants("team_people")
    rows = await session.execute(select(participants.c.user_id).where(participants.c.space_id.in_(spaces)))
    return {row[0] for row in rows.all()} - {user_id}


async def locked_share_scope(session: AsyncSession, user_id: str) -> str | None:
    """The sharing a lead pinned for this member, or None when the member chooses.

    Locked on any team means locked; the value is the member's one setting.
    """
    row = (
        await session.execute(
            select(User.job_share_default)
            .join(TeamMember, TeamMember.user_id == User.id)
            .where(TeamMember.user_id == user_id, TeamMember.share_locked.is_(True))
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    value = str(row[0] or "private").strip().lower()
    return value if value in SHARE_DEFAULTS else "private"


async def sharing_lock_info(session: AsyncSession, user_id: str) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(TeamSpace.name, TeamSpace.public_id)
            .join(TeamMember, TeamMember.team_space_id == TeamSpace.id)
            .where(TeamMember.user_id == user_id, TeamMember.share_locked.is_(True))
            .order_by(TeamMember.joined_at)
        )
    ).all()
    return {
        "job_share_locked": bool(rows),
        "team_space_name": ", ".join(r[0] for r in rows) if rows else None,
        "team_space_public_id": rows[0][1] if rows else None,
    }


# ── Lookups ────────────────────────────────────────────────────────────────


async def _owned_space(session: AsyncSession, lead_id: str, space_id: str) -> TeamSpace:
    space = await session.get(TeamSpace, space_id)
    if space is None or space.owner_user_id != lead_id:
        raise TeamNotFound()
    return space


async def _memberships(session: AsyncSession, user_id: str) -> list[tuple[TeamMember, TeamSpace]]:
    rows = await session.execute(
        select(TeamMember, TeamSpace)
        .join(TeamSpace, TeamSpace.id == TeamMember.team_space_id)
        .where(TeamMember.user_id == user_id)
        .order_by(TeamMember.joined_at)
    )
    return [(m, s) for m, s in rows.all()]


def space_public(space: TeamSpace, *, members: int = 0, pending: int = 0, lead: User | None = None) -> dict[str, Any]:
    return {
        "id": space.id,
        "public_id": space.public_id,
        "name": space.name,
        "lead": _person(lead),
        "member_count": members,
        "pending_invites": pending,
        "default_share_scope": space.default_share_scope,
        "default_share_locked": bool(space.default_share_locked),
        "created_at": _iso(space.created_at),
    }


async def _counts(session: AsyncSession, space_ids: list[str]) -> tuple[dict[str, int], dict[str, int]]:
    if not space_ids:
        return {}, {}
    members = await session.execute(
        select(TeamMember.team_space_id, func.count())
        .where(TeamMember.team_space_id.in_(space_ids))
        .group_by(TeamMember.team_space_id)
    )
    pending = await session.execute(
        select(TeamInvite.team_space_id, func.count())
        .where(TeamInvite.team_space_id.in_(space_ids), TeamInvite.status == "pending")
        .group_by(TeamInvite.team_space_id)
    )
    return {k: int(v) for k, v in members.all()}, {k: int(v) for k, v in pending.all()}


def invite_public(invite: TeamInvite, *, space: TeamSpace | None = None, lead: User | None = None) -> dict[str, Any]:
    return {
        "id": invite.id,
        "email": invite.email,
        "status": invite.status,
        "created_at": _iso(invite.created_at),
        "space": space_public(space, lead=lead) if space else None,
    }


async def incoming_invites(session: AsyncSession, user: User) -> list[dict[str, Any]]:
    email = (user.email or "").lower()
    rows = await session.execute(
        select(TeamInvite, TeamSpace, User)
        .join(TeamSpace, TeamSpace.id == TeamInvite.team_space_id)
        .join(User, User.id == TeamSpace.owner_user_id)
        .where(TeamInvite.email == email, TeamInvite.status == "pending", TeamSpace.owner_user_id != user.id)
        .order_by(TeamInvite.created_at.desc())
    )
    return [invite_public(invite, space=space, lead=lead) for invite, space, lead in rows.all()]


async def overview(session: AsyncSession, user: User) -> dict[str, Any]:
    """Spaces I lead, the spaces I belong to, and invitations waiting for me."""
    owned = list(
        (
            await session.execute(
                select(TeamSpace).where(TeamSpace.owner_user_id == user.id).order_by(TeamSpace.created_at)
            )
        ).scalars()
    )
    members, pending = await _counts(session, [s.id for s in owned])
    memberships = await _memberships(session, user.id)
    mcount, _ = await _counts(session, [space.id for _m, space in memberships])
    joined = []
    for member, space in memberships:
        lead = await session.get(User, space.owner_user_id)
        joined.append(
            {
                **space_public(space, members=mcount.get(space.id, 0), lead=lead),
                "joined_at": _iso(member.joined_at),
                "share_locked": bool(member.share_locked),
            }
        )
    team_packages = await session.execute(
        select(func.count())
        .select_from(UserPackage)
        .where(UserPackage.owner_user_id == user.id, UserPackage.status == "held", UserPackage.kind == "team")
    )
    return {
        "owned": [space_public(s, members=members.get(s.id, 0), pending=pending.get(s.id, 0), lead=user) for s in owned],
        "memberships": joined,
        "invites": await incoming_invites(session, user),
        "team_packages_held": int(team_packages.scalar_one() or 0),
    }


# ── Lead actions ───────────────────────────────────────────────────────────


async def create_space(session: AsyncSession, lead: User, package_id: str, raw_name: str) -> dict[str, Any]:
    """Use one TEAM package to open a space. The package is consumed for good."""
    name = clean_name(raw_name)
    try:
        pkg = await store_service.mark_redeemed(session, lead.id, package_id, kind="team")
    except store_service.StoreNotFound as e:
        raise TeamNotFound() from e
    except store_service.StoreError as e:
        raise TeamError(str(e)) from e
    space = TeamSpace(
        id=str(uuid.uuid4()),
        public_id=await new_public_id(session),
        name=name,
        owner_user_id=lead.id,
        package_id=pkg.id,
    )
    session.add(space)
    pkg.redeemed_ref = space.id
    await session.flush()
    logger.info("team_space_created", user_id=lead.id, space_id=space.id, public_id=space.public_id)
    return space_public(space, lead=lead)


async def update_space(session: AsyncSession, lead: User, space_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    space = await _owned_space(session, lead.id, space_id)
    if changes.get("name") is not None:
        space.name = clean_name(changes["name"])
    if "default_share_scope" in changes:
        raw = changes["default_share_scope"]
        space.default_share_scope = clean_share(raw) if raw else None
        if not space.default_share_scope:
            space.default_share_locked = False
    if changes.get("default_share_locked") is not None:
        space.default_share_locked = bool(changes["default_share_locked"]) and bool(space.default_share_scope)
    space.updated_at = utcnow()
    await session.flush()
    members, pending = await _counts(session, [space.id])
    return space_public(space, members=members.get(space.id, 0), pending=pending.get(space.id, 0), lead=lead)


async def delete_space(session: AsyncSession, lead: User, space_id: str) -> None:
    """Close the space. Members are released; the TEAM package stays used."""
    space = await _owned_space(session, lead.id, space_id)
    await session.execute(delete(TeamMember).where(TeamMember.team_space_id == space.id))
    await session.execute(delete(TeamInvite).where(TeamInvite.team_space_id == space.id))
    await session.delete(space)
    await session.flush()
    logger.info("team_space_deleted", user_id=lead.id, space_id=space_id)


def clean_invite_emails(raw: Iterable[str], lead_email: str | None) -> list[str]:
    out: list[str] = []
    own = (lead_email or "").lower()
    for value in raw:
        email = store_service.normalize_email(value)
        if email is None:
            raise TeamError(f"{(value or '').strip() or 'An empty value'} is not a valid email address.")
        if email == own:
            raise TeamError("You lead this space already. Invite the people you want on the team.")
        if email not in out:
            out.append(email)
    if not out:
        raise TeamError("Add at least one email address.")
    if len(out) > MAX_INVITES_PER_REQUEST:
        raise TeamError(f"Invite up to {MAX_INVITES_PER_REQUEST} people at a time.")
    return out


async def invite(session: AsyncSession, lead: User, space_id: str, emails: Iterable[str]) -> dict[str, Any]:
    """Invite by email. Existing members and pending invites are skipped, not duplicated."""
    space = await _owned_space(session, lead.id, space_id)
    wanted = clean_invite_emails(emails, lead.email)
    users = {
        u.email.lower(): u
        for u in (await session.execute(select(User).where(func.lower(User.email).in_(wanted)))).scalars()
    }
    admins = [e for e in wanted if users.get(e) is not None and users[e].is_admin]
    if admins:
        raise TeamError(f"Admin accounts cannot join a team space: {', '.join(admins)}.")
    member_ids = {
        row[0]
        for row in (
            await session.execute(select(TeamMember.user_id).where(TeamMember.team_space_id == space.id))
        ).all()
    }
    pending = {
        row[0]
        for row in (
            await session.execute(
                select(TeamInvite.email).where(TeamInvite.team_space_id == space.id, TeamInvite.status == "pending")
            )
        ).all()
    }
    created: list[TeamInvite] = []
    skipped: list[dict[str, str]] = []
    for email in wanted:
        user = users.get(email)
        if user is not None and user.id in member_ids:
            skipped.append({"email": email, "reason": "Already on this team"})
        elif email in pending:
            skipped.append({"email": email, "reason": "Already invited"})
        else:
            row = TeamInvite(id=str(uuid.uuid4()), team_space_id=space.id, email=email, invited_by_user_id=lead.id)
            session.add(row)
            created.append(row)
    if len(pending) + len(created) > MAX_PENDING_INVITES:
        raise TeamError(f"A space can have up to {MAX_PENDING_INVITES} open invitations. Revoke some first.")
    await session.flush()
    logger.info("team_invites_sent", user_id=lead.id, space_id=space.id, count=len(created))
    return {
        "invites": [{**invite_public(i), "has_account": i.email in users} for i in created],
        "skipped": skipped,
    }


async def revoke_invite(session: AsyncSession, lead: User, space_id: str, invite_id: str) -> None:
    space = await _owned_space(session, lead.id, space_id)
    row = await session.get(TeamInvite, invite_id)
    if row is None or row.team_space_id != space.id or row.status != "pending":
        raise TeamNotFound()
    row.status = "revoked"
    row.responded_at = utcnow()
    await session.flush()


async def remove_member(session: AsyncSession, lead: User, space_id: str, member_user_id: str) -> None:
    space = await _owned_space(session, lead.id, space_id)
    result = await session.execute(
        delete(TeamMember).where(TeamMember.team_space_id == space.id, TeamMember.user_id == member_user_id)
    )
    if not result.rowcount:
        raise TeamNotFound()
    await session.flush()
    logger.info("team_member_removed", user_id=lead.id, space_id=space.id, member_id=member_user_id)


async def update_member_sharing(
    session: AsyncSession,
    lead: User,
    space_id: str,
    member_user_id: str,
    *,
    share_default: str | None,
    share_locked: bool | None,
) -> dict[str, Any]:
    space = await _owned_space(session, lead.id, space_id)
    row = (
        await session.execute(
            select(TeamMember, User)
            .join(User, User.id == TeamMember.user_id)
            .where(TeamMember.team_space_id == space.id, TeamMember.user_id == member_user_id)
        )
    ).first()
    if row is None:
        raise TeamNotFound()
    member, user = row
    if share_default is not None:
        user.job_share_default = clean_share(share_default)
    if share_locked is not None:
        member.share_locked = bool(share_locked)
    await session.flush()
    return {
        "user_id": user.id,
        "share_default": user.job_share_default,
        "share_locked": bool(member.share_locked),
    }


# ── Member actions ─────────────────────────────────────────────────────────


async def respond_invite(session: AsyncSession, user: User, invite_id: str, *, accept: bool) -> dict[str, Any]:
    row = await session.get(TeamInvite, invite_id)
    if row is None or row.email != (user.email or "").lower() or row.status != "pending":
        raise TeamNotFound()
    space = await session.get(TeamSpace, row.team_space_id)
    if space is None:
        raise TeamNotFound()
    if not accept:
        row.status = "declined"
        row.responded_at = utcnow()
        await session.flush()
        return {"status": "declined"}
    if space.owner_user_id == user.id:
        raise TeamError("You lead this space already.")
    current = await _memberships(session, user.id)
    if any(s.id == space.id for _m, s in current):
        row.status = "accepted"
        row.responded_at = utcnow()
        await session.flush()
        lead = await session.get(User, space.owner_user_id)
        return {"status": "accepted", "space": space_public(space, lead=lead)}
    member = TeamMember(
        id=str(uuid.uuid4()),
        team_space_id=space.id,
        user_id=user.id,
        share_locked=bool(space.default_share_scope and space.default_share_locked),
    )
    # A lead on another team who already pinned the setting keeps it; one
    # person has one sharing setting across all their teams.
    locked_elsewhere = any(m.share_locked for m, _s in current)
    if space.default_share_scope and not locked_elsewhere:
        user.job_share_default = space.default_share_scope
    session.add(member)
    row.status = "accepted"
    row.responded_at = utcnow()
    await session.flush()
    logger.info("team_invite_accepted", user_id=user.id, space_id=space.id)
    lead = await session.get(User, space.owner_user_id)
    return {"status": "accepted", "space": space_public(space, lead=lead)}


async def leave(session: AsyncSession, user: User, space_id: str) -> None:
    result = await session.execute(
        delete(TeamMember).where(TeamMember.user_id == user.id, TeamMember.team_space_id == space_id)
    )
    if not result.rowcount:
        raise TeamNotFound()
    await session.flush()
    logger.info("team_member_left", user_id=user.id, space_id=space_id)


# ── Monitoring ─────────────────────────────────────────────────────────────


async def _member_stats(
    session: AsyncSession, user_ids: list[str], days: int = STATS_DAYS
) -> dict[str, dict[str, Any]]:
    since = utcnow() - timedelta(days=days)
    now = utcnow()
    stats: dict[str, dict[str, Any]] = {
        uid: {"jobs_added": 0, "applied": 0, "active_interviews": 0, "upcoming_interviews": 0, "last_active_at": None}
        for uid in user_ids
    }
    if not user_ids:
        return stats
    last: dict[str, datetime] = {}

    def bump(uid: str, when: datetime | None) -> None:
        if when and (uid not in last or when > last[uid]):
            last[uid] = when

    added = await session.execute(
        select(JobAddBatch.user_id, func.coalesce(func.sum(JobAddBatch.job_count), 0), func.max(JobAddBatch.created_at))
        .where(JobAddBatch.user_id.in_(user_ids), JobAddBatch.created_at >= since)
        .group_by(JobAddBatch.user_id)
    )
    for uid, n, when in added.all():
        stats[uid]["jobs_added"] = int(n or 0)
        bump(uid, when)

    marked = await session.execute(
        select(ValidJobUserApplication.user_id, func.count(), func.max(ValidJobUserApplication.applied_at))
        .where(ValidJobUserApplication.user_id.in_(user_ids), ValidJobUserApplication.applied_at >= since)
        .group_by(ValidJobUserApplication.user_id)
    )
    for uid, n, when in marked.all():
        stats[uid]["applied"] += int(n or 0)
        bump(uid, when)
    # Confirmation emails for jobs that were never in NAO (linked ones already have a mark).
    outside = await session.execute(
        select(MailApplication.user_id, func.count(), func.max(MailApplication.applied_at))
        .where(
            MailApplication.user_id.in_(user_ids),
            MailApplication.applied_at >= since,
            MailApplication.job_id.is_(None),
        )
        .group_by(MailApplication.user_id)
    )
    for uid, n, when in outside.all():
        stats[uid]["applied"] += int(n or 0)
        bump(uid, when)

    active = await session.execute(
        select(InterviewProcess.user_id, func.count(), func.max(InterviewProcess.last_activity_at))
        .where(
            InterviewProcess.user_id.in_(user_ids),
            InterviewProcess.status == "active",
            InterviewProcess.stage.not_in(_CLOSED_STAGES),
        )
        .group_by(InterviewProcess.user_id)
    )
    for uid, n, when in active.all():
        stats[uid]["active_interviews"] = int(n or 0)
        bump(uid, when)

    # One booking can arrive in several emails; count each time once.
    upcoming = await session.execute(
        select(InterviewEvent.user_id, InterviewEvent.process_id, InterviewEvent.scheduled_at)
        .where(
            InterviewEvent.user_id.in_(user_ids),
            InterviewEvent.status == "scheduled",
            InterviewEvent.scheduled_at >= now,
            InterviewEvent.ignored_at.is_(None),
        )
        .distinct()
    )
    for uid, _process_id, _at in upcoming.all():
        stats[uid]["upcoming_interviews"] += 1

    for uid, when in last.items():
        stats[uid]["last_active_at"] = _iso(when)
    return stats


async def space_detail(session: AsyncSession, lead: User, space_id: str) -> dict[str, Any]:
    space = await _owned_space(session, lead.id, space_id)
    rows = (
        await session.execute(
            select(TeamMember, User)
            .join(User, User.id == TeamMember.user_id)
            .where(TeamMember.team_space_id == space.id)
            .order_by(TeamMember.joined_at)
        )
    ).all()
    stats = await _member_stats(session, [user.id for _, user in rows])
    invites = (
        await session.execute(
            select(TeamInvite)
            .where(TeamInvite.team_space_id == space.id, TeamInvite.status == "pending")
            .order_by(TeamInvite.created_at.desc())
        )
    ).scalars()
    invite_list = list(invites)
    known = set()
    if invite_list:
        found = await session.execute(
            select(func.lower(User.email)).where(func.lower(User.email).in_([i.email for i in invite_list]))
        )
        known = {row[0] for row in found.all()}
    members = [
        {
            **_person(user),
            "headline": user.profile_title or None,
            "joined_at": _iso(member.joined_at),
            "share_default": (user.job_share_default or "private")
            if (user.job_share_default or "private") in SHARE_DEFAULTS
            else "private",
            "share_locked": bool(member.share_locked),
            "stats": stats[user.id],
        }
        for member, user in rows
    ]
    return {
        "space": space_public(space, members=len(members), pending=len(invite_list), lead=lead),
        "members": members,
        "invites": [{**invite_public(i), "has_account": i.email in known} for i in invite_list],
        "stats_days": STATS_DAYS,
    }


async def activity_feed(session: AsyncSession, lead: User, space_id: str) -> dict[str, Any]:
    """Recent job adds, applications, and interview steps across the team, newest first."""
    space = await _owned_space(session, lead.id, space_id)
    people = {
        u.id: u
        for u in (
            await session.execute(
                select(User).join(TeamMember, TeamMember.user_id == User.id).where(TeamMember.team_space_id == space.id)
            )
        ).scalars()
    }
    if not people:
        return {"items": [], "days": FEED_DAYS}
    ids = list(people)
    since = utcnow() - timedelta(days=FEED_DAYS)
    items: list[dict[str, Any]] = []

    adds = await session.execute(
        select(JobAddBatch)
        .where(JobAddBatch.user_id.in_(ids), JobAddBatch.created_at >= since)
        .order_by(JobAddBatch.created_at.desc())
        .limit(FEED_LIMIT)
    )
    for b in adds.scalars():
        n = int(b.job_count or 0)
        items.append(
            {
                "id": f"add:{b.id}",
                "kind": "jobs_added",
                "at": b.created_at,
                "user_id": b.user_id,
                "title": f"Added {n} job{'' if n == 1 else 's'}",
                "detail": None,
                "share_scope": b.share_scope,
            }
        )

    applied = await session.execute(
        select(ValidJobUserApplication.user_id, ValidJobUserApplication.applied_at, Job.id, Job.title, Job.company)
        .join(Job, Job.id == ValidJobUserApplication.job_id)
        .where(ValidJobUserApplication.user_id.in_(ids), ValidJobUserApplication.applied_at >= since)
        .order_by(ValidJobUserApplication.applied_at.desc())
        .limit(FEED_LIMIT)
    )
    for uid, at, job_id, title, company in applied.all():
        items.append(
            {
                "id": f"applied:{uid}:{job_id}",
                "kind": "applied",
                "at": at,
                "user_id": uid,
                "title": f"Applied to {title or 'a job'}",
                "detail": company,
            }
        )

    events = await session.execute(
        select(InterviewEvent, InterviewProcess.company, InterviewProcess.role_title)
        .join(InterviewProcess, InterviewProcess.id == InterviewEvent.process_id)
        .where(InterviewEvent.user_id.in_(ids), InterviewEvent.created_at >= since)
        .order_by(InterviewEvent.created_at.desc())
        .limit(FEED_LIMIT)
    )
    for ev, company, role in events.all():
        items.append(
            {
                "id": f"interview:{ev.id}",
                "kind": "interview",
                "at": ev.email_date or ev.created_at,
                "user_id": ev.user_id,
                "title": ev.title or (ev.kind or "Interview update").replace("_", " ").capitalize(),
                "detail": " - ".join(p for p in (company, role) if p) or None,
                "status": ev.status,
                "scheduled_at": _iso(ev.scheduled_at),
            }
        )

    items.sort(key=lambda i: i["at"] or datetime.min, reverse=True)
    out = []
    for item in items[:FEED_LIMIT]:
        out.append({**item, "at": _iso(item["at"]), "member": _person(people.get(item["user_id"]))})
    return {"items": out, "days": FEED_DAYS}


async def member_report(
    session: AsyncSession, lead: User, space_id: str, member_user_id: str, tz_name: str | None
) -> dict[str, Any]:
    """The member's interview and application report, as a report share shows it (no private notes)."""
    from app.services.report_share import build_report

    space = await _owned_space(session, lead.id, space_id)
    member = (
        await session.execute(
            select(TeamMember).where(TeamMember.team_space_id == space.id, TeamMember.user_id == member_user_id)
        )
    ).scalar_one_or_none()
    if member is None:
        raise TeamNotFound()
    report = await build_report(session, member_user_id, include_notes=False, tz_name=tz_name)
    return {
        "share": None,
        "report": report,
        "team": {"id": space.id, "public_id": space.public_id, "name": space.name},
    }


async def lead_can_view(session: AsyncSession, lead_id: str, member_user_id: str) -> bool:
    """True when ``member_user_id`` belongs to a space ``lead_id`` owns."""
    row = await session.execute(
        select(TeamMember.id)
        .join(TeamSpace, TeamSpace.id == TeamMember.team_space_id)
        .where(TeamSpace.owner_user_id == lead_id, TeamMember.user_id == member_user_id)
        .limit(1)
    )
    return row.scalar_one_or_none() is not None


INSIGHT_RANGES = (7, 14, 30, 90)


def _zone(tz_name: str | None):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(tz_name or "UTC")
    except Exception:
        return ZoneInfo("UTC")


async def team_insights(
    session: AsyncSession, lead: User, space_id: str, days: int, tz_name: str | None
) -> dict[str, Any]:
    """Per-member totals and daily progress across one space, for the lead's Insights view."""
    from datetime import timezone as _tz

    if days not in INSIGHT_RANGES:
        days = STATS_DAYS
    space = await _owned_space(session, lead.id, space_id)
    rows = (
        await session.execute(
            select(TeamMember, User)
            .join(User, User.id == TeamMember.user_id)
            .where(TeamMember.team_space_id == space.id)
            .order_by(TeamMember.joined_at)
        )
    ).all()
    ids = [user.id for _, user in rows]
    zone = _zone(tz_name)
    today = datetime.now(_tz.utc).astimezone(zone).date()
    dates = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    index = {d: i for i, d in enumerate(dates)}
    since = utcnow() - timedelta(days=days + 1)

    series: dict[str, dict[str, list[int]]] = {
        uid: {"added": [0] * days, "applied": [0] * days, "interviews": [0] * days} for uid in ids
    }

    def put(uid: str, when: datetime | None, key: str, n: int = 1) -> None:
        if not when or uid not in series:
            return
        local = when.replace(tzinfo=_tz.utc).astimezone(zone).date()
        slot = index.get(local)
        if slot is not None:
            series[uid][key][slot] += n

    if ids:
        for uid, when, n in (
            await session.execute(
                select(JobAddBatch.user_id, JobAddBatch.created_at, JobAddBatch.job_count).where(
                    JobAddBatch.user_id.in_(ids), JobAddBatch.created_at >= since
                )
            )
        ).all():
            put(uid, when, "added", int(n or 0))
        for uid, when in (
            await session.execute(
                select(ValidJobUserApplication.user_id, ValidJobUserApplication.applied_at).where(
                    ValidJobUserApplication.user_id.in_(ids), ValidJobUserApplication.applied_at >= since
                )
            )
        ).all():
            put(uid, when, "applied")
        for uid, when in (
            await session.execute(
                select(MailApplication.user_id, MailApplication.applied_at).where(
                    MailApplication.user_id.in_(ids),
                    MailApplication.applied_at >= since,
                    MailApplication.job_id.is_(None),
                )
            )
        ).all():
            put(uid, when, "applied")
        for uid, when in (
            await session.execute(
                select(InterviewEvent.user_id, func.coalesce(InterviewEvent.email_date, InterviewEvent.created_at)).where(
                    InterviewEvent.user_id.in_(ids),
                    InterviewEvent.created_at >= since,
                    InterviewEvent.ignored_at.is_(None),
                )
            )
        ).all():
            put(uid, when, "interviews")

    stats = await _member_stats(session, ids, days)
    members = []
    for member, user in rows:
        s = series[user.id]
        members.append(
            {
                **_person(user),
                "headline": user.profile_title or None,
                "joined_at": _iso(member.joined_at),
                "stats": {
                    **stats[user.id],
                    "jobs_added": sum(s["added"]),
                    "applied": sum(s["applied"]),
                    "interview_updates": sum(s["interviews"]),
                },
                "series": s,
            }
        )
    window_start = utcnow() - timedelta(days=days)
    active = sum(
        1
        for m in members
        if m["stats"]["last_active_at"]
        and datetime.fromisoformat(m["stats"]["last_active_at"].rstrip("Z")) >= window_start
    )
    totals = {
        "members": len(members),
        "active_members": active,
        "jobs_added": sum(m["stats"]["jobs_added"] for m in members),
        "applied": sum(m["stats"]["applied"] for m in members),
        "interview_updates": sum(m["stats"]["interview_updates"] for m in members),
        "active_interviews": sum(m["stats"]["active_interviews"] for m in members),
        "upcoming_interviews": sum(m["stats"]["upcoming_interviews"] for m in members),
    }
    return {
        "space": {"id": space.id, "public_id": space.public_id, "name": space.name},
        "days": days,
        "dates": [d.isoformat() for d in dates],
        "members": members,
        "totals": totals,
    }
