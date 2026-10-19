"""Adzuna, Welcome to the Jungle, and the browser-synced boards (Glassdoor, Remote.co)."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.job_sites.base import AuthType, FetchContext
from app.job_sites.errors import RateLimited
from app.job_sites.plugins import adzuna, browser_boards, welcometothejungle
from app.job_sites.registry import get_plugin
from app.services import job_site_connection_sync as sync
from app.services.extraction_service import _is_aggregator_domain

ADZUNA_SEARCH = """
<div>
<article class="a" data-aid="5012345678" data-company-name="Acme &amp; Co">
  <h2><a href="/land/ad/5012345678?se=x">Senior <strong>Software</strong> Engineer</a></h2>
  <div class="ui-location">Austin, Travis County</div>
</article>
<article data-aid="5099999999">
  <h2><a href="/land/ad/5099999999">Backend Developer</a></h2>
  <div class="flex ui-company">Globex</div>
  <div class="ui-location">Remote</div>
</article>
<article data-aid="5000000000"><h2></h2></article>
</div>
"""

ADZUNA_DETAILS = """
<html><body><section class="adp-body mx-4">
<p>We build things.</p><ul><li>Python</li><li>Postgres</li></ul>
</section></body></html>
"""


def test_adzuna_search_page_cards():
    jobs = adzuna.parse_search_page(ADZUNA_SEARCH, "https://www.adzuna.com")
    assert [(j.url, j.title, j.company, j.location) for j in jobs] == [
        ("https://www.adzuna.com/details/5012345678", "Senior Software Engineer", "Acme & Co", "Austin, Travis County"),
        ("https://www.adzuna.com/details/5099999999", "Backend Developer", "Globex", "Remote"),
    ]


def test_adzuna_details_text():
    text = adzuna.parse_details_page(ADZUNA_DETAILS)
    assert "We build things." in text
    assert "Python" in text and "Postgres" in text
    assert adzuna.parse_details_page("<html></html>") == ""


def test_adzuna_site_follows_country():
    assert adzuna.site_for(FetchContext(country_codes=("GB",))) == "https://www.adzuna.co.uk"
    assert adzuna.site_for(FetchContext(country_codes=("ZZ",))) == "https://www.adzuna.com"
    assert adzuna.site_for(FetchContext()) == "https://www.adzuna.com"


def test_adzuna_needs_no_key_and_keeps_keywords():
    plugin = get_plugin("adzuna")
    assert plugin.auth_type == AuthType.NONE
    assert plugin.settings_from({"keywords": " data engineer ", "app_key": "x"}) == {"keywords": "data engineer"}


def test_adzuna_details_pages_are_fetched_by_extraction():
    assert _is_aggregator_domain("https://www.adzuna.com/details/123") is False
    assert _is_aggregator_domain("https://www.adzuna.com/land/ad/123") is True


WTTJ_HIT = {
    "name": "Platform Engineer",
    "slug": "platform-engineer_paris",
    "organization": {"name": "Doctolib", "slug": "doctolib"},
    "offices": [{"city": "Paris", "state": "Ile-de-France", "country": "France"}],
    "remote": "partial",
    "summary": "Short summary.",
    "profile": "<p>5 years of Go.</p>",
    "key_missions": ["Run Kubernetes", "Own CI"],
}


def test_wttj_hit_with_rest_details_uses_employer_apply_url():
    job = welcometothejungle.hit_to_job(
        WTTJ_HIT,
        {"apply_url": "https://careers.doctolib.com/jobs/1", "description": "<p>Full posting text.</p>"},
    )
    listing = "https://www.welcometothejungle.com/en/companies/doctolib/jobs/platform-engineer_paris"
    assert job.url == "https://careers.doctolib.com/jobs/1"
    assert job.source_url == listing
    assert job.company == "Doctolib"
    assert job.location == "Paris, Ile-de-France, France"
    assert job.description.startswith("Full posting text.")
    assert "5 years of Go." in job.description
    assert "- Run Kubernetes" in job.description


def test_wttj_hit_without_rest_falls_back_to_listing():
    job = welcometothejungle.hit_to_job({**WTTJ_HIT, "remote": "fulltime"}, None)
    assert job.url.endswith("/companies/doctolib/jobs/platform-engineer_paris")
    assert job.source_url == ""
    assert job.location == "Remote (Paris, Ile-de-France, France)"
    assert job.description.startswith("Short summary.")
    assert welcometothejungle.hit_to_job({"name": "x"}, None) is None


def test_wttj_country_facet():
    assert welcometothejungle.search_body("go", "FR", hits=5)["facetFilters"] == [["offices.country_code:FR"]]
    assert "facetFilters" not in welcometothejungle.search_body("go", "", hits=5)


def test_browser_plugins_in_catalog():
    for slug, collector in (("glassdoor", "glassdoor"), ("remoteco", "remoteco")):
        plugin = get_plugin(slug)
        assert plugin.auth_type == AuthType.BROWSER
        assert plugin.connectable
        assert plugin.catalog_dict()["browser_sync"]["collector"] == collector
        assert slug in sync.browser_plugin_slugs()


def test_glassdoor_start_urls():
    ctx = FetchContext()
    assert browser_boards.glassdoor_start_urls({}, ctx) == [
        "https://www.glassdoor.com/Job/jobs.htm?sc.keyword=software+engineer&fromAge=3"
    ]
    assert browser_boards.glassdoor_start_urls({"keywords": "data & ml"}, ctx) == [
        "https://www.glassdoor.com/Job/jobs.htm?sc.keyword=data+%26+ml&fromAge=3"
    ]
    custom = "https://www.glassdoor.com/Job/remote-python-jobs-SRCH_IL.0,6_IS11047_KO7,13.htm?fromAge=1"
    assert browser_boards.glassdoor_start_urls({"search_url": custom, "keywords": "x"}, ctx) == [custom]
    assert browser_boards.glassdoor_start_urls({"search_url": "https://evil.example/glassdoor.com"}, ctx)[0].startswith(
        "https://www.glassdoor.com/Job/jobs.htm"
    )


def test_remoteco_start_urls():
    ctx = FetchContext()
    assert browser_boards.remoteco_start_urls({}, ctx) == [
        "https://remote.co/remote-jobs/developer",
        "https://remote.co/remote-jobs/software-engineer",
        "https://remote.co/remote-jobs/it",
    ]
    raw = "https://remote.co/remote-jobs/qa, https://remote.co/about https://other.com/remote-jobs/x http://remote.co/remote-jobs/qa"
    assert browser_boards.remoteco_start_urls({"search_url": raw}, ctx) == ["https://remote.co/remote-jobs/qa"]


def _conn(**over):
    base = dict(enabled=True, status=sync.STATUS_CONNECTED, sync_phase=None, sync_started_at=None, next_sync_at=None)
    base.update(over)
    return SimpleNamespace(**base)


def test_browser_due():
    now = sync._now()
    assert sync._browser_due(_conn(), now)
    assert not sync._browser_due(_conn(enabled=False), now)
    assert not sync._browser_due(_conn(status=sync.STATUS_NEEDS_REAUTH), now)
    assert not sync._browser_due(_conn(sync_phase="fetching", sync_started_at=now), now)
    stale = now - sync.STALE_SYNC_PHASE - sync.timedelta(seconds=1)
    assert sync._browser_due(_conn(sync_phase="fetching", sync_started_at=stale), now)
    assert not sync._browser_due(_conn(next_sync_at=now + sync.timedelta(hours=1)), now)
    assert sync._browser_due(_conn(status=sync.STATUS_RATE_LIMITED, next_sync_at=now), now)
    assert not sync._browser_due(_conn(status=sync.STATUS_RATE_LIMITED, next_sync_at=None), now)


def test_blocked_browser_sync_waits_six_hours():
    now = sync._now()
    exc = sync.BrowserBlocked("security check", retry_after_seconds=sync.BROWSER_BLOCKED_WAIT_SECONDS)
    assert isinstance(exc, RateLimited)
    status, next_at = sync.failure_schedule(
        sync.classify_failure(exc), exc, failures=1, interval=sync.timedelta(hours=6), now=now
    )
    assert status == sync.STATUS_RATE_LIMITED
    assert next_at == now + sync.timedelta(hours=6)


class _Result:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


@pytest.fixture
def browser_env(monkeypatch):
    row = SimpleNamespace(id="conn-1")
    user = SimpleNamespace(manual_submit_pipeline="full")
    calls = SimpleNamespace(failures=[], ingests=[])

    class _Session:
        def __init__(self):
            self.results = [row, user]

        async def execute(self, _stmt):
            return _Result(self.results.pop(0))

    @asynccontextmanager
    async def fake_session():
        yield _Session()

    async def fake_failure(connection_id, plugin, exc, *, counted_request):
        calls.failures.append((connection_id, plugin.slug, exc, counted_request))
        return {"status": "fetch_failed"}

    async def fake_ingest(connection_id, plugin, slug, user_id, listing, **kw):
        calls.ingests.append((connection_id, slug, user_id, listing, kw))
        return {"status": "synced", "created": len(listing)}

    monkeypatch.setattr(sync, "get_session", fake_session)
    monkeypatch.setattr(sync, "_record_failure", fake_failure)
    monkeypatch.setattr(sync, "_ingest_listing", fake_ingest)
    return calls


@pytest.mark.asyncio
async def test_browser_results_ingest_jobs(browser_env):
    jobs = [SimpleNamespace(url="https://jobs.example/1")]
    out = await sync.ingest_browser_results("u1", "remoteco", jobs)
    assert out["status"] == "synced"
    (connection_id, slug, user_id, listing, kw) = browser_env.ingests[0]
    assert (connection_id, slug, user_id, listing) == ("conn-1", "remoteco", "u1", jobs)
    assert set(kw) == {"chain_analysis", "skip_phase_b"}
    assert browser_env.failures == []


@pytest.mark.asyncio
async def test_browser_results_blocked_is_rate_limited(browser_env):
    await sync.ingest_browser_results("u1", "glassdoor", [], blocked=True)
    (_cid, slug, exc, counted) = browser_env.failures[0]
    assert slug == "glassdoor" and counted is False
    assert isinstance(exc, sync.BrowserBlocked)
    assert sync.classify_failure(exc) == sync.FAILURE_RATE_LIMITED


@pytest.mark.asyncio
async def test_browser_results_error_is_transient(browser_env):
    await sync.ingest_browser_results("u1", "glassdoor", [], error="The sync tab was closed.")
    exc = browser_env.failures[0][2]
    assert sync.classify_failure(exc) == sync.FAILURE_TRANSIENT
    assert str(exc) == "The sync tab was closed."


@pytest.mark.asyncio
async def test_browser_results_reject_server_plugins():
    with pytest.raises(ValueError):
        await sync.ingest_browser_results("u1", "adzuna", [])
