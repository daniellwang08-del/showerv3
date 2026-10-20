"""The posting's own location and workplace reach the Jobs table.

Covers Workday cxs (remoteType, additionalLocations), Oracle Recruiting Cloud,
multiline ``Location:`` headers, "City, ST, Country" scoring, and the rule
that a declared posting location beats an aggregator feed's stored guess.
"""

import json

import pytest

from app.extractors.oracle_hcm_extractor import (
    OracleHcmExtractor,
    company_from_site_name,
    is_oracle_hcm_job_url,
    parse_oracle_hcm_url,
)
from app.extractors.workday_extractor import (
    WorkdayExtractor,
    _cxs_locations,
    _cxs_remote_type,
)
from app.services.job_location_parse import location_specificity, prefer_job_location
from app.services.job_metadata_hydrator import build_metadata, parse_labeled_metadata

WORKDAY_CXS = {
    "jobPostingInfo": {
        "title": "Senior Software Engineer - Capacity Management",
        "location": "Palo Alto, CA",
        "additionalLocations": ["Dallas, TX", "Bethesda, MD", "Seattle, WA"],
        "remoteType": "Hybrid",
        "timeType": "Full time",
        "jobReqId": "R0065291",
        "jobDescription": "<p>Build capacity planning systems for our cloud platform. " + "x" * 200 + "</p>",
    },
}

ORACLE_ITEM = {
    "Id": "25747",
    "Title": "Cloud Engineer III",
    "JobSchedule": "Full time",
    "ExternalPostedStartDate": "2026-09-03T19:59:54+00:00",
    "PrimaryLocation": "United States",
    "WorkplaceType": "Remote",
    "WorkplaceTypeCode": "ORA_REMOTE",
    "LegalEmployer": None,
    "secondaryLocations": [{"Name": "Austin, TX, United States"}],
    "otherWorkLocations": [],
    "ExternalDescriptionStr": "<p>Analyze and forecast cloud hosting costs across platforms. " + "y" * 200 + "</p>",
}

NETAPP_TEXT = """Software Engineer
Location:
Morrisville, NC, US
Requisition ID:
136454
Job Summary
As a Software Engineer, your responsibilities will include developing and maintaining cloud-based solutions.
"""


# ── Location scoring and labeled headers ────────────────────────────────────


def test_city_state_country_outscores_city_state():
    assert location_specificity("Morrisville, NC, US") == 4
    assert location_specificity("Durham, NC") == 3
    assert prefer_job_location("Durham, NC", "Morrisville, NC, US") == "Morrisville, NC, US"


def test_multiline_location_stops_at_next_header():
    assert parse_labeled_metadata(NETAPP_TEXT)["location"] == "Morrisville, NC, US"


def test_multiline_location_keeps_several_places():
    text = "Location:\nHyderabad, IN\nRemote, IN\nCompany:\nSyniti\n"
    out = parse_labeled_metadata(text)
    assert out["location"] == "Hyderabad, IN, Remote, IN"
    assert out["company"] == "Syniti"


def test_multiline_location_ignores_prose():
    text = "Location:\nAs a Software Engineer, your responsibilities will include developing cloud solutions.\n"
    assert "location" not in parse_labeled_metadata(text)


# ── Page beats aggregator feed ──────────────────────────────────────────────


def test_posting_location_beats_feed_location():
    meta = build_metadata(plain_text=NETAPP_TEXT, existing_location="Durham, NC")
    assert meta["location"] == "Morrisville, NC, US"
    assert meta["location_from_page"] is True


def test_feed_location_kept_when_posting_declares_none():
    meta = build_metadata(plain_text="Software Engineer\n\nBuild things.", existing_location="Durham, NC")
    assert meta["location"] == "Durham, NC"
    assert meta["location_from_page"] is False


@pytest.mark.parametrize(
    ("stored", "declared"),
    [
        ("New York, NY", "New York"),
        ("London or Stockholm", "London"),
        ("West Coast USA", "USA"),
        ("Chicago, IL", "IL-Chicago"),
        ("United States", "US"),
    ],
)
def test_stored_location_kept_when_it_refines_the_posting(stored, declared):
    meta = build_metadata(
        plain_text="Title: Engineer\n\nBuild things.",
        structured_data={"location": declared},
        existing_location=stored,
    )
    assert meta["location"] == stored


@pytest.mark.parametrize(
    ("stored", "declared"),
    [("Durham, NC", "Morrisville, NC, US"), ("Helsinki, Finland", "United States"), ("Palo Alto, CA", "Palo Alto, CA / Dallas, TX")],
)
def test_posting_location_replaces_a_different_place(stored, declared):
    meta = build_metadata(
        plain_text="Title: Engineer\n\nBuild things.",
        structured_data={"location": declared},
        existing_location=stored,
    )
    assert meta["location"] == declared


def test_location_block_stops_at_call_to_action():
    text = "Location:\nBangor, ME\nSTART YOUR APPLICATION\n\nBuild things."
    assert parse_labeled_metadata(text)["location"] == "Bangor, ME"


def test_stale_dropdown_loses_to_location_and_body_together():
    body = "Title: Engineer\n\nWHEN & WHERE YOU'LL WORK: This position is fully remote within the United States."
    meta = build_metadata(plain_text=body, structured_data={"workplace": "Hybrid", "location": "California Remote"})
    assert meta["work_mode"] == "remote"
    # The dropdown alone, or with only one agreeing signal, still wins.
    meta = build_metadata(plain_text="Title: Engineer\n\nBuild things.",
                          structured_data={"workplace": "Hybrid", "location": "Remote - Texas, United States"})
    assert meta["work_mode"] == "hybrid"


def test_run_on_page_text_is_not_a_location():
    text = (
        "Location: RemoteSchedule: Full-time; Eastern Time core hours of 10:00 a.m. to 4:00 p.m."
        "Citizenship: U.S. citizenship required\n\nBuild things."
    )
    meta = build_metadata(plain_text=text, existing_location="Washington, DC")
    assert meta["location"] == "Washington, DC"
    assert meta["location_from_page"] is False


def test_city_location_without_work_mode_is_onsite():
    meta = build_metadata(plain_text="Title: Engineer\n\nBuild things.", structured_data={"location": "Austin, TX"})
    assert meta["work_mode"] == "onsite"


@pytest.mark.parametrize(
    ("location", "body", "existing", "expected"),
    [
        ("United States", "Build things.", None, None),
        ("Anywhere", "Build things.", None, None),
        ("Austin, TX", "This role is fully remote.", None, "remote"),
        ("Austin, TX", "Build things.", "remote", "remote"),
    ],
)
def test_city_onsite_fallback_only_without_a_mode(location, body, existing, expected):
    meta = build_metadata(
        plain_text=f"Title: Engineer\n\n{body}",
        structured_data={"location": location},
        existing_work_mode=existing,
    )
    assert meta["work_mode"] == expected


def test_llm_unknown_mode_with_city_is_onsite():
    from app.services.job_match_service import _parse_structured_job_section

    job = _parse_structured_job_section({"title": "Engineer", "description": "Build things.", "location": "Seattle, WA", "work_mode": "unknown"})
    assert job.work_mode == "onsite"
    job = _parse_structured_job_section({"title": "Engineer", "description": "Build things.", "location": "United States", "work_mode": "unknown"})
    assert job.work_mode == "unknown"


def test_declared_workplace_sets_work_mode():
    meta = build_metadata(
        plain_text="Title: Engineer\n\nBuild things in the office and at home.",
        structured_data={"workplace": "Hybrid", "location": "Palo Alto, CA"},
        existing_work_mode=None,
    )
    assert meta["work_mode"] == "hybrid"
    assert meta["work_mode_from_page"] is True


# ── Workday ─────────────────────────────────────────────────────────────────


def test_workday_cxs_locations_and_remote_type():
    info = WORKDAY_CXS["jobPostingInfo"]
    assert _cxs_locations(WORKDAY_CXS, info) == ["Palo Alto, CA", "Dallas, TX", "Bethesda, MD", "Seattle, WA"]
    assert _cxs_remote_type(WORKDAY_CXS, info) == "Hybrid"
    assert _cxs_remote_type({}, {"remoteType": {"descriptor": "Remote"}}) == "Remote"
    assert _cxs_remote_type({}, {}) is None


@pytest.mark.asyncio
async def test_workday_extract_reaches_jobs_columns(monkeypatch):
    extractor = WorkdayExtractor(http_service=object())

    class _Resp:
        status_code = 200
        text = json.dumps(WORKDAY_CXS)
        content = text.encode()

    class _Session:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            return _Resp()

    import curl_cffi.requests

    monkeypatch.setattr(curl_cffi.requests, "AsyncSession", _Session)
    url = "https://geico.wd1.myworkdayjobs.com/External/job/Palo-Alto-CA/Senior-Software-Engineer_R0065291"
    result = await extractor.extract(url)
    assert result.success
    assert result.structured_data["workplace"] == "Hybrid"
    assert result.structured_data["location"] == "Palo Alto, CA / Dallas, TX / Bethesda, MD / Seattle, WA"
    assert "Workplace Type: Hybrid" in result.raw_content

    meta = build_metadata(
        plain_text=result.raw_content,
        structured_data=result.structured_data,
        existing_location="Palo Alto, CA",
    )
    assert meta["location"] == "Palo Alto, CA / Dallas, TX / Bethesda, MD / Seattle, WA"
    assert meta["work_mode"] == "hybrid"

    # Text-only re-hydrate (vector "mark ready") still sees the workplace line.
    assert build_metadata(plain_text=result.raw_content)["work_mode"] == "hybrid"


# ── Oracle Recruiting Cloud ─────────────────────────────────────────────────


def test_oracle_url_parsing():
    url = "https://hccz.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/25747"
    assert parse_oracle_hcm_url(url) == ("hccz.fa.em3.oraclecloud.com", "CX_2", "25747")
    assert is_oracle_hcm_job_url(
        "https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/sites/CX_1/requisitions/preview/123"
    )
    assert not is_oracle_hcm_job_url("https://jobs.netapp.com/job/Morrisville/1429907900/")


@pytest.mark.parametrize(
    ("site_name", "company"),
    [
        ("Pearson Candidate Experience Site", "Pearson"),
        ("AF Group Careers Section", "AF Group"),
        ("Verisk Careers | Verisk", "Verisk"),
        ("Search Jobs - INL Professional Careers", "INL Professional"),
        ("Chase- Candidate Experience page", "Chase"),
        ("Hewlett-Packard Careers", "Hewlett-Packard"),
        ("Acme Careers", "Acme"),
        ("Contoso Career Site", "Contoso"),
        ("Fabrikam Jobs", "Fabrikam"),
        ("Careers", None),
        ("Oracle", "Oracle"),
    ],
)
def test_company_from_site_name(site_name, company):
    assert company_from_site_name(site_name) == company


class _FakeHttp:
    def __init__(self, items, page_html):
        self.items = items
        self.page_html = page_html
        self.json_urls: list[str] = []

    async def fetch_json(self, url):
        self.json_urls.append(url)
        return json.dumps({"items": self.items}), 200, {}

    async def fetch(self, url):
        return self.page_html, 200, {}


@pytest.mark.asyncio
async def test_oracle_extract_maps_workplace_locations_and_company():
    page = '<meta property="og:site_name" content="Pearson Candidate Experience Site"/>'
    http = _FakeHttp([ORACLE_ITEM], page)
    url = "https://hccz.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/25747"
    result = await OracleHcmExtractor(http).extract(url)

    assert result.success
    assert 'Id="25747"' in http.json_urls[0].replace("%22", '"')
    assert "siteNumber=CX_2" in http.json_urls[0]
    data = result.structured_data
    assert data["company_hint"] == "Pearson"
    assert data["workplace"] == "Remote"
    assert data["location"] == "United States / Austin, TX, United States"

    meta = build_metadata(plain_text=result.raw_content, structured_data=data, existing_location="United States")
    assert meta["work_mode"] == "remote"
    assert meta["company"] == "Pearson"
    assert build_metadata(plain_text=result.raw_content)["work_mode"] == "remote"

    # A feed's precise employer beats the site brand; a hostname guess does not.
    assert build_metadata(plain_text=result.raw_content, structured_data=data, source_url=url,
                          existing_company="Pearson VUE")["company"] == "Pearson VUE"
    assert build_metadata(plain_text=result.raw_content, structured_data=data, source_url=url,
                          existing_company="Hccz")["company"] == "Pearson"


@pytest.mark.asyncio
async def test_oracle_site_brand_beats_legal_employer():
    item = {**ORACLE_ITEM, "LegalEmployer": "Accident Fund Insurance Company of America"}
    page = '<meta property="og:site_name" content="AF Group Careers Section"/>'
    url = "https://ejko.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_5/job/14921"
    result = await OracleHcmExtractor(_FakeHttp([item], page)).extract(url)
    assert result.structured_data["company_hint"] == "AF Group"

    result = await OracleHcmExtractor(_FakeHttp([item], "<html></html>")).extract(url)
    assert result.structured_data["company_hint"] == "Accident Fund Insurance Company of America"


@pytest.mark.asyncio
async def test_oracle_unposted_requisition_is_closed():
    result = await OracleHcmExtractor(_FakeHttp([], "")).extract(
        "https://hccz.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/1"
    )
    assert not result.success
    assert result.closed
