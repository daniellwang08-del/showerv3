"""Rippling / UKG pages: fields come from the job record the page embeds.

Fixtures mirror the live payloads of
ats.rippling.com/genlogs-corporation/jobs/e1efa400-...,
ats.rippling.com/fullthrottle1/jobs/8ff782c8-... and
oneinc.rec.pro.ukg.net/.../OpportunityDetail?opportunityId=50f54ce3-...
"""

import asyncio
import json

from app.extractors.embedded_job_data_extractor import (
    EmbeddedJobDataExtractor,
    format_pay_range,
    parse_embedded_job,
)
from app.services.extraction_service import _fill_structured_gaps
from app.services.job_content_cleaner import (
    plain_text_from_document_html,
    plain_text_from_fragment_html,
)
from app.services.job_metadata_hydrator import build_metadata
from app.services.metadata_vector_extractor import _looks_like_title, generate_span_candidates

RIPPLING_URL = "https://ats.rippling.com/fullthrottle1/jobs/8ff782c8-5c8e-4bbc-8ea2-eb6ee9f5505e"
UKG_URL = (
    "https://oneinc.rec.pro.ukg.net/one1500onei/JobBoard/cab513e3-84a7-4143-9bd8-dcb9e005acfe/"
    "OpportunityDetail?opportunityId=50f54ce3-b739-4ae5-a2b3-ccdc4174b8b2"
)
_BODY = "<p>You will build and scale the AI platform. " + "Ship reliable systems. " * 20 + "</p>"


def _rippling_html(**post_overrides) -> str:
    post = {
        "uuid": "8ff782c8-5c8e-4bbc-8ea2-eb6ee9f5505e",
        "name": "AI Platform Engineer",
        "workLocations": ["Remote (United States)"],
        "department": {"name": "Ft.ai Application Development", "base_department": "Ft.ai Engineering"},
        "employmentType": {"label": "SALARIED_FT", "id": "Salaried, full-time"},
        "createdOn": "2026-06-18T11:43:10.687000-07:00",
        "payRangeDetails": [],
        "companyName": "Fullthrottle.ai",
        "description": {"company": "<p>About fullthrottle.ai</p>", "role": _BODY},
    }
    post.update(post_overrides)
    data = {
        "props": {
            "pageProps": {
                "apiData": {
                    "jobBoard": {"title": "Fullthrottle.ai", "companyName": "Fullthrottle.ai"},
                    "jobPost": post,
                }
            }
        }
    }
    # Minified like the live page: no whitespace between block elements.
    return (
        "<html><head><title>AI Platform Engineer</title></head><body>"
        "<div><h1>AI Platform Engineer</h1><div><p>About fullthrottle.ai</p></div></div>"
        f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script>'
        "</body></html>"
    )


def _ukg_html(**overrides) -> str:
    opp = {
        "Id": "50f54ce3-b739-4ae5-a2b3-ccdc4174b8b2",
        "Title": "Site Reliability Engineer",
        "FullTime": True,
        "JobCategoryName": "Development",
        "Locations": [
            {
                "LocalizedName": "Remote",
                "Address": {"City": None, "State": None, "Country": {"Name": "United States", "Code": "USA"}},
            }
        ],
        "PostedDate": "2026-10-01T15:47:39.763Z",
        "Description": "<p><strong>Position Title:</strong> Site Reliability Engineer</p>" + _BODY,
        "JobBoardMemberships": [{"PublishedExternal": True, "ExternalPostedDate": "2026-10-05T17:55:35.069Z"}],
        "PayRangeVisible": True,
        "PayRange": {"PayRangeMinimum": "115000.00", "PayRangeMaximum": "120000.00"},
        "PayRangeCurrencyCode": "USD",
    }
    opp.update(overrides)
    return (
        '<html><body><a class="navbar-brand" href="https://www.oneinc.com/">'
        '<img class="small-logo logo" src="/x" alt="One Inc" data-automation="navbar-small-logo" /></a>'
        "<p>You are using an unsupported browser.</p><script>$(function () {"
        f"var opportunity = new US.Opportunity.CandidateOpportunityDetail({json.dumps(opp)});"
        "});</script></body></html>"
    )


def test_rippling_next_data_fields():
    source, fields, description = parse_embedded_job(_rippling_html())
    assert source == "rippling"
    assert fields["title"] == "AI Platform Engineer"
    assert fields["company"] == "Fullthrottle.ai"
    assert fields["location"] == "Remote (United States)"
    assert fields["workplace"] == "remote"
    assert fields["posted_date"] == "2026-06-18"
    assert description.startswith("About fullthrottle.ai")


def test_rippling_multiple_locations_and_pay():
    html = _rippling_html(
        workLocations=["New York, NY", "Remote (United States)"],
        payRangeDetails=[{"rangeStart": 150000, "rangeEnd": 180000, "currency": "USD", "frequency": "YEAR"}],
    )
    _source, fields, _desc = parse_embedded_job(html)
    assert fields["location"] == "New York, NY; Remote (United States)"
    assert fields["salary_range"] == "$150,000 - $180,000 USD"


def test_ukg_opportunity_fields():
    source, fields, description = parse_embedded_job(_ukg_html())
    assert source == "ukg"
    assert fields["title"] == "Site Reliability Engineer"
    assert fields["company"] == "One Inc"
    assert fields["location"] == "Remote, United States"
    assert fields["employment_type"] == "Full-time"
    assert fields["salary_range"] == "$115,000 - $120,000 USD"
    assert fields["posted_date"] == "2026-10-05"
    assert "Position Title:" in description


def test_ukg_onsite_address_and_hidden_pay():
    html = _ukg_html(
        Locations=[{"LocalizedName": "HQ", "Address": {"City": "Austin", "State": {"Code": "TX"}, "Country": {"Name": "United States"}}}],
        PayRangeVisible=False,
        FullTime=False,
    )
    _source, fields, _desc = parse_embedded_job(html)
    assert fields["location"] == "Austin, TX, United States"
    assert fields["workplace"] is None
    assert fields["salary_range"] is None
    assert fields["employment_type"] == "Part-time"


def test_extractor_end_to_end_hydrates_all_fields():
    result = asyncio.run(EmbeddedJobDataExtractor().extract(UKG_URL, _ukg_html()))
    assert result.success
    meta = build_metadata(plain_text=result.raw_content, source_url=UKG_URL, structured_data=result.structured_data)
    assert meta["title"] == "Site Reliability Engineer"
    assert meta["company"] == "One Inc"
    assert meta["location"] == "United States"
    assert meta["salary_range"] == "$115,000 - $120,000 USD"
    assert meta["employment_type"] == "Full-time"
    assert meta["work_mode"] == "remote"
    assert meta["posted_date"].date().isoformat() == "2026-10-05"


def test_page_text_winner_keeps_embedded_fields():
    html = _rippling_html()
    embedded = asyncio.run(EmbeddedJobDataExtractor().extract(RIPPLING_URL, html)).structured_data
    page_text = plain_text_from_document_html(html)
    meta = build_metadata(
        plain_text=page_text,
        source_url=RIPPLING_URL,
        structured_data=_fill_structured_gaps(None, embedded),
    )
    # Without the record the URL slug would give "Fullthrottle1" and no location.
    assert meta["company"] == "Fullthrottle.ai"
    assert meta["location"] == "United States"
    assert meta["work_mode"] == "remote"


def test_fill_structured_gaps_keeps_best_values():
    merged = _fill_structured_gaps({"title": "From JSON-LD", "location": None}, {"title": "X", "location": "Remote"})
    assert merged == {"title": "From JSON-LD", "location": "Remote"}
    assert _fill_structured_gaps(None, None) is None


def test_no_embedded_record_is_not_claimed():
    assert parse_embedded_job("<html><body><p>Plain page</p></body></html>") is None
    other_next = '<script id="__NEXT_DATA__">{"props": {"pageProps": {"post": {}}}}</script>'
    assert parse_embedded_job(other_next) is None


def test_format_pay_range_variants():
    assert format_pay_range("50", "65", "USD", per_hour=True) == "$50 - $65 USD per hour"
    assert format_pay_range(90000, None, "EUR") == "\u20ac90,000 EUR"
    assert format_pay_range(None, None, "USD") is None


def test_minified_html_keeps_block_boundaries():
    html = "<html><body><div><h1>Senior Software Engineer</h1><p>GenLogs is hiring.</p><ul><li>Go</li><li>SQL</li></ul></div></body></html>"
    text = plain_text_from_document_html(html)
    assert text.splitlines() == ["Senior Software Engineer", "GenLogs is hiring.", "Go", "SQL"]
    assert plain_text_from_fragment_html("<p>A</p><p>B <b>bold</b></p>") == "A\nB bold"


def test_span_windows_do_not_cross_lines_or_pipes():
    text = "Site Reliability Engineer | Career Opportunities\nAI Platform Engineer\nAbout fullthrottle.ai"
    spans = generate_span_candidates(text)
    assert "Site Reliability Engineer" in spans
    assert "AI Platform Engineer" in spans
    assert not any("Engineer | Career" in s or "Engineer About" in s for s in spans)


def test_glued_role_spans_are_not_titles():
    assert not _looks_like_title("Senior Software EngineerSenior")
    assert not _looks_like_title("AI Platform EngineerAI")
    assert _looks_like_title("Senior Software Engineer")
    assert _looks_like_title("DevOps Engineer")
