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
from datetime import datetime
from typing import Any

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import CreditLedgerEntry, TeamSpace, User, UserPackage

logger = get_logger(__name__)

SIGNUP_CREDITS = 50
MAX_GRANT_QUANTITY = 20
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
        .where(UserPackage.owner_user_id.is_(None), UserPackage.owner_email == email)
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


async def grant(
    session: AsyncSession,
    admin_id: str,
    recipient: User,
    code: str,
    quantity: int = 1,
) -> list[dict[str, Any]]:
    item = CATALOG.get(code)
    if item is None:
        raise StoreError("Unknown package.")
    if not 1 <= quantity <= MAX_GRANT_QUANTITY:
        raise StoreError(f"Grant between 1 and {MAX_GRANT_QUANTITY} at a time.")
    if recipient.is_admin:
        raise StoreError("Admin accounts cannot hold packages.")
    packages = [
        UserPackage(
            id=str(uuid.uuid4()),
            code=item.code,
            kind=item.kind,
            credits=item.credits,
            price_cents=item.price_cents,
            owner_user_id=recipient.id,
            status="held",
            source="admin_grant",
            granted_by_user_id=admin_id,
        )
        for _ in range(quantity)
    ]
    session.add_all(packages)
    await session.flush()
    logger.info("store_admin_grant", admin_id=admin_id, user_id=recipient.id, code=code, quantity=quantity)
    return await _serialize(session, packages)


async def admin_summary(session: AsyncSession, user: User) -> dict[str, Any]:
    held = await session.execute(
        select(UserPackage.code, func.count())
        .where(UserPackage.owner_user_id == user.id, UserPackage.status == "held")
        .group_by(UserPackage.code)
    )
    spaces = await session.execute(
        select(func.count()).select_from(TeamSpace).where(TeamSpace.owner_user_id == user.id)
    )
    return {
        "balance": int(user.credit_balance or 0),
        "held": {code: int(n) for code, n in held.all()},
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
