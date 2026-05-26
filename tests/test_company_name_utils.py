"""Tests for company name normalization and matching."""

from app.utils.company_name_utils import company_names_match, normalize_company_name


def test_normalize_company_name_strips_suffixes():
    assert normalize_company_name("Acme Corp.") == normalize_company_name("Acme Corporation")
    assert normalize_company_name("Example LLC") == "example"


def test_company_names_match_exact():
    assert company_names_match("Google", "Google")
    assert company_names_match("Meta Platforms Inc", "Meta Platforms")


def test_company_names_match_fuzzy():
    assert company_names_match("Stripe, Inc.", "Stripe")
    assert company_names_match("Amazon Web Services", "Amazon")


def test_company_names_match_empty():
    assert company_names_match("", "Acme") is False
    assert company_names_match(None, "Acme") is False
