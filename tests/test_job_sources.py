"""Unit tests for per-user job sources: board detection + listing parsers."""

from __future__ import annotations

import pytest

from app.services.job_source_boards import (
    _parse_ashby,
    _parse_greenhouse,
    _parse_lever,
    _parse_workable,
    detect_board,
)


# ── Board detection ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url,ats,token",
    [
        ("https://boards.greenhouse.io/stripe", "greenhouse", "stripe"),
        ("https://boards.greenhouse.io/stripe/jobs/123456", "greenhouse", "stripe"),
        ("https://job-boards.greenhouse.io/datadog", "greenhouse", "datadog"),
        ("boards.greenhouse.io/openai", "greenhouse", "openai"),
        ("https://boards-api.greenhouse.io/v1/boards/acme/jobs", "greenhouse", "acme"),
        ("https://jobs.lever.co/netflix", "lever", "netflix"),
        ("https://jobs.eu.lever.co/spotify/12ab34", "lever", "spotify"),
        ("https://jobs.ashbyhq.com/linear", "ashby", "linear"),
        (
            "https://jobs.ashbyhq.com/openai/1111aaaa-2222-3333-4444-555566667777",
            "ashby",
            "openai",
        ),
        ("https://apply.workable.com/deel/", "workable", "deel"),
        ("https://apply.workable.com/acme-inc/j/ABC123/", "workable", "acme-inc"),
    ],
)
def test_detect_board_supported(url: str, ats: str, token: str):
    board = detect_board(url)
    assert board is not None
    assert board.ats_type == ats
    assert board.token == token


@pytest.mark.parametrize(
    "url",
    [
        "https://careers.google.com/jobs",
        "https://www.linkedin.com/jobs/view/123",
        "https://example.com",
        "not a url at all",
        "",
    ],
)
def test_detect_board_unsupported(url: str):
    assert detect_board(url) is None


# ── Listing parsers ─────────────────────────────────────────────────────────


def test_parse_greenhouse_listing():
    payload = {
        "jobs": [
            {
                "absolute_url": "https://boards.greenhouse.io/acme/jobs/1",
                "title": "Senior Backend Engineer",
                "location": {"name": "Remote - US"},
                "company_name": "Acme",
            },
            {"absolute_url": "", "title": "no url — skipped"},
            "not-a-dict",
        ]
    }
    listing = _parse_greenhouse(payload, "acme")
    assert len(listing.jobs) == 1
    job = listing.jobs[0]
    assert job.url.endswith("/jobs/1")
    assert job.title == "Senior Backend Engineer"
    assert job.location == "Remote - US"
    assert job.company == "Acme"


def test_parse_lever_listing():
    payload = [
        {
            "hostedUrl": "https://jobs.lever.co/acme/uuid-1",
            "text": "Staff Engineer",
            "categories": {"location": "London, UK"},
        },
        {"text": "missing url"},
    ]
    listing = _parse_lever(payload, "acme")
    assert len(listing.jobs) == 1
    assert listing.jobs[0].title == "Staff Engineer"
    assert listing.jobs[0].location == "London, UK"
    assert listing.jobs[0].company == "acme"


def test_parse_ashby_listing():
    payload = {
        "name": "Linear",
        "jobs": [
            {
                "jobUrl": "https://jobs.ashbyhq.com/linear/uuid-1",
                "title": "Product Engineer",
                "location": "Remote",
            }
        ],
    }
    listing = _parse_ashby(payload, "linear")
    assert listing.company == "Linear"
    assert len(listing.jobs) == 1
    assert listing.jobs[0].company == "Linear"


def test_parse_workable_listing_builds_url_from_shortcode():
    payload = {
        "name": "Deel",
        "jobs": [
            {"shortcode": "AB12CD", "title": "Payroll Engineer", "city": "Berlin",
             "country": "Germany"},
            {"url": "https://apply.workable.com/deel/j/XYZ/", "title": "Designer"},
        ],
    }
    listing = _parse_workable(payload, "deel")
    assert len(listing.jobs) == 2
    assert listing.jobs[0].url == "https://apply.workable.com/deel/j/AB12CD/"
    assert listing.jobs[0].location == "Berlin, Germany"
    assert listing.jobs[1].url.endswith("/j/XYZ/")


def test_parse_empty_payloads():
    assert _parse_greenhouse({}, "x").jobs == []
    assert _parse_lever([], "x").jobs == []
    assert _parse_ashby({}, "x").jobs == []
    assert _parse_workable({}, "x").jobs == []
