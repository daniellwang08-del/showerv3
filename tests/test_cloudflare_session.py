"""Tests for RemoteRocketship CloudflareSession fixes."""

from app.scraper.utils.cloudflare import (
    IMPERSONATE_CANDIDATES,
    CloudflareSession,
    is_cloudflare_challenge_response,
)


def test_primary_impersonate_is_chrome124():
    """Evidence: chrome124 returns 200; default chrome gets CF 403."""
    assert IMPERSONATE_CANDIDATES[0] == "chrome124"


def test_detect_cloudflare_challenge_html():
    body = "<!DOCTYPE html><html><head><title>Just a moment...</title></head>"
    assert is_cloudflare_challenge_response(403, body, {"server": "cloudflare"}) is True


def test_detect_cloudflare_challenge_by_server_header():
    assert is_cloudflare_challenge_response(403, "", {"server": "cloudflare"}) is True


def test_real_auth_403_without_cf_hints_is_not_challenge():
    assert is_cloudflare_challenge_response(
        403,
        '{"error":"forbidden"}',
        {"server": "nginx", "content-type": "application/json"},
    ) is False


def test_fetch_classifies_cf_challenge_not_auth_expired(monkeypatch):
    session = CloudflareSession.__new__(CloudflareSession)
    session.timeout = 5
    session.proxies_list = []
    session._session = object()
    session._impersonate = "chrome124"
    session._authenticated = True
    session._cookies = []
    session.last_status_code = None
    session.last_failure_reason = None

    class FakeResp:
        status_code = 403
        text = "<html><title>Just a moment...</title>cloudflare</html>"
        content = text.encode()
        headers = {"server": "cloudflare"}

    def fake_get(url, proxies=None):
        return FakeResp()

    session._session = type("S", (), {"get": staticmethod(fake_get)})()
    assert session._try_curl_cffi("https://www.remoterocketship.com/api/x") is None
    assert session.last_failure_reason == "cloudflare_blocked"
