"""Who may use NAO: every active account an admin has not blocked.

Signup is open. A new account is "approved" the moment it is created and gets
the welcome credits (see ``store_service.grant_signup_bonus``). The only way an
account loses access is an admin action: "rejected" blocks sign in, and
``is_active = False`` disables the account. "pending" is a legacy value from
when admins approved signups; it is treated like "approved" everywhere so an
account created during a deploy is never stuck.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import User

logger = get_logger(__name__)

APPROVAL_PENDING = "pending"
APPROVAL_APPROVED = "approved"
APPROVAL_REJECTED = "rejected"
APPROVAL_STATUSES = (APPROVAL_PENDING, APPROVAL_APPROVED, APPROVAL_REJECTED)


def is_blocked(user: User | None) -> bool:
    return bool(user is not None and user.approval_status == APPROVAL_REJECTED)


def can_use_app_clause():
    """SQL filter for accounts allowed to do work: active and not blocked.

    Background fan-outs (auto-prepare, job source syncs, encodings) and people
    pickers must use this, not ``is_active`` alone, or blocked accounts keep
    receiving jobs and spending AI credit.
    """
    return and_(User.is_active.is_(True), User.approval_status != APPROVAL_REJECTED)


def can_use_app(user: User | None) -> bool:
    return bool(user is not None and user.is_active and not is_blocked(user))


def utcnow() -> datetime:
    """Naive UTC, matching how every DateTime column in this schema is stored."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def approve_user(session: AsyncSession, user: User, *, admin_id: str) -> None:
    """Lift a block."""
    user.approval_status = APPROVAL_APPROVED
    user.approved_at = utcnow()
    user.approved_by = admin_id
    await session.flush()
    logger.info("signup_approved", user_id=user.id, by=admin_id)


async def reject_user(session: AsyncSession, user: User, *, admin_id: str) -> None:
    """Block sign in and end every open session."""
    user.approval_status = APPROVAL_REJECTED
    user.approved_at = None
    user.approved_by = admin_id
    user.sessions_valid_after = utcnow()
    await session.flush()
    logger.info("signup_rejected", user_id=user.id, by=admin_id)
