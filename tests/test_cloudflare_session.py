"""Tests for RemoteRocketship CloudflareSession fixes."""

from app.scraper.utils.cloudflare import (
    IMPERSONATE,
    IMPERSONATE_CANDIDATES,
    CloudflareSession,
    is_cloudflare_challenge_response,
    _parse_proxy_line,
)


def test_impersonate_candidates_prefer_chrome123():
    """Evidence: chrome123 via residential proxy returned 200; chrome alias blocked."""
    assert IMPERSONATE_CANDIDATES[0] == "chrome123"
    assert IMPERSONATE == "chrome123"
    assert "chrome124" in IMPERSONATE_CANDIDATES
    assert "chrome" not in IMPERSONATE_CANDIDATES


def test_parse_proxy_line_formats():
    assert _parse_proxy_line("http://u:p@1.2.3.4:8080") == "http://u:p@1.2.3.4:8080"
    assert _parse_proxy_line("1.2.3.4:8080:u:p") == "http://u:p@1.2.3.4:8080"
    assert _parse_proxy_line("1.2.3.4:8080\tu\tp") == "http://u:p@1.2.3.4:8080"
    assert _parse_proxy_line("1.2.3.4:8080") == "http://1.2.3.4:8080"


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


def test_fetch_classifies_cf_challenge_not_auth_expired():
    session = CloudflareSession.__new__(CloudflareSession)
    session.timeout = 5
    session.proxies_list = []
    session._proxy_index = 0
    session._current_proxy = None
    session._impersonate_index = 0
    session._impersonate = "chrome123"
    session._session = object()
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


def test_loads_host_port_user_pass_proxy_file(tmp_path):
    proxy_file = tmp_path / "proxies.txt"
    proxy_file.write_text("151.247.185.166:50100:andreballard1106:secret\n")
    session = CloudflareSession(proxy_path=str(proxy_file), timeout=5)
    assert len(session.proxies_list) == 1
    assert session.proxies_list[0].startswith("http://andreballard1106:secret@151.247.185.166:50100")
    assert session._current_proxy == session.proxies_list[0]
    session.close()
