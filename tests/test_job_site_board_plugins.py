"""Adzuna, JSearch, Welcome to the Jungle, and the browser-sync plumbing."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.job_sites import registry
from app.job_sites.base import AuthType, BrowserSync, FetchContext, JobSitePlugin
from app.job_sites import html_fetch
from app.job_sites.errors import RateLimited
from app.job_sites.plugins import adzuna, jsearch, welcometothejungle
from app.job_sites.registry import get_plugin, list_plugins
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


WAF_PAGE = "<html><head><title>Human Verification</title><script>window.gokuProps = {}</script></head></html>"


def test_aws_waf_bot_check_is_detected():
    assert html_fetch.is_bot_challenge(405, {"x-amzn-waf-action": "captcha"}, "")
    assert html_fetch.is_bot_challenge(202, {}, WAF_PAGE)
    assert html_fetch.is_bot_challenge(405, {}, WAF_PAGE)
    assert not html_fetch.is_bot_challenge(200, {}, ADZUNA_SEARCH)
    assert not html_fetch.is_bot_challenge(405, {}, "Method Not Allowed")


@pytest.fixture
def fake_html(monkeypatch):
    """HtmlSession without network: ``pages`` maps a URL to the queue of outcomes it returns."""
    state = SimpleNamespace(pages={}, sessions=[], calls=[])

    class FakeSession:
        def __init__(self, fingerprint):
            self.fingerprint = fingerprint

        def close(self):
            pass

    def new_session(self):
        session = FakeSession(self._fingerprints[self._fingerprint_index % len(self._fingerprints)])
        state.sessions.append(session.fingerprint)
        return session

    def sync_get(url, params, session):
        key = url if not params else f"{url}?p={params.get('p')}"
        state.calls.append(key)
        outcome = state.pages[key].pop(0) if len(state.pages.get(key, [])) > 1 else state.pages[key][0]
        if outcome == "waf":
            raise html_fetch.BotChallenge("bot check", retry_after_seconds=3600)
        return outcome

    monkeypatch.setattr(html_fetch.HtmlSession, "_new_session", new_session)
    monkeypatch.setattr(html_fetch, "_sync_get", sync_get)
    monkeypatch.setattr(html_fetch, "CHALLENGE_BACKOFF_SECONDS", (0.0,))
    monkeypatch.setattr(adzuna, "DETAIL_DELAY_SECONDS", 0)
    return state


@pytest.mark.asyncio
async def test_bot_check_retries_on_a_fresh_session_with_another_fingerprint(fake_html):
    fake_html.pages["https://x.test/"] = ["waf", "waf", "<ok>"]
    async with html_fetch.HtmlSession() as http:
        assert await http.get("https://x.test/") == "<ok>"
    assert fake_html.sessions == ["chrome124", "chrome131", "safari17_0"]


@pytest.mark.asyncio
async def test_persistent_bot_check_is_a_rate_limit(fake_html):
    fake_html.pages["https://x.test/"] = ["waf"]
    async with html_fetch.HtmlSession() as http:
        with pytest.raises(RateLimited):
            await http.get("https://x.test/")
    assert len(fake_html.calls) == html_fetch.CHALLENGE_ATTEMPTS


@pytest.mark.asyncio
async def test_adzuna_recovers_from_a_one_off_bot_check(fake_html):
    fake_html.pages["https://www.adzuna.com/search?p=1"] = ["waf", ADZUNA_SEARCH]
    fake_html.pages["https://www.adzuna.com/search?p=2"] = ["<html></html>"]
    for aid in ("5012345678", "5099999999"):
        fake_html.pages[f"https://www.adzuna.com/details/{aid}"] = [ADZUNA_DETAILS]
    jobs = await adzuna._fetch({"keywords": "senior software engineer"}, FetchContext(country_codes=("US",)))
    assert [j.title for j in jobs] == ["Senior Software Engineer", "Backend Developer"]
    assert all("We build things." in j.description for j in jobs)


@pytest.mark.asyncio
async def test_adzuna_keeps_cards_when_details_hit_a_bot_check(fake_html):
    fake_html.pages["https://www.adzuna.com/search?p=1"] = [ADZUNA_SEARCH]
    fake_html.pages["https://www.adzuna.com/search?p=2"] = ["waf"]
    fake_html.pages["https://www.adzuna.com/details/5012345678"] = ["waf"]
    fake_html.pages["https://www.adzuna.com/details/5099999999"] = [ADZUNA_DETAILS]
    jobs = await adzuna._fetch({}, FetchContext(country_codes=("US",)))
    assert [j.title for j in jobs] == ["Senior Software Engineer", "Backend Developer"]
    assert [j.description for j in jobs] == ["", ""]


@pytest.mark.asyncio
async def test_jsearch_searches_the_users_keywords(monkeypatch):
    seen = {}

    async def fake_request(method, host, path, *, api_key, params=None, **_kw):
        seen.update(url=f"https://{host}{path}", params=params, api_key=api_key)
        return {
            "status": "OK",
            "data": {
                "jobs": [
                    {
                        "job_title": "Data Engineer",
                        "job_apply_link": "https://acme.test/1",
                        "employer_name": "Acme",
                        "job_location": "Toronto, ON",
                        "job_description": "Build pipelines.",
                    },
                    {"job_title": "No link"},
                ],
                "cursor": "x",
            },
        }

    monkeypatch.setattr(jsearch, "rapidapi_request", fake_request)
    jobs = await jsearch._fetch({"api_key": "k", "keywords": "  senior   data engineer "}, FetchContext(country_codes=("CA",)))
    assert seen["url"] == "https://jsearch.p.rapidapi.com/search-v2"
    assert seen["params"]["query"] == "senior data engineer in Canada"
    assert seen["params"]["country"] == "ca"
    assert seen["api_key"] == "k"
    assert [(j.title, j.company, j.location, j.description) for j in jobs] == [
        ("Data Engineer", "Acme", "Toronto, ON", "Build pipelines.")
    ]
    assert jsearch.search_query({}, FetchContext()) == "remote senior software engineer in United States"
    assert jsearch.search_country(FetchContext(country_codes=("UK",))) == "gb"
    assert jsearch.result_items({"data": [{"job_title": "old shape"}]}) == [{"job_title": "old shape"}]
    plugin = get_plugin("jsearch")
    assert plugin.settings_from({"api_key": "k", "keywords": "ml engineer"}) == {"keywords": "ml engineer"}
    assert sync.credential_hints("jsearch", {"api_key": "abcdefghijkl", "keywords": "ml engineer"})["keywords"] == "ml engineer"


def test_keyword_boards_prefill_the_default_search():
    for slug in ("jsearch", "adzuna", "welcometothejungle"):
        fields = {f["key"]: f for f in get_plugin(slug).catalog_dict()["credential_fields"]}
        assert fields["keywords"]["default"] == "remote senior software engineer", slug
    assert get_plugin("jsearch").catalog_dict()["credential_fields"][0]["default"] is None


def test_curl_http_errors_get_a_readable_reason():
    exc = Exception("HTTP Error 405: ")
    exc.response = SimpleNamespace(status_code=405)
    assert sync.describe_fetch_error(exc) == "the site responded with HTTP 405. Try again in a few minutes."
    assert sync.classify_failure(exc) == sync.FAILURE_TRANSIENT
    exc.response = SimpleNamespace(status_code=429)
    assert sync.classify_failure(exc) == sync.FAILURE_RATE_LIMITED


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


def test_board_lists_only_working_sites():
    assert {p.slug for p in list_plugins()} == {
        "adzuna", "jobicy", "jobright", "jsearch", "remoterocketship", "welcometothejungle",
        "linkedin", "careersites", "indeed", "glassdoor", "multiboard", "linkedinscraper",
    }
    assert all(p.connectable for p in list_plugins())
    for slug in ("remoteco", "remotive", "remoteok", "themuse", "jooble"):
        assert get_plugin(slug) is None


@pytest.fixture
def browser_board():
    plugin = registry.register(
        JobSitePlugin(
            slug="testboard",
            name="Test Board",
            blurb="",
            homepage="https://board.test/",
            auth_type=AuthType.BROWSER,
            logo_file="",
            browser_sync=BrowserSync(collector="testboard", start_urls=lambda _c, _ctx: ["https://board.test/jobs"]),
        )
    )
    yield plugin
    registry._PLUGINS.pop(plugin.slug, None)


def test_browser_plugins_in_catalog(browser_board):
    assert browser_board.connectable
    assert browser_board.catalog_dict()["browser_sync"]["collector"] == "testboard"
    assert sync.browser_plugin_slugs() == ["testboard"]


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
def browser_env(monkeypatch, browser_board):
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
    out = await sync.ingest_browser_results("u1", "testboard", jobs)
    assert out["status"] == "synced"
    (connection_id, slug, user_id, listing, kw) = browser_env.ingests[0]
    assert (connection_id, slug, user_id, listing) == ("conn-1", "testboard", "u1", jobs)
    assert set(kw) == {"chain_analysis", "skip_phase_b"}
    assert browser_env.failures == []


@pytest.mark.asyncio
async def test_browser_results_blocked_is_rate_limited(browser_env):
    await sync.ingest_browser_results("u1", "testboard", [], blocked=True)
    (_cid, slug, exc, counted) = browser_env.failures[0]
    assert slug == "testboard" and counted is False
    assert isinstance(exc, sync.BrowserBlocked)
    assert sync.classify_failure(exc) == sync.FAILURE_RATE_LIMITED


@pytest.mark.asyncio
async def test_browser_results_error_is_transient(browser_env):
    await sync.ingest_browser_results("u1", "testboard", [], error="The sync tab was closed.")
    exc = browser_env.failures[0][2]
    assert sync.classify_failure(exc) == sync.FAILURE_TRANSIENT
    assert str(exc) == "The sync tab was closed."


@pytest.mark.asyncio
async def test_browser_results_reject_server_plugins():
    with pytest.raises(ValueError):
        await sync.ingest_browser_results("u1", "adzuna", [])
