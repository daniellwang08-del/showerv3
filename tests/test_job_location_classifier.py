"""Tests for structured job location classification."""

import pytest

from app.services.job_location_classifier import LocationVerdict, classify_job_location


@pytest.mark.parametrize(
    ("location", "remote_policy", "expected"),
    [
        ("San Francisco, CA", None, LocationVerdict.US),
        ("Denver, CO", None, LocationVerdict.US),
        ("United States of America", None, LocationVerdict.US),
        ("Remote - United States", None, LocationVerdict.US),
        ("Paris, France", None, LocationVerdict.NON_US),
        ("Clichy, France", None, LocationVerdict.NON_US),
        ("Issy-les-Moulineaux, France", None, LocationVerdict.NON_US),
        ("London, UK", None, LocationVerdict.NON_US),
        ("Toronto, Canada", None, LocationVerdict.NON_US),
        ("Remote", None, LocationVerdict.UNKNOWN),
        (None, None, LocationVerdict.UNKNOWN),
        ("", "Remote", LocationVerdict.UNKNOWN),
        ("Austin, TX", "Hybrid", LocationVerdict.US),
        ("Berlin, Germany", "On-site", LocationVerdict.NON_US),
    ],
)
def test_classify_job_location(location, remote_policy, expected):
    verdict, _detail = classify_job_location(location, remote_policy=remote_policy)
    assert verdict == expected


def test_classify_multi_segment_non_us_wins():
    verdict, _detail = classify_job_location("New York, NY | Paris, France")
    assert verdict == LocationVerdict.NON_US


def test_remote_policy_prose_does_not_flip_us_job_to_non_us():
    """Regression: a descriptive remote-policy sentence with a comma
    ("..., travel less than 25%") must not be read as a foreign region and
    override a valid US structured location."""
    verdict, _detail = classify_job_location(
        "Michigan, United States",
        remote_policy=(
            "Remote position with occasional travel to JR Automation or "
            "customer facilities, travel less than 25%"
        ),
    )
    assert verdict == LocationVerdict.US


def test_remote_policy_prose_alone_is_unknown_not_non_us():
    verdict, _detail = classify_job_location(
        None,
        remote_policy="Fully remote role, some travel required to meet clients",
    )
    assert verdict == LocationVerdict.UNKNOWN


def test_non_us_country_in_remote_policy_still_detected():
    verdict, _detail = classify_job_location(
        None,
        remote_policy="Remote - based in Germany",
    )
    assert verdict == LocationVerdict.NON_US


@pytest.mark.parametrize(
    ("location", "remote_policy"),
    [
        # US listed alongside another country in the same segment must stay US.
        ("United States", "Fully remote - anywhere in the US or Canada"),
        ("United States or Canada", "Fully remote from anywhere in the US or Canada"),
        ("United States", "Remote-first, with distributed teams across US, LATAM, and India"),
        ("United States (Remote)", "100% Remote, US and Canada candidates preferred"),
        ("United States", "Remote-first; 100% remote within the US or Canada (EST hours)."),
        ("Remote US and Canada", "Remote US and Canada with quarterly onsites"),
        ("Remote, United States or Canada", "Digital-first; remote in the US and Canada."),
        # Trailing "Remote" prose token must not be read as a foreign region.
        ("USA, Remote", "Remote"),
        ("United States, Remote", "100% remote, USA time zones only"),
    ],
)
def test_us_inclusive_multi_country_stays_us(location, remote_policy):
    """A posting that explicitly includes the US is US-eligible even when other
    countries are also named in the same segment."""
    verdict, _detail = classify_job_location(location, remote_policy=remote_policy)
    assert verdict == LocationVerdict.US


@pytest.mark.parametrize(
    "location",
    ["Spain", "Ireland", "Germany", "Madrid, Spain", "Ottawa, Canada", "Republic of Ireland"],
)
def test_foreign_only_remote_still_non_us(location):
    """Foreign-only postings (no US mention) remain non-US."""
    verdict, _detail = classify_job_location(location, remote_policy="Fully remote")
    assert verdict == LocationVerdict.NON_US
