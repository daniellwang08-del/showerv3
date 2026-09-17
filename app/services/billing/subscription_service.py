"""Persist and interpret the local mirror of each user's Stripe subscription.

Stripe is authoritative. Everything here either (a) writes what Stripe told us
(checkout result or webhook event) into ``user_subscriptions``, or (b) reads
that mirror to answer "is this user entitled right now?" without calling Stripe.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import User, UserSubscription
from app.services.billing import plans as plan_catalog
from app.services.billing import stripe_service

logger = get_logger(__name__)

# Statuses Stripe considers "the customer currently has access".
ACTIVE_STATUSES = frozenset({"active", "trialing"})


# ── low-level reads ──────────────────────────────────────────────────────────

async def get_subscription_row(
    session: AsyncSession, user_id: str
) -> UserSubscription | None:
    result = await session.execute(
        select(UserSubscription).where(UserSubscription.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def _find_user_id_for_customer(
    session: AsyncSession, customer_id: str | None
) -> str | None:
    if not customer_id:
        return None
    result = await session.execute(
        select(User.id).where(User.stripe_customer_id == customer_id)
    )
    return result.scalar_one_or_none()


# ── Stripe customer lifecycle ────────────────────────────────────────────────

async def get_or_create_customer_id(session: AsyncSession, user: User) -> str:
    """Return the user's Stripe customer id, creating + persisting it if absent."""
    existing = (getattr(user, "stripe_customer_id", "") or "").strip()
    if existing:
        return existing

    customer_id = await stripe_service.create_customer(
        email=user.email, user_id=user.id
    )
    user.stripe_customer_id = customer_id
    await session.flush()
    return customer_id


# ── writing subscription state ───────────────────────────────────────────────

def _period_end_to_dt(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OSError):
        return None


def _extract_price_id(sub: dict[str, Any]) -> str | None:
    items = (sub.get("items") or {}).get("data") or []
    if items:
        price = items[0].get("price") or {}
        pid = price.get("id")
        if pid:
            return str(pid)
    # Fallback for older shapes that expose `plan.id`.
    plan = sub.get("plan") or {}
    return plan.get("id")


async def upsert_subscription_from_stripe(
    session: AsyncSession, sub: dict[str, Any]
) -> UserSubscription | None:
    """Create/update the local mirror from a Stripe subscription object.

    Returns the row, or ``None`` when the owning user cannot be resolved
    (e.g. a subscription created outside this app).
    """
    customer_id = sub.get("customer")
    if isinstance(customer_id, dict):
        customer_id = customer_id.get("id")

    metadata = sub.get("metadata") or {}
    user_id = (metadata.get("user_id") or "").strip() or None
    if not user_id:
        user_id = await _find_user_id_for_customer(session, customer_id)
    if not user_id:
        logger.warning(
            "stripe_subscription_unresolved_user",
            subscription_id=sub.get("id"),
            customer_id=customer_id,
        )
        return None

    price_id = _extract_price_id(sub)
    plan = plan_catalog.plan_for_price_id(price_id or "")
    plan_slug = plan.slug if plan else (metadata.get("plan") or None)

    row = await get_subscription_row(session, user_id)
    if row is None:
        row = UserSubscription(user_id=user_id)
        session.add(row)

    row.stripe_customer_id = customer_id or row.stripe_customer_id
    row.stripe_subscription_id = sub.get("id") or row.stripe_subscription_id
    row.plan = plan_slug
    row.price_id = price_id
    row.status = str(sub.get("status") or "incomplete")
    row.current_period_end = _period_end_to_dt(sub.get("current_period_end"))
    row.cancel_at_period_end = bool(sub.get("cancel_at_period_end"))
    await session.flush()

    logger.info(
        "stripe_subscription_synced",
        user_id=user_id,
        subscription_id=row.stripe_subscription_id,
        status=row.status,
        plan=row.plan,
    )
    return row


async def sync_from_checkout_session(
    session: AsyncSession, checkout_session: dict[str, Any]
) -> UserSubscription | None:
    """Resolve the subscription behind a completed Checkout Session and store it."""
    subscription_id = checkout_session.get("subscription")
    if isinstance(subscription_id, dict):
        subscription_id = subscription_id.get("id")
    if not subscription_id:
        return None

    sub = await stripe_service.retrieve_subscription(str(subscription_id))
    # Checkout metadata carries the user id even if subscription_data didn't.
    if not (sub.get("metadata") or {}).get("user_id"):
        ref = checkout_session.get("client_reference_id") or (
            checkout_session.get("metadata") or {}
        ).get("user_id")
        if ref:
            sub.setdefault("metadata", {})
            sub["metadata"]["user_id"] = ref
    return await upsert_subscription_from_stripe(session, sub)


# ── entitlement + serialization ──────────────────────────────────────────────

def subscription_is_active(row: UserSubscription | None) -> bool:
    if row is None:
        return False
    if row.status not in ACTIVE_STATUSES:
        return False
    # A canceled-at-period-end subscription is still active until the period ends.
    if row.current_period_end is not None:
        return row.current_period_end >= datetime.utcnow()
    return True


def serialize_subscription(row: UserSubscription | None) -> dict[str, Any] | None:
    if row is None:
        return None
    plan = plan_catalog.get_plan(row.plan or "")
    return {
        "plan": row.plan,
        "plan_name": plan.name if plan else None,
        "status": row.status,
        "is_active": subscription_is_active(row),
        "cancel_at_period_end": bool(row.cancel_at_period_end),
        "current_period_end": (
            row.current_period_end.replace(tzinfo=timezone.utc).isoformat()
            if row.current_period_end
            else None
        ),
    }


async def public_state(session: AsyncSession, user_id: str) -> dict[str, Any]:
    """Compact subscription state embedded in /auth/me for the SPA + nav gating."""
    row = await get_subscription_row(session, user_id)
    active = subscription_is_active(row)
    return {
        "is_subscribed": active,
        "subscription_plan": row.plan if row else None,
        "subscription_status": row.status if row else None,
        "subscription_current_period_end": (
            row.current_period_end.replace(tzinfo=timezone.utc)
            if row and row.current_period_end
            else None
        ),
        "subscription_cancel_at_period_end": bool(row.cancel_at_period_end) if row else False,
    }
