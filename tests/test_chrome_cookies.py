"""Unit tests for Chrome cookie helpers (no live Chrome required)."""

from app.scraper.chrome_cookies import _chrome_expires_to_unix, _domain_match, _map_samesite


def test_domain_match():
    assert _domain_match(".remoterocketship.com", ["remoterocketship.com"])
    assert _domain_match("www.remoterocketship.com", ["remoterocketship.com"])
    assert not _domain_match(".example.com", ["remoterocketship.com"])


def test_samesite_mapping():
    assert _map_samesite(1) == "None"
    assert _map_samesite(2) == "Lax"
    assert _map_samesite(3) == "Strict"
    assert _map_samesite(None) == "Lax"


def test_chrome_expires_epoch():
    assert _chrome_expires_to_unix(0) == -1
    # 11644473600000000 == Unix epoch in Chrome time
    assert abs(_chrome_expires_to_unix(11_644_473_600_000_000) - 0.0) < 0.001
