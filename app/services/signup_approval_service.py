"""Approval-gated signup: admin approval, rejection, and one-time access keys.

A new account starts "pending". It becomes "approved" when an admin approves
it or when the user redeems an access key the admin issued for that account.
Keys are 10 characters from an unambiguous alphabet (no 0/O, 1/I/L), about
50 bits of entropy, bound to one user, single use, and expire at an
admin-chosen time. Only an HMAC keyed with the server secret is stored, so a
database leak alone cannot be brute-forced offline.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import SignupAccessKey, User

logger = get_logger(__name__)

APPROVAL_PENDING = "pending"
APPROVAL_APPROVED = "approved"
APPROVAL_REJECTED = "rejected"
APPROVAL_STATUSES = (APPROVAL_PENDING, APPROVAL_APPROVED, APPROVAL_REJECTED)

KEY_LENGTH = 10
KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
MIN_KEY_LIFETIME = timedelta(minutes=10)
MAX_KEY_LIFETIME = timedelta(days=365)


def can_use_app_clause():
    """SQL filter for accounts allowed to do work: active and approved.

    Background fan-outs (auto-prepare, job source syncs, encodings) must use
    this, not ``is_active`` alone, or pending and rejected signups keep
    receiving jobs and spending AI credit without ever signing in.
    """
    return and_(User.is_active.is_(True), User.approval_status == APPROVAL_APPROVED)


def can_use_app(user: User | None) -> bool:
    return bool(
        user is not None
        and user.is_active
        and (user.approval_status or APPROVAL_APPROVED) == APPROVAL_APPROVED
    )


def utcnow() -> datetime:
    """Naive UTC, matching how every DateTime column in this schema is stored."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def to_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def generate_access_key() -> str:
    """10 characters with at least one letter and one digit, from `secrets`."""
    while True:
        key = "".join(secrets.choice(KEY_ALPHABET) for _ in range(KEY_LENGTH))
        if any(c.isdigit() for c in key) and any(c.isalpha() for c in key):
            return key


def normalize_access_key(raw: str) -> str:
    """Keys are case-insensitive; spaces and dashes people add while copying are ignored."""
    return "".join(ch for ch in (raw or "").upper() if ch.isalnum())


def hash_access_key(key: str) -> str:
    secret = get_settings().auth_secret_key.encode("utf-8")
    return hmac.new(secret, f"signup-key:{key}".encode("utf-8"), hashlib.sha256).hexdigest()


def validate_expiry(expires_at: datetime) -> datetime:
    """Return the expiry as naive UTC, or raise ValueError when out of range."""
    value = to_naive_utc(expires_at)
    now = utcnow()
    if value < now + MIN_KEY_LIFETIME:
        raise ValueError("Expiry must be at least 10 minutes from now")
    if value > now + MAX_KEY_LIFETIME:
        raise ValueError("Expiry cannot be more than 365 days from now")
    return value


async def revoke_open_keys(session: AsyncSession, user_id: str) -> int:
    result = await session.execute(
        update(SignupAccessKey)
        .where(
            SignupAccessKey.user_id == user_id,
            SignupAccessKey.used_at.is_(None),
            SignupAccessKey.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )
    return int(result.rowcount or 0)


async def issue_access_key(
    session: AsyncSession, user: User, *, expires_at: datetime, admin_id: str
) -> tuple[str, SignupAccessKey]:
    """Create a key for a pending user. Returns the plaintext (shown once) and the row."""
    if user.approval_status != APPROVAL_PENDING:
        raise ValueError("Access keys can only be issued for pending signups")
    expiry = validate_expiry(expires_at)
    await revoke_open_keys(session, user.id)
    key = generate_access_key()
    row = SignupAccessKey(
        user_id=user.id,
        key_hash=hash_access_key(key),
        created_by=admin_id,
        expires_at=expiry,
    )
    session.add(row)
    await session.flush()
    logger.info("signup_access_key_issued", user_id=user.id, by=admin_id, expires_at=expiry.isoformat())
    return key, row


async def active_keys_by_user(session: AsyncSession, user_ids: list[str]) -> dict[str, SignupAccessKey]:
    """The newest usable key per user (unused, unrevoked, unexpired)."""
    if not user_ids:
        return {}
    rows = (
        await session.execute(
            select(SignupAccessKey)
            .where(
                SignupAccessKey.user_id.in_(user_ids),
                SignupAccessKey.used_at.is_(None),
                SignupAccessKey.revoked_at.is_(None),
                SignupAccessKey.expires_at > utcnow(),
            )
            .order_by(SignupAccessKey.created_at.desc())
        )
    ).scalars().all()
    out: dict[str, SignupAccessKey] = {}
    for row in rows:
        out.setdefault(row.user_id, row)
    return out


def _mark_approved(user: User, by: str | None) -> None:
    user.approval_status = APPROVAL_APPROVED
    user.approved_at = utcnow()
    user.approved_by = by


async def approve_user(session: AsyncSession, user: User, *, admin_id: str) -> None:
    _mark_approved(user, admin_id)
    await revoke_open_keys(session, user.id)
    await session.flush()
    logger.info("signup_approved", user_id=user.id, by=admin_id)


async def reject_user(session: AsyncSession, user: User, *, admin_id: str) -> None:
    user.approval_status = APPROVAL_REJECTED
    user.approved_at = None
    user.approved_by = admin_id
    user.sessions_valid_after = utcnow()
    await revoke_open_keys(session, user.id)
    await session.flush()
    logger.info("signup_rejected", user_id=user.id, by=admin_id)


async def redeem_access_key(session: AsyncSession, user: User, raw_key: str) -> bool:
    """Approve `user` if `raw_key` is their valid key. The row lock makes a key single use."""
    key = normalize_access_key(raw_key)
    if len(key) != KEY_LENGTH or user.approval_status != APPROVAL_PENDING:
        return False
    digest = hash_access_key(key)
    row = (
        await session.execute(
            select(SignupAccessKey)
            .where(
                SignupAccessKey.user_id == user.id,
                SignupAccessKey.key_hash == digest,
                SignupAccessKey.used_at.is_(None),
                SignupAccessKey.revoked_at.is_(None),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None or not hmac.compare_digest(row.key_hash, digest):
        return False
    if row.expires_at <= utcnow():
        return False
    row.used_at = utcnow()
    _mark_approved(user, row.created_by)
    await session.flush()
    logger.info("signup_access_key_redeemed", user_id=user.id, key_id=row.id)
    return True
