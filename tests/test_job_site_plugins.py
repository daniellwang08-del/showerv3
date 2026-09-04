"""Pluginable job-site catalog: registry, public-feed parsers, connectability."""

from __future__ import annotations

from app.job_sites.base import AuthType, FetchContext
from app.job_sites.plugins.arbeitnow import parse_arbeitnow
from app.job_sites.plugins.jobicy import parse_jobicy
from app.job_sites.plugins.remoteok import parse_remoteok
from app.job_sites.plugins.remotive import parse_remotive
from app.job_sites.plugins.themuse import parse_themuse
from app.job_sites.registry import get_plugin, list_plugins
from app.job_sites.session_http import normalize_cookies


def test_registry_unique_slugs_and_expected_sites():
    plugins = list_plugins()
    slugs = [p.slug for p in plugins]
    assert len(slugs) == len(set(slugs))
    assert "jobright" in slugs
    assert "adzuna" in slugs
    assert "linkedin" in slugs
    assert "jsearch" in slugs


def test_session_plugins_have_cookie_domains():
    jobright = get_plugin("jobright")
    rrs = get_plugin("remoterocketship")
    assert jobright is not None and jobright.auth_type == AuthType.SESSION
    assert "jobright.ai" in jobright.cookie_domains
    assert rrs is not None and rrs.auth_type == AuthType.SESSION
    assert "remoterocketship.com" in rrs.cookie_domains


def test_linkedin_is_not_connectable():
    plugin = get_plugin("linkedin")
    assert plugin is not None
    assert plugin.connectable is False
    assert plugin.auth_type == AuthType.UNAVAILABLE
    assert "job-seeker" in (plugin.unavailable_reason or "").lower() or "API" in (
        plugin.unavailable_reason or ""
    )


def test_parse_remoteok_skips_legal_banner():
    payload = [
        {"legal": "terms"},
        {"id": 1, "url": "https://remoteok.com/l/1", "position": "Engineer", "company": "Acme"},
        {"id": 2, "url": "", "position": "skip me"},
    ]
    jobs = parse_remoteok(payload, max_jobs=10)
    assert len(jobs) == 1
    assert jobs[0].title == "Engineer"
    assert jobs[0].company == "Acme"


def test_parse_remotive():
    payload = {
        "jobs": [
            {
                "url": "https://remotive.com/x",
                "title": "Backend",
                "company_name": "Co",
                "candidate_required_location": "USA",
            }
        ]
    }
    jobs = parse_remotive(payload, max_jobs=5)
    assert len(jobs) == 1
    assert jobs[0].location == "USA"


def test_parse_arbeitnow_and_jobicy():
    arbeit = parse_arbeitnow(
        {"data": [{"url": "https://a.example/j", "title": "Dev", "company_name": "A", "location": "Berlin"}]},
        max_jobs=5,
    )
    assert arbeit[0].company == "A"
    icy = parse_jobicy(
        {"jobs": [{"url": "https://jobicy.com/j/1", "jobTitle": "PM", "companyName": "B", "jobGeo": "UK"}]},
        max_jobs=5,
    )
    assert icy[0].title == "PM"


def test_parse_themuse():
    payload = {
        "results": [
            {
                "name": "Designer",
                "refs": {"landing_page": "https://www.themuse.com/jobs/1"},
                "company": {"name": "MuseCo"},
                "locations": [{"name": "New York"}],
            }
        ]
    }
    jobs = parse_themuse(payload, max_jobs=5)
    assert jobs[0].url.endswith("/jobs/1")
    assert jobs[0].company == "MuseCo"


def test_normalize_cookies_accepts_chrome_shape():
    cookies = normalize_cookies(
        [
            {"name": "sid", "value": "abc", "domain": ".jobright.ai", "path": "/", "httpOnly": True},
            {"name": "", "value": "skip"},
            "not-a-dict",
        ]
    )
    assert len(cookies) == 1
    assert cookies[0]["name"] == "sid"


def test_open_board_plugins_need_no_credentials():
    for slug in ("remoteok", "remotive", "arbeitnow", "jobicy", "themuse"):
        plugin = get_plugin(slug)
        assert plugin is not None
        assert plugin.auth_type == AuthType.NONE
        assert plugin.fetch is not None


def test_fetch_context_primary_country():
    ctx = FetchContext(country_codes=("CA", "US"))
    assert ctx.primary_country == "CA"
    assert FetchContext().primary_country == "US"
