"""Subscription billing: plans, Stripe Checkout, Customer Portal, and webhooks.

Payment details never touch this server — checkout runs in Stripe's embedded
form (an iframe mounted in the billing page) and the Customer Portal is hosted
by Stripe. Entitlement is driven entirely by signed webhook events, which are
the only writer of "active/canceled" truth.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.api.routes import get_current_user
from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.billing import plans as plan_catalog
from app.services.billing import stripe_service, subscription_service
from app.storage.database import get_session
from app.storage.user_repository import UserRepository

logger = get_logger(__name__)

router = APIRouter(prefix="/billing", tags=["billing"])


class CheckoutRequest(BaseModel):
    plan: str


def _billing_base_url() -> str:
    """Absolute URL of the SPA billing page Stripe returns the user to."""
    settings = get_settings()
    explicit = (settings.stripe_billing_return_url or "").strip()
    if explicit:
        return explicit.rstrip("/")
    frontend = (settings.frontend_url or "").strip().rstrip("/")
    if frontend:
        return f"{frontend}/billing"
    return "http://localhost:5173/billing"


# ── entitlement dependency (opt-in gate for premium routes) ──────────────────

async def require_active_subscription(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Gate a route behind an active subscription.

    Admins always pass (they run the platform, not a subscription). Apply with
    ``Depends(require_active_subscription)`` on any route that should be
    subscriber-only. Not wired onto existing routes by default.
    """
    if current_user.get("is_admin"):
        return current_user
    user_id = current_user.get("user_id")
    async with get_session() as session:
        row = await subscription_service.get_subscription_row(session, user_id)
    if not subscription_service.subscription_is_active(row):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="An active subscription is required for this feature.",
        )
    return current_user


# ── read endpoints ───────────────────────────────────────────────────────────

@router.get("/plans")
async def list_plans(current_user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    user_id = current_user.get("user_id")
    async with get_session() as session:
        row = await subscription_service.get_subscription_row(session, user_id)
    return {
        "configured": stripe_service.billing_configured(),
        "publishable_key": (settings.stripe_publishable_key or "").strip() or None,
        "plans": plan_catalog.catalog(settings),
        "subscription": subscription_service.serialize_subscription(row),
    }


@router.get("/subscription")
async def get_subscription(current_user: dict = Depends(get_current_user)) -> dict:
    user_id = current_user.get("user_id")
    async with get_session() as session:
        row = await subscription_service.get_subscription_row(session, user_id)
    return {
        "subscription": subscription_service.serialize_subscription(row),
        "is_active": subscription_service.subscription_is_active(row),
    }


# ── checkout / portal ────────────────────────────────────────────────────────

@router.post("/checkout")
async def create_checkout(
    body: CheckoutRequest, current_user: dict = Depends(get_current_user)
) -> dict:
    if not stripe_service.billing_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Billing is not configured yet. Please try again later.",
        )

    plan = plan_catalog.get_plan(body.plan)
    if plan is None:
        raise HTTPException(status_code=400, detail="Unknown plan")

    settings = get_settings()
    price_id = plan.price_id(settings)
    if not price_id:
        raise HTTPException(
            status_code=400,
            detail=f"The {plan.name} plan is not available yet.",
        )

    user_id = current_user.get("user_id")
    base = _billing_base_url()

    try:
        async with get_session() as session:
            repo = UserRepository(session)
            user = await repo.get_by_id(user_id)
            if user is None:
                raise HTTPException(status_code=404, detail="User not found")
            # Block a second subscription when one is already active.
            existing = await subscription_service.get_subscription_row(session, user_id)
            if subscription_service.subscription_is_active(existing):
                raise HTTPException(
                    status_code=400,
                    detail="You already have an active subscription. Use Manage billing to change plans.",
                )
            customer_id = await subscription_service.get_or_create_customer_id(session, user)
            await session.commit()

        checkout = await stripe_service.create_checkout_session(
            customer_id=customer_id,
            price_id=price_id,
            user_id=user_id,
            plan_slug=plan.slug,
            # Embedded checkout: Stripe navigates the top window here once the
            # in-page form completes. No cancel_url in embedded mode.
            return_url=f"{base}?status=success&session_id={{CHECKOUT_SESSION_ID}}",
        )
    except stripe_service.BillingNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:  # Stripe API / network failure
        logger.warning("stripe_checkout_failed", user_id=user_id, error=str(e))
        raise HTTPException(
            status_code=502, detail="Could not start checkout. Please try again."
        ) from e

    client_secret = checkout.get("client_secret")
    if not client_secret:
        raise HTTPException(
            status_code=502, detail="Stripe did not return a checkout client secret."
        )
    return {"client_secret": client_secret, "session_id": checkout.get("id")}


@router.post("/portal")
async def create_portal(current_user: dict = Depends(get_current_user)) -> dict:
    if not stripe_service.billing_configured():
        raise HTTPException(status_code=503, detail="Billing is not configured yet.")

    user_id = current_user.get("user_id")
    async with get_session() as session:
        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found")
        customer_id = (getattr(user, "stripe_customer_id", "") or "").strip()

    if not customer_id:
        raise HTTPException(
            status_code=400,
            detail="No billing account yet. Subscribe to a plan first.",
        )

    try:
        portal = await stripe_service.create_billing_portal_session(
            customer_id=customer_id, return_url=_billing_base_url()
        )
    except stripe_service.BillingNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.warning("stripe_portal_failed", user_id=user_id, error=str(e))
        raise HTTPException(
            status_code=502, detail="Could not open the billing portal. Please try again."
        ) from e

    url = portal.get("url")
    if not url:
        raise HTTPException(status_code=502, detail="Stripe did not return a portal URL.")
    return {"url": url}


# ── webhook (unauthenticated; signature-verified) ────────────────────────────

# Subscription-shaped events all flow through the same upsert; the checkout
# event resolves + stores the subscription behind a completed session.
_SUBSCRIPTION_EVENTS = frozenset(
    {
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    }
)


@router.post("/webhook")
async def stripe_webhook(request: Request) -> dict:
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe_service.construct_webhook_event(payload, sig_header)
    except stripe_service.BillingNotConfiguredError as e:
        logger.error("stripe_webhook_not_configured", error=str(e))
        raise HTTPException(status_code=503, detail="Webhook not configured") from e
    except Exception as e:  # invalid signature / malformed payload
        logger.warning("stripe_webhook_invalid", error=str(e))
        raise HTTPException(status_code=400, detail="Invalid webhook signature") from e

    event_type = event.get("type", "")
    data_object = (event.get("data") or {}).get("object") or {}

    try:
        async with get_session() as session:
            if event_type == "checkout.session.completed":
                await subscription_service.sync_from_checkout_session(session, data_object)
            elif event_type in _SUBSCRIPTION_EVENTS:
                await subscription_service.upsert_subscription_from_stripe(session, data_object)
            else:
                logger.debug("stripe_webhook_ignored", event_type=event_type)
                return {"received": True, "handled": False}
            await session.commit()
    except Exception as e:
        # Return 500 so Stripe retries a transient failure (e.g. DB blip).
        logger.error("stripe_webhook_processing_failed", event_type=event_type, error=str(e))
        raise HTTPException(status_code=500, detail="Webhook processing failed") from e

    logger.info("stripe_webhook_handled", event_type=event_type)
    return {"received": True, "handled": True}
