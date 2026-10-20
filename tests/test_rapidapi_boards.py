"""RapidAPI boards: gateway errors, and each API's reply mapped to board jobs."""

import math

import httpx
import pytest

from app.job_sites import rapidapi
from app.job_sites.base import AuthType, FetchContext
from app.job_sites.errors import ConnectionConfigError, QuotaExhausted, RateLimited, SessionExpired
from app.job_sites.plugins import fantasticjobs, glassdoor, indeed, linkedinscraper, multiboard
from app.job_sites.registry import get_plugin

LONG = "Build reliable systems. " * 40


def _response(code, body, headers=None):
    return httpx.Response(code, json=body, headers=headers or {}, request=httpx.Request("GET", "https://x.test/"))


def _raise(code, body, headers=None):
    rapidapi.raise_for_gateway(_response(code, body, headers), api_name="Some API", listing_url="https://rapidapi.com/x")


def test_gateway_errors_map_to_sync_outcomes():
    with pytest.raises(ConnectionConfigError, match="not subscribed to Some API.*rapidapi.com/x"):
        _raise(403, {"message": "You are not subscribed to this API."})
    with pytest.raises(SessionExpired):
        _raise(401, {"message": "Invalid API key. Go to https://docs.rapidapi.com/docs/keys for more info."})
    with pytest.raises(QuotaExhausted) as quota:
        _raise(
            429,
            {"message": "You have exceeded the MONTHLY quota for Requests on your current plan, BASIC."},
            {"x-ratelimit-requests-reset": "3600"},
        )
    assert quota.value.resets_at is not None
    with pytest.raises(RateLimited) as throttled:
        _raise(429, {"message": "Too many requests"}, {"retry-after": "5"})
    assert throttled.value.retry_after_seconds == 5.0
    with pytest.raises(httpx.HTTPStatusError):
        _raise(502, {"message": "upstream"})
    _raise(200, [])


def test_rapidapi_boards_are_api_key_plugins():
    for slug in ("linkedin", "careersites", "indeed", "glassdoor", "multiboard", "linkedinscraper"):
        plugin = get_plugin(slug)
        assert plugin.auth_type == AuthType.API_KEY, slug
        assert plugin.verify_max_jobs, slug
        fields = {f.key: f for f in plugin.credential_fields}
        assert fields["api_key"].secret and fields["api_key"].required
        assert fields["keywords"].default == "remote senior software engineer"


def _recorder(replies):
    calls = []

    async def fake(method, host, path, *, params=None, json_body=None, **_kw):
        calls.append({"method": method, "host": host, "path": path, "params": params, "json": json_body})
        reply = replies(path, params) if callable(replies) else replies
        if isinstance(reply, Exception):
            raise reply
        return reply

    return fake, calls


@pytest.mark.asyncio
async def test_fantastic_jobs_search_and_mapping(monkeypatch):
    fake, calls = _recorder(
        [
            {
                "id": 1,
                "title": "Senior Software Engineer",
                "organization": "Acme",
                "url": "https://boards.greenhouse.io/acme/jobs/1",
                "locations_derived": ["Austin, Texas, United States"],
                "ai_work_arrangement": "Remote Solely",
                "description_text": LONG,
            },
            {"id": 2, "title": "", "url": "https://x.test/2"},
        ]
    )
    monkeypatch.setattr(fantasticjobs, "rapidapi_request", fake)
    fetch = get_plugin("careersites").fetch
    jobs = await fetch({"api_key": "k"}, FetchContext(country_codes=("US", "CA")))
    params = calls[0]["params"]
    assert (calls[0]["host"], calls[0]["path"]) == ("active-jobs-db.p.rapidapi.com", "/active-ats")
    assert params["title"] == "senior software engineer"
    assert params["ai_work_arrangement"] == "Remote OK,Remote Solely"
    assert params["location"] == '"United States" OR "Canada"'
    assert params["time_frame"] == "24h" and params["description_format"] == "text"
    assert [(j.url, j.company, j.location) for j in jobs] == [
        ("https://boards.greenhouse.io/acme/jobs/1", "Acme", "Austin, Texas, United States | Remote Solely")
    ]
    assert jobs[0].description == LONG.strip()


@pytest.mark.asyncio
async def test_fantastic_jobs_falls_back_to_the_previous_release(monkeypatch):
    def replies(path, _params):
        if path == "/active-jb":
            return httpx.HTTPStatusError("404", request=httpx.Request("GET", "https://x.test"), response=_response(404, {}))
        return [{"id": "9", "title": "Backend Engineer", "url": "https://www.linkedin.com/jobs/view/9", "remote_derived": True}]

    fake, calls = _recorder(replies)
    monkeypatch.setattr(fantasticjobs, "rapidapi_request", fake)
    jobs = await get_plugin("linkedin").fetch({"api_key": "k", "keywords": "backend engineer"}, FetchContext())
    assert [c["path"] for c in calls] == ["/active-jb", "/active-jb-24h"]
    assert calls[1]["params"]["title_filter"] == '"backend engineer"'
    assert "remote" not in calls[1]["params"]
    assert jobs[0].location == "Remote"


@pytest.mark.asyncio
async def test_indeed_reads_descriptions_from_job_details(monkeypatch):
    def replies(path, params):
        if path == "/jobs/search":
            if params["page_id"] == "1":
                return {
                    "hits": [
                        {"id": "a1", "title": "Platform Engineer", "company_name": "Acme", "location": "Remote"},
                        {"id": "b2", "title": "SRE", "company_name": "Beta", "location": "Austin, TX"},
                    ],
                    "next_page_id": None,
                }
            return {"hits": []}
        if path == "/job/a1":
            return {"description": "<p>Run the platform.</p><ul><li>Kubernetes</li></ul>", "indeed_final_url": "https://www.indeed.com/viewjob?jk=a1&vjs=3"}
        return ConnectionConfigError("detail failed")

    fake, calls = _recorder(replies)
    monkeypatch.setattr(indeed, "rapidapi_request", fake)
    jobs = await indeed._fetch({"api_key": "k"}, FetchContext(country_codes=("GB",)))
    search = calls[0]["params"]
    assert search["locality"] == "gb" and search["location"] == "remote" and search["fromage"] == "1"
    assert search["query"] == "senior software engineer"
    assert jobs[0].url == "https://www.indeed.com/viewjob?jk=a1&vjs=3"
    assert jobs[0].description == "Run the platform.\n\n- Kubernetes"
    assert (jobs[1].url, jobs[1].description) == ("https://uk.indeed.com/viewjob?jk=b2", "")


@pytest.mark.asyncio
async def test_indeed_stops_detail_calls_when_throttled_twice(monkeypatch):
    monkeypatch.setattr(indeed, "THROTTLE_WAIT_SECONDS", 0)

    def replies(path, params):
        if path == "/jobs/search":
            return {"hits": [{"id": f"j{i}", "title": f"Job {i}"} for i in range(4)]}
        return RateLimited("slow down", retry_after_seconds=0)

    fake, calls = _recorder(replies)
    monkeypatch.setattr(indeed, "rapidapi_request", fake)
    jobs = await indeed._fetch({"api_key": "k"}, FetchContext())
    assert len(jobs) == 4
    assert [c["path"] for c in calls] == ["/jobs/search", "/job/j0", "/job/j0"]


@pytest.mark.asyncio
async def test_glassdoor_job_search(monkeypatch):
    fake, calls = _recorder(
        {
            "status": "OK",
            "data": {
                "jobs": [
                    {
                        "job_id": 7,
                        "job_title": "Staff Engineer",
                        "company_name": "Gamma",
                        "location_name": "Toronto, ON",
                        "job_link": "https://www.glassdoor.ca/job-listing/x?jl=7",
                    },
                    {"job_title": "No link"},
                ],
                "cursor": "abc",
            },
        }
    )
    monkeypatch.setattr(glassdoor, "rapidapi_request", fake)
    jobs = await glassdoor._fetch({"api_key": "k", "keywords": "staff engineer"}, FetchContext(country_codes=("CA",)))
    params = calls[0]["params"]
    assert (params["location"], params["domain"], params["remote_only"]) == ("Canada", "www.glassdoor.ca", "false")
    assert [(j.url, j.company, j.location) for j in jobs] == [
        ("https://www.glassdoor.ca/job-listing/x?jl=7", "Gamma", "Toronto, ON")
    ]


@pytest.mark.asyncio
async def test_glassdoor_error_status_is_reported(monkeypatch):
    fake, _ = _recorder({"status": "ERROR", "error": {"message": "Invalid location"}})
    monkeypatch.setattr(glassdoor, "rapidapi_request", fake)
    with pytest.raises(ConnectionConfigError, match="Invalid location"):
        await glassdoor._fetch({"api_key": "k"}, FetchContext())


@pytest.mark.asyncio
async def test_multiboard_body_and_nan_rows(monkeypatch):
    fake, calls = _recorder(
        {
            "jobs": [
                {
                    "site": "indeed",
                    "job_url": "https://www.indeed.com/viewjob?jk=1",
                    "job_url_direct": "https://jobs.lever.co/acme/1",
                    "title": "Python Engineer",
                    "company": "Acme",
                    "location": "Remote, US",
                    "description": LONG,
                    "is_remote": True,
                },
                {
                    "site": "linkedin",
                    "job_url": "https://www.linkedin.com/jobs/view/2",
                    "job_url_direct": math.nan,
                    "title": "Data Engineer",
                    "company": math.nan,
                    "location": "New York, NY",
                    "description": math.nan,
                    "is_remote": False,
                },
            ]
        }
    )
    monkeypatch.setattr(multiboard, "rapidapi_request", fake)
    jobs = await multiboard._fetch({"api_key": "k"}, FetchContext(country_codes=("GB",)))
    body = calls[0]["json"]
    assert (calls[0]["method"], calls[0]["path"]) == ("POST", "/getjobs")
    assert body["site_name"] == ["indeed", "linkedin", "glassdoor"]
    assert (body["country_indeed"], body["location"], body["is_remote"], body["hours_old"]) == ("UK", "United Kingdom", True, 24)
    assert body["search_term"] == "senior software engineer"
    assert [(j.url, j.source_url, j.company) for j in jobs] == [
        ("https://jobs.lever.co/acme/1", "https://www.indeed.com/viewjob?jk=1", "Acme"),
        ("https://www.linkedin.com/jobs/view/2", "", ""),
    ]
    assert jobs[0].location == "Remote, US" and jobs[1].description == ""
    assert "zip_recruiter" in multiboard.search_body({}, FetchContext())["site_name"]


@pytest.mark.asyncio
async def test_linkedin_scraper_uses_details_for_description_and_apply_link(monkeypatch):
    def replies(path, params):
        if path == "/search-jobs-v2":
            return {
                "success": True,
                "data": [
                    {"id": "11", "title": "ML Engineer", "url": "https://www.linkedin.com/jobs/view/11", "company": {"name": "Delta"}, "location": "Berlin"},
                    {"id": "12", "title": "Easy Apply Job", "company": {"name": "Echo"}, "location": "Munich"},
                ],
            }
        if params["id"] == "11":
            return {"success": True, "data": {"description": LONG, "applyMethod": {"companyApplyUrl": "https://delta.test/apply/11"}, "workRemoteAllowed": True}}
        return {"success": False, "message": "not found"}

    fake, calls = _recorder(replies)
    monkeypatch.setattr(linkedinscraper, "rapidapi_request", fake)
    jobs = await linkedinscraper._fetch({"api_key": "k", "keywords": "ml engineer"}, FetchContext(country_codes=("DE",)))
    search = calls[0]["params"]
    assert (search["locationId"], search["datePosted"], search["sort"]) == ("101282230", "past24Hours", "mostRecent")
    assert "onsiteRemote" not in search
    first, second = jobs
    assert (first.url, first.source_url, first.location) == ("https://delta.test/apply/11", "https://www.linkedin.com/jobs/view/11", "Berlin | Remote")
    assert first.description == LONG.strip()
    assert (second.url, second.company, second.description) == ("https://www.linkedin.com/jobs/view/12/", "Echo", "")


@pytest.mark.asyncio
async def test_linkedin_scraper_failed_search_is_reported(monkeypatch):
    fake, _ = _recorder({"success": False, "message": "Something went wrong"})
    monkeypatch.setattr(linkedinscraper, "rapidapi_request", fake)
    with pytest.raises(ConnectionConfigError, match="Something went wrong"):
        await linkedinscraper._fetch({"api_key": "k"}, FetchContext())
