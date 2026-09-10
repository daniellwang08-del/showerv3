"""Pluginable job-site catalog: registry, public-feed parsers, connectability."""

from __future__ import annotations

from app.job_sites.base import AuthType, FetchContext
from app.job_sites.plugins.arbeitnow import parse_arbeitnow
from app.job_sites.plugins.jobicy import parse_jobicy
from app.job_sites.plugins.jobright import LOGIN_URL
from app.job_sites.plugins.remoteok import parse_remoteok
from app.job_sites.plugins.remotive import parse_remotive
from app.job_sites.plugins.remoterocketship import parse_cookie_header
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


def test_account_plugins_expose_session_capture():
    jobright = get_plugin("jobright")
    rrs = get_plugin("remoterocketship")
    assert jobright is not None and jobright.auth_type == AuthType.ACCOUNT
    assert jobright.login_url and jobright.login_url.endswith("/jobs/recommend")
    keys = {f.key for f in jobright.credential_fields}
    assert keys == {"email", "password"}
    catalog = jobright.catalog_dict()
    assert catalog["auth_type"] == "account"
    capture = catalog["session_capture"]
    assert capture["cookie_domains"] == ["jobright.ai"]
    # Connect lands on the root: Jobright's own redirect to the recommend page
    # is what proves the user is already signed in.
    assert capture["start_url"] == "https://jobright.ai/"
    assert capture["verify_url"].endswith("/jobs/recommend")
    assert "jobright.ai/jobs/recommend" in capture["signed_in_url_patterns"]
    assert "SESSION_ID" in capture["session_cookie_names"]
    assert LOGIN_URL.endswith("/swan/auth/login/pwd")

    assert rrs is not None and rrs.auth_type == AuthType.ACCOUNT
    assert {f.key for f in rrs.credential_fields} == {"cookie_header"}
    rrs_capture = rrs.catalog_dict()["session_capture"]
    assert "remoterocketship.com" in rrs_capture["cookie_domains"]
    assert rrs.catalog_dict()["auth_type"] == "account"


def test_parse_rrs_cookie_header():
    cookies = parse_cookie_header(
        "Cookie: sb-access-token=abc; session=xyz",
        default_domain=".remoterocketship.com",
    )
    assert len(cookies) == 2
    assert cookies[0]["name"] == "sb-access-token"
    assert cookies[1]["value"] == "xyz"


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


def test_parse_arbeitnow():
    payload = {
        "data": [
            {
                "url": "https://arbeitnow.com/a",
                "title": "Dev",
                "company_name": "Co",
                "location": "Berlin",
            }
        ]
    }
    jobs = parse_arbeitnow(payload, max_jobs=5)
    assert len(jobs) == 1
    assert jobs[0].company == "Co"


def test_parse_jobicy():
    payload = {
        "jobs": [
            {
                "url": "https://jobicy.com/j",
                "jobTitle": "Eng",
                "companyName": "Co",
                "jobGeo": "Remote",
            }
        ]
    }
    jobs = parse_jobicy(payload, max_jobs=5)
    assert len(jobs) == 1
    assert jobs[0].title == "Eng"


def test_parse_themuse():
    payload = {
        "results": [
            {
                "refs": {"landing_page": "https://themuse.com/j"},
                "name": "PM",
                "company": {"name": "Co"},
                "locations": [{"name": "NYC"}],
            }
        ]
    }
    jobs = parse_themuse(payload, max_jobs=5)
    assert len(jobs) == 1
    assert jobs[0].location == "NYC"


def test_normalize_cookies_filters_empty():
    assert normalize_cookies(
        [
            {"name": "sid", "value": "abc", "domain": ".jobright.ai", "path": "/", "httpOnly": True},
            {"name": "", "value": "x"},
            {"name": "a", "value": ""},
            "bad",
        ]
    ) == [
        {
            "name": "sid",
            "value": "abc",
            "domain": ".jobright.ai",
            "path": "/",
            "secure": True,
            "httpOnly": True,
        }
    ]


def test_fetch_context_primary_country():
    ctx = FetchContext(country_codes=("CA", "US"))
    assert ctx.primary_country == "CA"
    assert FetchContext().primary_country == "US"
