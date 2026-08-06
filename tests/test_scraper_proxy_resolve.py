"""Tests for scraper residential proxy resolution."""

from app.scraper.utils.proxies import (
    _parse_proxy_line,
    resolve_scraper_proxies,
)


def test_resolve_prefers_inline_url():
    urls = resolve_scraper_proxies(
        proxy_url="http://u:p@1.2.3.4:8000",
        fallback_proxy_url="http://other:x@9.9.9.9:1",
        fallback_proxy_enabled=True,
    )
    assert urls == ["http://u:p@1.2.3.4:8000"]


def test_resolve_from_host_components():
    urls = resolve_scraper_proxies(
        proxy_host="gate.example.com",
        proxy_port="7777",
        proxy_user="alice",
        proxy_password="s3cret",
    )
    assert urls == ["http://alice:s3cret@gate.example.com:7777"]


def test_resolve_falls_back_to_proxy_url_when_enabled():
    urls = resolve_scraper_proxies(
        fallback_proxy_url="http://u:p@5.6.7.8:9000",
        fallback_proxy_enabled=True,
    )
    assert urls == ["http://u:p@5.6.7.8:9000"]


def test_resolve_ignores_proxy_url_when_disabled():
    urls = resolve_scraper_proxies(
        fallback_proxy_url="http://u:p@5.6.7.8:9000",
        fallback_proxy_enabled=False,
    )
    assert urls == []


def test_resolve_loads_file(tmp_path):
    proxy_file = tmp_path / "proxies.txt"
    proxy_file.write_text("10.0.0.1:60000:user:pass\n# comment\n\n")
    urls = resolve_scraper_proxies(proxy_list_path=str(proxy_file))
    assert urls == ["http://user:pass@10.0.0.1:60000"]


def test_parse_proxy_line_url_passthrough():
    assert _parse_proxy_line("http://u:p@h:1") == "http://u:p@h:1"
