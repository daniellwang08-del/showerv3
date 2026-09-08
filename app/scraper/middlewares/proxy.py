import random
import logging

from scrapy import signals

logger = logging.getLogger(__name__)


class ProxyMiddleware:
    """Rotate through the residential proxy pool.

    Resolution is delegated to app.scraper.utils.proxies, which normalises every
    supported form into ``http://user:pass@host:port``. This used to read the
    file itself and simply prepend a scheme, which turns the common
    ``host:port:user:pass`` line into a URL whose port reads
    ``port:user:pass``; urllib rejects that, so every proxied request raised
    ValueError. The failure was silent from the outside because the spider
    still closed cleanly, having scraped nothing.

    Sharing the resolver also means this picks up SCRAPER_PROXY_URL and the
    host/port/user/password components, not just PROXY_LIST_PATH, so it sees
    the same pool as the RemoteRocketship Cloudflare session.
    """

    def __init__(self, proxies: list[str] | None = None):
        self.proxies: list[str] = list(proxies or [])

    @classmethod
    def from_crawler(cls, crawler):
        from app.scraper.utils.proxies import resolve_scraper_proxies

        middleware = cls(
            resolve_scraper_proxies(
                proxy_list_path=crawler.settings.get("PROXY_LIST_PATH", "") or ""
            )
        )
        crawler.signals.connect(middleware.spider_opened, signal=signals.spider_opened)
        return middleware

    def spider_opened(self, spider):
        if self.proxies:
            spider.logger.info("ProxyMiddleware: %d proxies available", len(self.proxies))
        else:
            spider.logger.info("ProxyMiddleware: no proxies configured, using direct connection")

    def process_request(self, request, spider):
        if not self.proxies:
            return None
        if request.meta.get("no_proxy"):
            return None
        # Already normalised to a full URL by the resolver.
        request.meta["proxy"] = random.choice(self.proxies)
        return None

    def process_exception(self, request, exception, spider):
        proxy = request.meta.get("proxy")
        if not proxy or proxy not in self.proxies:
            return None
        # Eviction only became reachable once meta and the pool held the same
        # normalised URL; before that the membership test never matched. Keep
        # the last proxy regardless of errors: dropping it would silently move
        # the crawl onto the datacentre IP these sites block, which is worse
        # than retrying through a proxy having a bad minute.
        if len(self.proxies) == 1:
            logger.warning("Proxy failed but it is the only one; keeping it: %s", exception)
            return None
        logger.warning("Proxy failed, removing from pool: %s", exception)
        self.proxies.remove(proxy)
        return None
