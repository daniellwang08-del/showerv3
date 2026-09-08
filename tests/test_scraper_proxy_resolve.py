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


class _FakeSignals:
    def connect(self, *args, **kwargs):
        pass


class _FakeCrawler:
    def __init__(self, settings):
        self.settings = settings
        self.signals = _FakeSignals()


def test_middleware_normalises_host_port_user_pass(tmp_path):
    """The middleware must not hand Scrapy a raw host:port:user:pass line.

    Prepending a scheme to that form yields a URL whose port parses as
    "port:user:pass", which urllib rejects with ValueError on every request.
    In production that took a spider to zero items while it still reported
    closing successfully, so nothing surfaced the breakage.
    """
    from app.scraper.middlewares.proxy import ProxyMiddleware

    proxy_file = tmp_path / "proxies.txt"
    proxy_file.write_text("10.0.0.1:50100:user:pa55\n")

    middleware = ProxyMiddleware.from_crawler(
        _FakeCrawler({"PROXY_LIST_PATH": str(proxy_file)})
    )
    assert middleware.proxies == ["http://user:pa55@10.0.0.1:50100"]

    request = type("R", (), {"meta": {}})()
    middleware.process_request(request, spider=None)
    proxy = request.meta["proxy"]
    assert proxy == "http://user:pa55@10.0.0.1:50100"

    # The parse that used to blow up.
    from urllib.parse import urlparse

    assert urlparse(proxy).port == 50100


def test_middleware_keeps_its_last_proxy_on_failure(tmp_path):
    # Evicting the only proxy would move the crawl onto the datacentre IP these
    # sites block, which is worse than retrying through a flaky proxy.
    from app.scraper.middlewares.proxy import ProxyMiddleware

    proxy_file = tmp_path / "proxies.txt"
    proxy_file.write_text("10.0.0.1:50100:user:pa55\n")
    middleware = ProxyMiddleware.from_crawler(
        _FakeCrawler({"PROXY_LIST_PATH": str(proxy_file)})
    )

    request = type("R", (), {"meta": {"proxy": middleware.proxies[0]}})()
    middleware.process_exception(request, OSError("boom"), spider=None)
    assert len(middleware.proxies) == 1


def test_middleware_evicts_a_failing_proxy_when_others_remain(tmp_path):
    from app.scraper.middlewares.proxy import ProxyMiddleware

    proxy_file = tmp_path / "proxies.txt"
    proxy_file.write_text("10.0.0.1:50100:user:pa55\n10.0.0.2:50100:user:pa55\n")
    middleware = ProxyMiddleware.from_crawler(
        _FakeCrawler({"PROXY_LIST_PATH": str(proxy_file)})
    )

    doomed = middleware.proxies[0]
    request = type("R", (), {"meta": {"proxy": doomed}})()
    middleware.process_exception(request, OSError("boom"), spider=None)
    assert doomed not in middleware.proxies
    assert len(middleware.proxies) == 1
