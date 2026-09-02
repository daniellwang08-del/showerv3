"""Tests for global country preferences: catalog, generalized classifier,
and resume country auto-detection."""

import pytest

from app.services.country_catalog import (
    DIAL_CODE_TO_COUNTRY,
    REGION_GROUPS,
    country_display_name,
    describe_country_list,
    normalize_country_input,
    normalize_country_preferences,
)
from app.services.job_location_classifier import (
    CountryMatchVerdict,
    LocationVerdict,
    classify_job_location,
    classify_job_location_for_countries,
    detect_countries_in_text,
    keeps_preferred_job_pool,
)
from app.services.resume_parse_service import infer_country_preferences


# ── Country catalog ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("US", "US"),
        ("us", "US"),
        ("United States", "US"),
        ("united kingdom", "GB"),
        ("UK", "GB"),
        ("Deutschland", None),  # non-English aliases are not supported
        ("Germany", "DE"),
        ("south korea", "KR"),
        ("", None),
        (None, None),
        ("Atlantis", None),
    ],
)
def test_normalize_country_input(raw, expected):
    assert normalize_country_input(raw) == expected


def test_normalize_country_preferences_dedupes_and_normalizes():
    assert normalize_country_preferences(["us", "USA", "Canada", "CA"]) == ["US", "CA"]


def test_normalize_country_preferences_rejects_unknown():
    with pytest.raises(ValueError):
        normalize_country_preferences(["US", "Narnia"])


def test_normalize_country_preferences_empty_means_no_filter():
    assert normalize_country_preferences(None) == []
    assert normalize_country_preferences([]) == []


def test_region_groups_contain_expected_members():
    assert "DE" in REGION_GROUPS["eu"]
    assert "GB" not in REGION_GROUPS["eu"]  # post-Brexit
    assert "GB" in REGION_GROUPS["europe"]
    assert "IN" in REGION_GROUPS["apac"]
    assert "BR" in REGION_GROUPS["latam"]
    assert REGION_GROUPS["north america"] == frozenset({"US", "CA", "MX"})


def test_display_and_describe():
    assert country_display_name("de") == "Germany"
    assert describe_country_list(["US", "CA"]) == "United States, Canada"


def test_dial_codes_map_to_supported_countries():
    from app.services.country_catalog import COUNTRY_NAMES

    for code in DIAL_CODE_TO_COUNTRY.values():
        assert code in COUNTRY_NAMES


# ── Generalized classifier ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("location", "allowed", "expected"),
    [
        # UK user
        ("London, UK", {"GB"}, CountryMatchVerdict.MATCH),
        ("Manchester, England", {"GB"}, CountryMatchVerdict.MATCH),
        ("Austin, TX", {"GB"}, CountryMatchVerdict.NO_MATCH),
        ("Paris, France", {"GB"}, CountryMatchVerdict.NO_MATCH),
        # Canadian user with subdivision-only location
        ("Toronto, Ontario", {"CA"}, CountryMatchVerdict.MATCH),
        ("Toronto, Ontario", {"US"}, CountryMatchVerdict.NO_MATCH),
        # Multi-country segment: inclusion wins within the segment
        ("United States or Canada", {"CA"}, CountryMatchVerdict.MATCH),
        ("United States or Canada", {"US"}, CountryMatchVerdict.MATCH),
        ("United States or Canada", {"DE"}, CountryMatchVerdict.NO_MATCH),
        # Region tokens
        ("Remote - EU", {"DE"}, CountryMatchVerdict.MATCH),
        ("Remote - EU", {"US"}, CountryMatchVerdict.NO_MATCH),
        ("APAC", {"IN"}, CountryMatchVerdict.MATCH),
        ("LATAM", {"BR"}, CountryMatchVerdict.MATCH),
        # Worldwide is always eligible
        ("Remote - Worldwide", {"NG"}, CountryMatchVerdict.MATCH),
        # Ambiguous stays unknown (kept visible)
        ("Remote", {"DE"}, CountryMatchVerdict.UNKNOWN),
        (None, {"DE"}, CountryMatchVerdict.UNKNOWN),
    ],
)
def test_classify_for_countries(location, allowed, expected):
    verdict, _detail = classify_job_location_for_countries(
        location, allowed_countries=allowed
    )
    assert verdict == expected


def test_empty_preference_list_disables_filtering():
    verdict, detail = classify_job_location_for_countries(
        "Paris, France", allowed_countries=[]
    )
    assert verdict == CountryMatchVerdict.MATCH
    assert "no country preference" in detail


def test_multi_segment_outside_wins():
    # Historical policy preserved: an explicit outside segment hides the job
    # even when another segment matches.
    verdict, _ = classify_job_location_for_countries(
        "New York, NY | Paris, France", allowed_countries={"US"}
    )
    assert verdict == CountryMatchVerdict.NO_MATCH


def test_keeps_preferred_pool_semantics():
    keep, verdict, _ = keeps_preferred_job_pool(
        "Berlin, Germany", allowed_countries={"DE"}
    )
    assert keep and verdict == CountryMatchVerdict.MATCH

    keep, verdict, _ = keeps_preferred_job_pool(
        "Berlin, Germany", allowed_countries={"US"}
    )
    assert not keep and verdict == CountryMatchVerdict.NO_MATCH

    # Unknown locations are kept
    keep, verdict, _ = keeps_preferred_job_pool("Remote", allowed_countries={"US"})
    assert keep and verdict == CountryMatchVerdict.UNKNOWN


def test_unrecognized_comma_region_only_strict_for_us_only():
    # Historical US-only behavior: unrecognized "City, Region" is foreign.
    verdict_us, _ = classify_job_location_for_countries(
        "غزة, فلسطين", allowed_countries={"US"}
    )
    # Non-latin region does not look like a region name → unknown even for US.
    assert verdict_us == CountryMatchVerdict.UNKNOWN

    verdict_us2, _ = classify_job_location_for_countries(
        "Springfield, Genovia", allowed_countries={"US"}
    )
    assert verdict_us2 == CountryMatchVerdict.NO_MATCH

    # For non-US preference sets the same input stays unknown (kept).
    verdict_de, _ = classify_job_location_for_countries(
        "Springfield, Genovia", allowed_countries={"DE"}
    )
    assert verdict_de == CountryMatchVerdict.UNKNOWN


def test_legacy_us_wrapper_unchanged():
    verdict, _ = classify_job_location("San Francisco, CA")
    assert verdict == LocationVerdict.US
    verdict, _ = classify_job_location("Paris, France")
    assert verdict == LocationVerdict.NON_US
    verdict, _ = classify_job_location("Remote")
    assert verdict == LocationVerdict.UNKNOWN


# ── Free-text country detection (resume locations) ───────────────────────────


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Berlin, Germany", ["DE"]),
        ("Austin, TX", ["US"]),
        ("Toronto, Ontario", ["CA"]),
        ("London", []),  # bare city, no country signal
        ("Singapore", ["SG"]),
        ("Remote", []),
        (None, []),
    ],
)
def test_detect_countries_in_text(text, expected):
    assert detect_countries_in_text(text) == expected


# ── Resume country inference ─────────────────────────────────────────────────


class _Block:
    def __init__(self, location=None):
        self.location = location


class _Draft:
    def __init__(self, work=None, edu=None, phone_country_code=None):
        self.work_experience = work or []
        self.education = edu or []
        self.phone_country_code = phone_country_code


def test_infer_from_work_locations_most_recent_first():
    draft = _Draft(
        work=[_Block("Berlin, Germany"), _Block("Austin, TX")],
        edu=[_Block("Toronto, Ontario")],
    )
    assert infer_country_preferences(draft) == ["DE", "US", "CA"]


def test_infer_caps_at_three():
    draft = _Draft(
        work=[
            _Block("Berlin, Germany"),
            _Block("Paris, France"),
            _Block("London, UK"),
            _Block("Madrid, Spain"),
        ]
    )
    assert infer_country_preferences(draft) == ["DE", "FR", "GB"]


def test_infer_phone_fallback_only_without_locations():
    draft = _Draft(phone_country_code="+44")
    assert infer_country_preferences(draft) == ["GB"]

    # Location signal wins over the phone code.
    draft = _Draft(work=[_Block("Sydney, Australia")], phone_country_code="+44")
    assert infer_country_preferences(draft) == ["AU"]


def test_infer_empty_draft():
    assert infer_country_preferences(_Draft()) == []
