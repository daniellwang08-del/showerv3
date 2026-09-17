"""Thin async wrapper around the Stripe SDK.

Stripe's Python SDK is synchronous; every network call here is dispatched to a
worker thread so it never blocks the event loop. Import of the SDK is lazy so a
deployment that leaves billing unconfigured pays nothing at startup.

This module is intentionally free of database and HTTP-framework concerns — it
only talks to Stripe. Persisting the results is the subscription service's job.
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


class BillingNotConfiguredError(RuntimeError):
    """Raised when a Stripe call is attempted without a configured secret key."""


def billing_configured() -> bool:
    return bool((get_settings().stripe_secret_key or "").strip())


def _stripe():
    """Return the Stripe module with the API key bound, or raise if unconfigured."""
    settings = get_settings()
    secret = (settings.stripe_secret_key or "").strip()
    if not secret:
        raise BillingNotConfiguredError(
            "Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing."
        )
    import stripe  # lazy: keeps startup fast when billing is unused

    stripe.api_key = secret
    # Pin the app identifier so events are attributable in the Stripe dashboard.
    stripe.set_app_info("Atomspace", version=settings.app_version)
    return stripe


async def create_customer(*, email: str, user_id: str) -> str:
    """Create a Stripe customer for a user and return its id."""

    def _run() -> str:
        stripe = _stripe()
        customer = stripe.Customer.create(
            email=email,
            metadata={"user_id": user_id},
        )
        return customer["id"]

    customer_id = await asyncio.to_thread(_run)
    logger.info("stripe_customer_created", user_id=user_id, customer_id=customer_id)
    return customer_id


async def create_checkout_session(
    *,
    customer_id: str,
    price_id: str,
    user_id: str,
    plan_slug: str,
    success_url: str,
    cancel_url: str,
) -> dict[str, Any]:
    """Create a subscription-mode Checkout Session and return it."""

    def _run() -> dict[str, Any]:
        stripe = _stripe()
        session = stripe.checkout.Session.create(
            mode="subscription",
            customer=customer_id,
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,
            client_reference_id=user_id,
            # Attach identity to BOTH the session and the resulting subscription
            # so any webhook can resolve the owner without a DB lookup by email.
            metadata={"user_id": user_id, "plan": plan_slug},
            subscription_data={"metadata": {"user_id": user_id, "plan": plan_slug}},
            allow_promotion_codes=True,
        )
        return dict(session)

    session = await asyncio.to_thread(_run)
    logger.info(
        "stripe_checkout_session_created",
        user_id=user_id,
        plan=plan_slug,
        session_id=session.get("id"),
    )
    return session


async def create_billing_portal_session(
    *, customer_id: str, return_url: str
) -> dict[str, Any]:
    """Create a Customer Portal session (manage/cancel/update payment)."""

    def _run() -> dict[str, Any]:
        stripe = _stripe()
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )
        return dict(session)

    return await asyncio.to_thread(_run)


async def retrieve_subscription(subscription_id: str) -> dict[str, Any]:
    """Fetch a subscription object from Stripe."""

    def _run() -> dict[str, Any]:
        stripe = _stripe()
        return dict(stripe.Subscription.retrieve(subscription_id))

    return await asyncio.to_thread(_run)


def construct_webhook_event(payload: bytes, sig_header: str) -> dict[str, Any]:
    """Verify a webhook signature and return the parsed event.

    Synchronous by design: it is pure HMAC verification + JSON parsing (no
    network), and the caller already has the raw request body in hand.
    """
    settings = get_settings()
    secret = (settings.stripe_webhook_secret or "").strip()
    if not secret:
        raise BillingNotConfiguredError(
            "STRIPE_WEBHOOK_SECRET is not set; refusing to trust unsigned events."
        )
    import stripe

    event = stripe.Webhook.construct_event(payload, sig_header, secret)
    return dict(event)
