"""Unit tests for scraper platform auth helpers (no browser required)."""

from pathlib import Path

from app.scraper.auth import (
    PLATFORMS,
    _build_parser,
    _filter_platform_cookies,
    _is_cloudflare_challenge,
    _parse_cdp_endpoint,
    cdp_endpoint_ready,
    cdp_profile_dir,
    chrome_executable,
    dedicated_profile_dir,
    default_chrome_user_data_dir,
    is_default_chrome_user_data_dir,
    parse_supabase_session_expiry,
)


def test_cloudflare_challenge_detection():
    assert _is_cloudflare_challenge("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/...")
    assert _is_cloudflare_challenge(
        "https://www.remoterocketship.com/log-in/",
        "<html>Performing security verification Verifying...</html>",
    )
    assert not _is_cloudflare_challenge(
        "https://www.remoterocketship.com/log-in/",
        "<html>Sign in with Google</html>",
    )


def test_filter_platform_cookies_rrs():
    cookies = [
        {"name": "session", "domain": ".remoterocketship.com", "value": "1"},
        {"name": "other", "domain": ".example.com", "value": "2"},
    ]
    filtered = _filter_platform_cookies(cookies, PLATFORMS["rrs"])
    assert len(filtered) == 1
    assert filtered[0]["name"] == "session"


def test_filter_platform_cookies_jobright():
    cookies = [
        {"name": "SESSION_ID", "domain": ".jobright.ai", "value": "abc"},
        {"name": "noise", "domain": "tracker.example", "value": "x"},
    ]
    filtered = _filter_platform_cookies(cookies, PLATFORMS["jobright"])
    assert len(filtered) == 1
    assert filtered[0]["name"] == "SESSION_ID"


def test_parser_chrome_profile_and_cdp():
    parser = _build_parser()
    args = parser.parse_args(["setup", "rrs", "--chrome-profile", "--manual"])
    assert args.command == "setup"
    assert args.platform == "rrs"
    assert args.chrome_profile is True
    assert args.manual is True

    args_cdp = parser.parse_args(["setup", "jobright", "--cdp"])
    assert args_cdp.cdp == "http://127.0.0.1:9222"

    args_cdp_custom = parser.parse_args(["setup", "jobright", "--cdp", "http://127.0.0.1:9333"])
    assert args_cdp_custom.cdp == "http://127.0.0.1:9333"


def test_dedicated_profile_dir_created(tmp_path, monkeypatch):
    monkeypatch.setattr("app.scraper.auth.BROWSER_PROFILE_ROOT", tmp_path / "profiles")
    path = dedicated_profile_dir("rrs")
    assert path.exists()
    assert path.name == "rrs"


def test_default_chrome_user_data_dir_type():
    path = default_chrome_user_data_dir()
    assert path is None or isinstance(path, Path)


def test_parse_cdp_endpoint():
    assert _parse_cdp_endpoint("http://127.0.0.1:9222") == ("127.0.0.1", 9222)
    assert _parse_cdp_endpoint("127.0.0.1:9333") == ("127.0.0.1", 9333)


def test_cdp_endpoint_ready_false_when_nothing_listening():
    assert cdp_endpoint_ready("http://127.0.0.1:59999") is False


def test_chrome_executable_type():
    path = chrome_executable()
    assert path is None or isinstance(path, Path)


def test_cdp_profile_is_not_default_user_data(tmp_path, monkeypatch):
    monkeypatch.setattr("app.scraper.auth.BROWSER_PROFILE_ROOT", tmp_path / "profiles")
    default = tmp_path / "ChromeUserData"
    default.mkdir()
    monkeypatch.setattr(
        "app.scraper.auth.default_chrome_user_data_dir",
        lambda: default,
    )
    cdp_dir = cdp_profile_dir("rrs")
    assert is_default_chrome_user_data_dir(default) is True
    assert is_default_chrome_user_data_dir(cdp_dir) is False


def test_parser_capture_command():
    parser = _build_parser()
    args = parser.parse_args(["capture", "rrs"])
    assert args.command == "capture"
    assert args.platform == "rrs"


def test_parse_supabase_session_expiry_expired():
    import base64
    import json

    payload = {
        "access_token": "x.y.z",
        "expires_at": 1000000000,  # 2001-09-09 UTC
        "refresh_token": "abc",
    }
    encoded = "base64-" + base64.b64encode(json.dumps(payload).encode()).decode()
    mid = len(encoded) // 2
    cookies = [
        {"name": "sb-xxx-auth-token.0", "value": encoded[:mid]},
        {"name": "sb-xxx-auth-token.1", "value": encoded[mid:]},
    ]
    info = parse_supabase_session_expiry(cookies)
    assert info["token_expired"] is True
    assert info["token_expires_at"] is not None


def test_rrs_auth_is_optional_without_session(monkeypatch, tmp_path):
    from app.scraper import auth as auth_mod
    from app.scraper.runner import check_spider_auth

    monkeypatch.setitem(
        auth_mod.PLATFORMS["rrs"],
        "session_file",
        tmp_path / "missing_rrs_session.json",
    )
    result = check_spider_auth("remoterocketship")
    assert result["ok"] is True
    assert result["auth_optional"] is True
    assert result["auth_configured"] is False
