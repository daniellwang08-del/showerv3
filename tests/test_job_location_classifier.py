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
