"""Subscription plan catalog.

The *charge* is always whatever the Stripe Price says — these entries only
drive display and map a plan slug to the settings field holding its Price id.
Keeping the amounts here lets the pricing page render before Stripe is even
configured, and lets the webhook translate a Price id back into a plan slug.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings, get_settings


@dataclass(frozen=True)
class Plan:
    slug: str
    name: str
    tagline: str
    # Attribute on Settings holding this plan's Stripe Price id.
    price_setting: str
    # Display amount in the smallest currency unit (cents). Source of truth for
    # the actual charge is the Stripe Price, not this number.
    amount_cents: int
    currency: str
    # Billing cadence, mirrored from how the Stripe Price is configured.
    interval: str  # "week" | "month" | "year"
    interval_count: int

    @property
    def amount_display(self) -> str:
        whole = self.amount_cents // 100
        cents = self.amount_cents % 100
        symbol = "$" if self.currency.lower() == "usd" else ""
        if cents:
            return f"{symbol}{whole}.{cents:02d}"
        return f"{symbol}{whole}"

    @property
    def period_label(self) -> str:
        if self.interval_count == 1:
            return f"per {self.interval}"
        return f"every {self.interval_count} {self.interval}s"

    def price_id(self, settings: Settings | None = None) -> str:
        settings = settings or get_settings()
        return (getattr(settings, self.price_setting, "") or "").strip()

    def as_dict(self, settings: Settings | None = None) -> dict:
        return {
            "slug": self.slug,
            "name": self.name,
            "tagline": self.tagline,
            "amount_cents": self.amount_cents,
            "amount_display": self.amount_display,
            "currency": self.currency,
            "interval": self.interval,
            "interval_count": self.interval_count,
            "period_label": self.period_label,
            # True only when an admin has wired a Stripe Price id for this plan.
            "available": bool(self.price_id(settings)),
        }


# Order here is the order shown on the pricing page.
PLANS: tuple[Plan, ...] = (
    Plan(
        slug="trial",
        name="Trial",
        tagline="Billed $20/week. Try Atomspace, cancel anytime.",
        price_setting="stripe_price_trial",
        amount_cents=2000,
        currency="usd",
        interval="week",
        interval_count=1,
    ),
    Plan(
        slug="monthly",
        name="Monthly",
        tagline="Billed every month at $120/mo. Cancel anytime.",
        price_setting="stripe_price_monthly",
        amount_cents=12000,
        currency="usd",
        interval="month",
        interval_count=1,
    ),
    Plan(
        slug="quarterly",
        name="Quarterly",
        tagline="Billed $300 every 3 months — save to $100/mo.",
        price_setting="stripe_price_quarterly",
        amount_cents=30000,
        currency="usd",
        interval="month",
        interval_count=3,
    ),
    Plan(
        slug="yearly",
        name="Yearly",
        tagline="Billed $500 a year — best value at ~$42/mo.",
        price_setting="stripe_price_yearly",
        amount_cents=50000,
        currency="usd",
        interval="year",
        interval_count=1,
    ),
)

_BY_SLUG: dict[str, Plan] = {p.slug: p for p in PLANS}


def get_plan(slug: str) -> Plan | None:
    return _BY_SLUG.get((slug or "").strip().lower())


def plan_for_price_id(price_id: str, settings: Settings | None = None) -> Plan | None:
    """Reverse-map a Stripe Price id to a plan slug (used by the webhook)."""
    if not price_id:
        return None
    settings = settings or get_settings()
    target = price_id.strip()
    for plan in PLANS:
        if plan.price_id(settings) == target:
            return plan
    return None


def catalog(settings: Settings | None = None) -> list[dict]:
    settings = settings or get_settings()
    return [p.as_dict(settings) for p in PLANS]
