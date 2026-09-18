"""Unit tests for the billing plan catalog and entitlement logic (no Stripe/DB)."""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

from app.services.billing.plans import (
    PLANS,
    catalog,
    get_plan,
    plan_for_price_id,
)
from app.services.billing.subscription_service import (
    serialize_subscription,
    subscription_is_active,
)


def _settings_with_prices() -> SimpleNamespace:
    return SimpleNamespace(
        stripe_price_monthly="price_m",
        stripe_price_quarterly="price_q",
        stripe_price_yearly="price_y",
    )


def test_catalog_has_three_expected_plans() -> None:
    slugs = [p.slug for p in PLANS]
    assert slugs == ["monthly", "quarterly", "yearly"]


def test_plan_amounts_and_cadence() -> None:
    monthly = get_plan("monthly")
    quarterly = get_plan("quarterly")
    yearly = get_plan("yearly")

    assert monthly is not None and monthly.amount_cents == 12000
    assert monthly.interval == "month" and monthly.interval_count == 1
    assert monthly.amount_display == "$120"

    assert quarterly is not None and quarterly.amount_cents == 30000
    assert quarterly.interval == "month" and quarterly.interval_count == 3
    assert quarterly.period_label == "every 3 months"

    assert yearly is not None and yearly.amount_cents == 50000
    assert yearly.interval == "year" and yearly.interval_count == 1
    assert yearly.amount_display == "$500"


def test_get_plan_is_case_insensitive_and_unknown_is_none() -> None:
    assert get_plan("MONTHLY").slug == "monthly"
    assert get_plan("  yearly ").slug == "yearly"
    assert get_plan("weekly") is None
    assert get_plan("") is None


def test_plan_for_price_id_reverse_maps() -> None:
    settings = _settings_with_prices()
    assert plan_for_price_id("price_q", settings).slug == "quarterly"
    assert plan_for_price_id("price_y", settings).slug == "yearly"
    assert plan_for_price_id("price_unknown", settings) is None
    assert plan_for_price_id("", settings) is None


def test_catalog_marks_availability_from_configured_prices() -> None:
    configured = {p["slug"]: p["available"] for p in catalog(_settings_with_prices())}
    assert configured == {"monthly": True, "quarterly": True, "yearly": True}

    none_configured = SimpleNamespace(
        stripe_price_monthly="",
        stripe_price_quarterly="",
        stripe_price_yearly="",
    )
    unavailable = {p["slug"]: p["available"] for p in catalog(none_configured)}
    assert unavailable == {"monthly": False, "quarterly": False, "yearly": False}


def _sub(status: str, *, period_end=None, cancel=False, plan="monthly") -> SimpleNamespace:
    return SimpleNamespace(
        status=status,
        current_period_end=period_end,
        cancel_at_period_end=cancel,
        plan=plan,
    )


def test_subscription_is_active_rules() -> None:
    future = datetime.utcnow() + timedelta(days=5)
    past = datetime.utcnow() - timedelta(days=5)

    assert subscription_is_active(None) is False
    assert subscription_is_active(_sub("active", period_end=future)) is True
    assert subscription_is_active(_sub("trialing", period_end=future)) is True
    # Access holds until the period actually ends, even after cancel is scheduled.
    assert subscription_is_active(_sub("active", period_end=future, cancel=True)) is True
    # Expired period is not active even if status still reads active.
    assert subscription_is_active(_sub("active", period_end=past)) is False
    assert subscription_is_active(_sub("canceled", period_end=future)) is False
    assert subscription_is_active(_sub("past_due", period_end=future)) is False
    # No period end recorded yet but active -> entitled.
    assert subscription_is_active(_sub("active", period_end=None)) is True


def test_serialize_subscription() -> None:
    assert serialize_subscription(None) is None

    future = datetime.utcnow() + timedelta(days=10)
    payload = serialize_subscription(_sub("active", period_end=future, plan="yearly"))
    assert payload is not None
    assert payload["plan"] == "yearly"
    assert payload["plan_name"] == "Yearly"
    assert payload["status"] == "active"
    assert payload["is_active"] is True
    assert payload["cancel_at_period_end"] is False
    assert payload["current_period_end"] is not None
