"""Package store and credit balance.

People hold packages (credit packs and TEAM) in their store until they use
them. A credit pack becomes balance when redeemed; a TEAM package becomes one
team space (see ``team_service``). Held packages can be given to someone else
by email; a gift to an email with no account waits until that email signs up.
Payments are not live yet, so packages arrive through admin grants.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import CreditLedgerEntry, TeamSpace, User, UserPackage

logger = get_logger(__name__)

SIGNUP_CREDITS = 50
MAX_GRANT_QUANTITY = 20
MAX_GRANT_RECIPIENTS = 100
LEDGER_PAGE = 50
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)


@dataclass(frozen=True)
class CatalogItem:
    code: str
    kind: str
    name: str
    credits: int
    price_cents: int


CATALOG: dict[str, CatalogItem] = {
    item.code: item
    for item in (
        CatalogItem("starter", "credits", "Starter", 250, 2500),
        CatalogItem("growth", "credits", "Growth", 500, 4500),
        CatalogItem("pro", "credits", "Pro", 1000, 8000),
        CatalogItem("scale", "credits", "Scale", 10000, 50000),
        CatalogItem("team", "team", "TEAM", 0, 2000),
    )
}


class StoreError(Exception):
    """A request the user can fix; the message is shown as is."""


class StoreNotFound(Exception):
    pass


def utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def normalize_email(value: str | None) -> str | None:
    email = (value or "").strip().strip("<>").strip().lower()
    return email if len(email) <= 255 and _EMAIL_RE.match(email) else None


def catalog_public() -> list[dict[str, Any]]:
    return [
        {"code": c.code, "kind": c.kind, "name": c.name, "credits": c.credits, "price_cents": c.price_cents}
        for c in CATALOG.values()
    ]


def package_name(code: str) -> str:
    item = CATALOG.get(code)
    return item.name if item else code


def _person(user: User | None) -> dict[str, Any] | None:
    if user is None:
        return None
    from app.services.report_share import display_name

    return {"id": user.id, "name": display_name(user), "email": user.email}


def package_public(
    pkg: UserPackage,
    *,
    owner: User | None = None,
    gifted_from: User | None = None,
    team_space: TeamSpace | None = None,
) -> dict[str, Any]:
    return {
        "id": pkg.id,
        "code": pkg.code,
        "kind": pkg.kind,
        "name": package_name(pkg.code),
        "credits": int(pkg.credits or 0),
        "price_cents": int(pkg.price_cents or 0),
        "status": pkg.status,
        "source": pkg.source,
        "owner": _person(owner),
        "pending_email": pkg.owner_email if pkg.owner_user_id is None else None,
        "gifted_from": _person(gifted_from),
        "note": pkg.note if pkg.source == "admin_grant" else None,
        "redeemed_at": _iso(pkg.redeemed_at),
        "team_space": (
            {"id": team_space.id, "public_id": team_space.public_id, "name": team_space.name} if team_space else None
        ),
        "created_at": _iso(pkg.created_at),
        "updated_at": _iso(pkg.updated_at),
    }


# ── Credits ────────────────────────────────────────────────────────────────


async def add_credits(
    session: AsyncSession,
    user_id: str,
    delta: int,
    *,
    reason: str,
    ref_id: str | None = None,
    note: str | None = None,
) -> int:
    """Change the balance atomically and record it. Returns the new balance; never goes below zero."""
    stmt = update(User).where(User.id == user_id)
    if delta < 0:
        stmt = stmt.where(User.credit_balance >= -delta)
    result = await session.execute(
        stmt.values(credit_balance=User.credit_balance + delta).returning(User.credit_balance)
    )
    balance = result.scalar_one_or_none()
    if balance is None:
        raise StoreError("Not enough credits.")
    session.add(
        CreditLedgerEntry(
            id=str(uuid.uuid4()),
            user_id=user_id,
            delta=delta,
            balance_after=int(balance),
            reason=reason,
            ref_id=ref_id,
            note=(note or None) and note[:300],
        )
    )
    await session.flush()
    return int(balance)


async def grant_signup_bonus(session: AsyncSession, user: User) -> None:
    await add_credits(session, user.id, SIGNUP_CREDITS, reason="signup_bonus", note="Welcome credits")


async def balance_of(session: AsyncSession, user_id: str) -> int:
    value = (await session.execute(select(User.credit_balance).where(User.id == user_id))).scalar_one_or_none()
    return int(value or 0)


def ledger_public(entry: CreditLedgerEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "delta": int(entry.delta),
        "balance_after": int(entry.balance_after),
        "reason": entry.reason,
        "note": entry.note,
        "created_at": _iso(entry.created_at),
    }


async def ledger(session: AsyncSession, user_id: str, *, limit: int = LEDGER_PAGE) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(CreditLedgerEntry)
        .where(CreditLedgerEntry.user_id == user_id)
        .order_by(CreditLedgerEntry.created_at.desc(), CreditLedgerEntry.id.desc())
        .limit(max(1, min(limit, 200)))
    )
    return [ledger_public(e) for e in rows.scalars()]


# ── Store ──────────────────────────────────────────────────────────────────


async def claim_pending(session: AsyncSession, user: User) -> int:
    """Gifts and grants sent to this email before the account existed now belong to it."""
    email = (user.email or "").strip().lower()
    if not email:
        return 0
    result = await session.execute(
        update(UserPackage)
        .where(
            UserPackage.owner_user_id.is_(None),
            UserPackage.owner_email == email,
            UserPackage.status == "held",
        )
        .values(owner_user_id=user.id, owner_email=None, updated_at=utcnow())
    )
    claimed = int(result.rowcount or 0)
    if claimed:
        logger.info("store_pending_claimed", user_id=user.id, count=claimed)
    return claimed


async def _people(session: AsyncSession, ids: set[str]) -> dict[str, User]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await session.execute(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in rows.scalars()}


async def _serialize(session: AsyncSession, packages: list[UserPackage]) -> list[dict[str, Any]]:
    people = await _people(
        session, {p.owner_user_id for p in packages} | {p.gifted_from_user_id for p in packages}
    )
    space_ids = {p.redeemed_ref for p in packages if p.kind == "team" and p.redeemed_ref}
    spaces: dict[str, TeamSpace] = {}
    if space_ids:
        rows = await session.execute(select(TeamSpace).where(TeamSpace.id.in_(space_ids)))
        spaces = {s.id: s for s in rows.scalars()}
    return [
        package_public(
            p,
            owner=people.get(p.owner_user_id or ""),
            gifted_from=people.get(p.gifted_from_user_id or ""),
            team_space=spaces.get(p.redeemed_ref or ""),
        )
        for p in packages
    ]


async def store(session: AsyncSession, user: User) -> dict[str, Any]:
    """What this person holds, what they used, and what they gave away."""
    await claim_pending(session, user)
    held = await session.execute(
        select(UserPackage)
        .where(UserPackage.owner_user_id == user.id, UserPackage.status == "held")
        .order_by(UserPackage.created_at.desc())
    )
    used = await session.execute(
        select(UserPackage)
        .where(UserPackage.owner_user_id == user.id, UserPackage.status == "redeemed")
        .order_by(UserPackage.redeemed_at.desc().nullslast())
        .limit(100)
    )
    given = await session.execute(
        select(UserPackage)
        .where(
            UserPackage.gifted_from_user_id == user.id,
            or_(UserPackage.owner_user_id.is_(None), UserPackage.owner_user_id != user.id),
            UserPackage.status != "revoked",
        )
        .order_by(UserPackage.updated_at.desc())
        .limit(100)
    )
    return {
        "balance": await balance_of(session, user.id),
        "held": await _serialize(session, list(held.scalars())),
        "used": await _serialize(session, list(used.scalars())),
        "given": await _serialize(session, list(given.scalars())),
        "catalog": catalog_public(),
    }


async def _owned_held(session: AsyncSession, user_id: str, package_id: str) -> UserPackage:
    pkg = await session.get(UserPackage, package_id)
    if pkg is None or pkg.owner_user_id != user_id:
        raise StoreNotFound()
    if pkg.status != "held":
        raise StoreError("This package was already used.")
    return pkg


async def mark_redeemed(session: AsyncSession, user_id: str, package_id: str, *, kind: str) -> UserPackage:
    """Consume a held package exactly once, even under double submits."""
    pkg = await _owned_held(session, user_id, package_id)
    if pkg.kind != kind:
        raise StoreError("This package cannot be used that way.")
    now = utcnow()
    result = await session.execute(
        update(UserPackage)
        .where(UserPackage.id == package_id, UserPackage.owner_user_id == user_id, UserPackage.status == "held")
        .values(status="redeemed", redeemed_at=now, updated_at=now)
    )
    if not result.rowcount:
        raise StoreError("This package was already used.")
    await session.refresh(pkg)
    return pkg


async def redeem_credits(session: AsyncSession, user: User, package_id: str) -> dict[str, Any]:
    pkg = await mark_redeemed(session, user.id, package_id, kind="credits")
    balance = await add_credits(
        session,
        user.id,
        int(pkg.credits),
        reason="package",
        ref_id=pkg.id,
        note=f"{package_name(pkg.code)} package",
    )
    pkg.redeemed_ref = pkg.id
    await session.flush()
    logger.info("store_credits_redeemed", user_id=user.id, package_id=pkg.id, credits=pkg.credits)
    return {"balance": balance, "package": (await _serialize(session, [pkg]))[0]}


async def users_by_email(session: AsyncSession, email: str) -> User | None:
    return (await session.execute(select(User).where(func.lower(User.email) == email))).scalar_one_or_none()


async def gift(session: AsyncSession, user: User, package_id: str, raw_email: str) -> dict[str, Any]:
    """Hand a held package to someone by email. Unknown emails get it when they sign up."""
    email = normalize_email(raw_email)
    if email is None:
        raise StoreError(f"{(raw_email or '').strip() or 'An empty value'} is not a valid email address.")
    if email == (user.email or "").lower():
        raise StoreError("That is your own email. The package is already yours.")
    await _owned_held(session, user.id, package_id)
    recipient = await users_by_email(session, email)
    if recipient is not None and recipient.is_admin:
        raise StoreError("Admin accounts cannot hold packages.")
    if recipient is not None and not recipient.is_active:
        raise StoreError("That account is disabled.")
    result = await session.execute(
        update(UserPackage)
        .where(UserPackage.id == package_id, UserPackage.owner_user_id == user.id, UserPackage.status == "held")
        .values(
            owner_user_id=recipient.id if recipient else None,
            owner_email=None if recipient else email,
            source="gift",
            gifted_from_user_id=user.id,
            updated_at=utcnow(),
        )
    )
    if not result.rowcount:
        raise StoreError("This package was already used.")
    pkg = await session.get(UserPackage, package_id)
    await session.refresh(pkg)
    logger.info("store_package_gifted", user_id=user.id, package_id=package_id, registered=recipient is not None)
    return (await _serialize(session, [pkg]))[0]


async def cancel_gift(session: AsyncSession, user: User, package_id: str) -> dict[str, Any]:
    """Take back a gift nobody has claimed yet (the email has no account)."""
    pkg = await session.get(UserPackage, package_id)
    if pkg is None or pkg.gifted_from_user_id != user.id:
        raise StoreNotFound()
    result = await session.execute(
        update(UserPackage)
        .where(
            UserPackage.id == package_id,
            UserPackage.gifted_from_user_id == user.id,
            UserPackage.owner_user_id.is_(None),
            UserPackage.status == "held",
        )
        .values(owner_user_id=user.id, owner_email=None, updated_at=utcnow())
    )
    if not result.rowcount:
        raise StoreError("The recipient already has this package.")
    await session.refresh(pkg)
    return (await _serialize(session, [pkg]))[0]


# ── Admin ──────────────────────────────────────────────────────────────────


def _catalog_item(code: str, quantity: int) -> CatalogItem:
    item = CATALOG.get(code)
    if item is None:
        raise StoreError("Unknown package.")
    if not 1 <= quantity <= MAX_GRANT_QUANTITY:
        raise StoreError(f"Grant between 1 and {MAX_GRANT_QUANTITY} of each package at a time.")
    return item


def _clean_note(note: str | None) -> str | None:
    text = " ".join((note or "").split())
    return text[:300] or None


def _new_packages(
    item: CatalogItem,
    quantity: int,
    *,
    admin_id: str,
    owner: User | None,
    email: str | None,
    note: str | None,
) -> list[UserPackage]:
    return [
        UserPackage(
            id=str(uuid.uuid4()),
            code=item.code,
            kind=item.kind,
            credits=item.credits,
            price_cents=item.price_cents,
            owner_user_id=owner.id if owner else None,
            owner_email=None if owner else email,
            status="held",
            source="admin_grant",
            granted_by_user_id=admin_id,
            note=note,
        )
        for _ in range(quantity)
    ]


async def grant(
    session: AsyncSession,
    admin_id: str,
    recipient: User,
    code: str,
    quantity: int = 1,
    note: str | None = None,
) -> list[dict[str, Any]]:
    item = _catalog_item(code, quantity)
    if recipient.is_admin:
        raise StoreError("Admin accounts cannot hold packages.")
    packages = _new_packages(item, quantity, admin_id=admin_id, owner=recipient, email=None, note=_clean_note(note))
    session.add_all(packages)
    await session.flush()
    logger.info("store_admin_grant", admin_id=admin_id, user_id=recipient.id, code=code, quantity=quantity)
    return await _serialize(session, packages)


@dataclass
class Recipient:
    email: str
    user: User | None


def split_recipients(raw: list[str]) -> tuple[list[str], list[dict[str, str]]]:
    """Normalized unique emails in input order, plus the entries that are not emails."""
    emails: list[str] = []
    invalid: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in raw:
        for part in re.split(r"[\s,;]+", value or ""):
            if not part.strip():
                continue
            email = normalize_email(part)
            if email is None:
                invalid.append({"email": part.strip()[:255], "reason": "Not a valid email address."})
            elif email not in seen:
                seen.add(email)
                emails.append(email)
    return emails, invalid


def classify_recipients(
    emails: list[str], accounts: dict[str, User]
) -> tuple[list[Recipient], list[dict[str, str]]]:
    """Who can receive packages. Unknown emails are fine: they claim at signup."""
    targets: list[Recipient] = []
    skipped: list[dict[str, str]] = []
    for email in emails:
        user = accounts.get(email)
        if user is not None and user.is_admin:
            skipped.append({"email": email, "reason": "Admin accounts cannot hold packages."})
        elif user is not None and not user.is_active:
            skipped.append({"email": email, "reason": "This account is disabled."})
        else:
            targets.append(Recipient(email=email, user=user))
    return targets, skipped


async def grant_many(
    session: AsyncSession,
    admin_id: str,
    raw_recipients: list[str],
    items: list[tuple[str, int]],
    note: str | None = None,
) -> dict[str, Any]:
    """Give the same set of packages to every recipient in one transaction."""
    if not items:
        raise StoreError("Pick at least one package.")
    catalog_items = [(_catalog_item(code, quantity), quantity) for code, quantity in items]
    emails, invalid = split_recipients(raw_recipients)
    if len(emails) > MAX_GRANT_RECIPIENTS:
        raise StoreError(f"Grant to at most {MAX_GRANT_RECIPIENTS} people at a time.")
    accounts: dict[str, User] = {}
    if emails:
        rows = await session.execute(select(User).where(func.lower(User.email).in_(emails)))
        accounts = {(u.email or "").lower(): u for u in rows.scalars()}
    targets, skipped = classify_recipients(emails, accounts)
    if not targets:
        raise StoreError(
            "Nobody on that list can receive packages." if emails or invalid else "Add at least one recipient."
        )
    clean_note = _clean_note(note)
    granted: list[dict[str, Any]] = []
    total = 0
    for target in targets:
        packages: list[UserPackage] = []
        for item, quantity in catalog_items:
            packages += _new_packages(
                item, quantity, admin_id=admin_id, owner=target.user, email=target.email, note=clean_note
            )
        session.add_all(packages)
        total += len(packages)
        granted.append(
            {
                "email": target.email,
                "user": _person(target.user),
                "pending": target.user is None,
                "count": len(packages),
            }
        )
    await session.flush()
    logger.info(
        "store_admin_grant_many",
        admin_id=admin_id,
        recipients=len(targets),
        packages=total,
        codes=[item.code for item, _ in catalog_items],
    )
    return {"granted": granted, "skipped": skipped + invalid, "total_packages": total}


async def revoke(session: AsyncSession, admin_id: str, package_id: str, reason: str | None) -> dict[str, Any]:
    """Pull back an unused package. Used packages already became credits or a team space."""
    pkg = await session.get(UserPackage, package_id)
    if pkg is None:
        raise StoreNotFound()
    now = utcnow()
    result = await session.execute(
        update(UserPackage)
        .where(UserPackage.id == package_id, UserPackage.status == "held")
        .values(
            status="revoked",
            revoked_at=now,
            revoked_by_user_id=admin_id,
            revoke_reason=_clean_note(reason),
            updated_at=now,
        )
    )
    if not result.rowcount:
        raise StoreError(
            "This package was already revoked." if pkg.status == "revoked" else "This package was already used."
        )
    await session.refresh(pkg)
    logger.info("store_admin_revoke", admin_id=admin_id, package_id=package_id, code=pkg.code)
    return (await admin_serialize(session, [pkg]))[0]


async def admin_serialize(session: AsyncSession, packages: list[UserPackage]) -> list[dict[str, Any]]:
    base = await _serialize(session, packages)
    admins = await _people(
        session,
        {p.granted_by_user_id for p in packages} | {p.revoked_by_user_id for p in packages},
    )
    out = []
    for pkg, data in zip(packages, base):
        out.append(
            {
                **data,
                "note": pkg.note,
                "pending_email": pkg.owner_email if pkg.owner_user_id is None else None,
                "granted_by": _person(admins.get(pkg.granted_by_user_id or "")),
                "revoked_at": _iso(pkg.revoked_at),
                "revoked_by": _person(admins.get(pkg.revoked_by_user_id or "")),
                "revoke_reason": pkg.revoke_reason,
            }
        )
    return out


ADMIN_STATUSES = ("held", "waiting", "redeemed", "revoked")


def _status_clause(status: str | None):
    if status == "held":
        return (UserPackage.status == "held") & UserPackage.owner_user_id.isnot(None)
    if status == "waiting":
        return (UserPackage.status == "held") & UserPackage.owner_user_id.is_(None)
    if status in ("redeemed", "revoked"):
        return UserPackage.status == status
    return None


async def admin_packages(
    session: AsyncSession,
    *,
    status: str | None = None,
    code: str | None = None,
    source: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    owner = User.__table__.alias("owner")
    stmt = select(UserPackage).outerjoin(owner, owner.c.id == UserPackage.owner_user_id)
    clauses = []
    if (clause := _status_clause(status)) is not None:
        clauses.append(clause)
    if code:
        clauses.append(UserPackage.code == code)
    if source:
        clauses.append(UserPackage.source == source)
    term = (q or "").strip().lower()
    if term:
        like = f"%{term}%"
        clauses.append(
            or_(
                func.lower(owner.c.email).like(like),
                func.lower(func.coalesce(owner.c.name, "")).like(like),
                func.lower(func.coalesce(owner.c.name_first, "") + " " + func.coalesce(owner.c.name_last, "")).like(
                    like
                ),
                func.lower(func.coalesce(UserPackage.owner_email, "")).like(like),
                UserPackage.id == term,
            )
        )
    if clauses:
        stmt = stmt.where(*clauses)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = await session.execute(
        stmt.order_by(UserPackage.updated_at.desc(), UserPackage.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 200)))
    )
    return {"total": int(total or 0), "items": await admin_serialize(session, list(rows.scalars()))}


TREND_DAYS = 14


async def admin_overview(session: AsyncSession) -> dict[str, Any]:
    """Store-wide totals for the admin Packages page."""
    waiting = UserPackage.owner_user_id.is_(None)
    rows = await session.execute(
        select(UserPackage.code, UserPackage.status, waiting.label("waiting"), func.count(), func.sum(UserPackage.credits))
        .group_by(UserPackage.code, UserPackage.status, waiting)
    )
    by_code: dict[str, dict[str, int]] = {
        c.code: {"held": 0, "waiting": 0, "redeemed": 0, "revoked": 0} for c in CATALOG.values()
    }
    totals = {"held": 0, "waiting": 0, "redeemed": 0, "revoked": 0}
    unused_credits = 0
    for code, status_, is_waiting, count, credits in rows.all():
        bucket = "waiting" if status_ == "held" and is_waiting else status_
        if bucket not in totals:
            continue
        by_code.setdefault(code, {"held": 0, "waiting": 0, "redeemed": 0, "revoked": 0})[bucket] += int(count)
        totals[bucket] += int(count)
        if status_ == "held":
            unused_credits += int(credits or 0)

    granted_value = (
        await session.execute(
            select(func.coalesce(func.sum(UserPackage.price_cents), 0)).where(
                UserPackage.source == "admin_grant", UserPackage.status != "revoked"
            )
        )
    ).scalar_one()
    balances = (
        await session.execute(
            select(func.coalesce(func.sum(User.credit_balance), 0), func.count())
            .where(User.is_admin.is_(False), User.credit_balance > 0)
        )
    ).one()
    holders = (
        await session.execute(
            select(func.count(func.distinct(UserPackage.owner_user_id))).where(
                UserPackage.status == "held", UserPackage.owner_user_id.isnot(None)
            )
        )
    ).scalar_one()
    spaces = (await session.execute(select(func.count()).select_from(TeamSpace))).scalar_one()

    since = (utcnow() - timedelta(days=TREND_DAYS - 1)).date()
    day = func.date(UserPackage.created_at)
    trend_rows = await session.execute(
        select(day, func.count())
        .where(UserPackage.source == "admin_grant", UserPackage.created_at >= datetime.combine(since, datetime.min.time()))
        .group_by(day)
    )
    per_day = {str(d): int(n) for d, n in trend_rows.all()}
    trend = [
        {"date": (since + timedelta(days=i)).isoformat(), "count": per_day.get((since + timedelta(days=i)).isoformat(), 0)}
        for i in range(TREND_DAYS)
    ]
    return {
        "totals": totals,
        "by_code": by_code,
        "unused_credits": unused_credits,
        "granted_value_cents": int(granted_value or 0),
        "credit_balance_total": int(balances[0] or 0),
        "users_with_credits": int(balances[1] or 0),
        "holders": int(holders or 0),
        "team_spaces": int(spaces or 0),
        "grant_trend": trend,
        "catalog": catalog_public(),
    }


async def admin_summary(session: AsyncSession, user: User) -> dict[str, Any]:
    held = await session.execute(
        select(UserPackage.code, func.count())
        .where(UserPackage.owner_user_id == user.id, UserPackage.status == "held")
        .group_by(UserPackage.code)
    )
    spaces = await session.execute(
        select(func.count()).select_from(TeamSpace).where(TeamSpace.owner_user_id == user.id)
    )
    packages = await session.execute(
        select(UserPackage)
        .where(UserPackage.owner_user_id == user.id, UserPackage.status == "held")
        .order_by(UserPackage.created_at.desc())
        .limit(100)
    )
    return {
        "balance": int(user.credit_balance or 0),
        "held": {code: int(n) for code, n in held.all()},
        "held_packages": await admin_serialize(session, list(packages.scalars())),
        "team_spaces": int(spaces.scalar_one() or 0),
        "ledger": await ledger(session, user.id, limit=10),
        "catalog": catalog_public(),
    }


async def admin_adjust(session: AsyncSession, admin_id: str, user: User, delta: int, note: str | None) -> int:
    if delta == 0:
        raise StoreError("Enter a non-zero amount.")
    if user.is_admin:
        raise StoreError("Admin accounts do not use credits.")
    try:
        return await add_credits(
            session,
            user.id,
            delta,
            reason="admin_adjust",
            ref_id=admin_id,
            note=(note or "").strip() or "Adjusted by an admin",
        )
    except StoreError as e:
        raise StoreError("That would take the balance below zero.") from e
