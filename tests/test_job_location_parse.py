import pytest

from app.models.database import Job, JobExtraction
from app.services.job_location_classifier import detect_countries_in_text
from app.services.job_location_parse import (
    infer_location_from_text,
    location_specificity,
    prefer_job_location,
    split_work_mode_from_location,
)


@pytest.mark.parametrize(
    ("raw", "place", "mode"),
    [
        ("Remote - United States", "United States", "remote"),
        ("US Remote", "US", "remote"),
        ("United States (Remote)", "United States", "remote"),
        ("Remote: United States", "United States", "remote"),
        ("-REMOTE, USA-", "USA", "remote"),
        ("US-REMOTE", "US", "remote"),
        ("U.S. Remote", "U.S.", "remote"),
        ("Fully Remote", None, "remote"),
        ("Hybrid", None, "hybrid"),
        ("Hybrid Austin", "Austin", "hybrid"),
        ("San Francisco, California - Hybrid", "San Francisco, California", "hybrid"),
        ("New York, NY (On-site)", "New York, NY", "onsite"),
        ("Remote or In-Office in San Francisco", "San Francisco", "remote"),
        ("Chicago, IL or Remote, USA", "Chicago, IL, USA", "remote"),
        ("San Francisco Bay Area or Remote", "San Francisco Bay Area", "remote"),
        ("Palo Alto, CA (Open to US-based Remote)", "Palo Alto, CA (US)", "remote"),
        ("Second Dinner (US Remote)", "Second Dinner (US)", "remote"),
        ("NYC/Boston/Remote", "NYC / Boston", "remote"),
        (
            "Canada (Remote); Toronto, Canada (Hybrid); United States (Remote)",
            "Canada; Toronto, Canada; United States",
            "remote",
        ),
        (
            "Denver, CO - Hybrid; New York, NY - Hybrid; Toronto, Ontario - Remote",
            "Denver, CO; New York, NY; Toronto, Ontario",
            "hybrid",
        ),
        ("Winston-Salem, NC", "Winston-Salem, NC", None),
        ("Washington, D.C.", "Washington, D.C.", None),
    ],
)
def test_work_mode_words_leave_the_location(raw, place, mode):
    assert split_work_mode_from_location(raw) == (place, mode)
    if place:
        assert detect_countries_in_text(place) == detect_countries_in_text(raw)


def test_models_store_only_the_place():
    job = Job(location="Remote - US", work_mode=None)
    assert job.location == "US"
    assert job.work_mode == "remote"

    stated = Job(work_mode="hybrid", location="Remote, Canada")
    assert (stated.location, stated.work_mode) == ("Canada", "hybrid")

    extraction = JobExtraction(location="Toronto, ON (Hybrid)")
    assert extraction.location == "Toronto, ON"
    assert Job(location="Berlin, Germany").work_mode is None


def test_city_only_and_city_country():
    assert detect_countries_in_text("London") == ["GB"]
    assert detect_countries_in_text("Berlin, Germany") == ["DE"]
    assert detect_countries_in_text("San Francisco, CA") == ["US"]
    assert detect_countries_in_text("Toronto") == ["CA"]
    assert detect_countries_in_text("Remote, United States") == ["US"]
    assert detect_countries_in_text("Bengaluru") == ["IN"]
    assert detect_countries_in_text("Amsterdam / Berlin") == ["DE", "NL"]


def test_region_overrides_city_default():
    assert detect_countries_in_text("Paris, TX") == ["US"]
    assert detect_countries_in_text("London, ON") == ["CA"]
    assert detect_countries_in_text("Paris") == ["FR"]
    assert detect_countries_in_text("Berlin, DE") == ["DE"]
    assert infer_location_from_text("This role is based in Dublin, Ireland. Apply today.") == "Dublin, Ireland"


def test_prefer_keeps_specific_over_remote():
    assert prefer_job_location("San Francisco, CA, United States", "Remote") == (
        "San Francisco, CA, United States"
    )
    assert prefer_job_location("Remote", "London, UK") == "London, UK"
    assert prefer_job_location(None, "Berlin") == "Berlin"
    assert location_specificity("San Francisco, CA") > location_specificity("Remote, United States")


def test_infer_from_labeled_and_based_in():
    text = """Title: Engineer
Location: Munich, Germany
Company: Acme

We are a team based in collaboration and trust.
"""
    assert infer_location_from_text(text) == "Munich, Germany"

    body = "This role is based in Dublin, Ireland. Apply today."
    assert infer_location_from_text(body) == "Dublin, Ireland"
