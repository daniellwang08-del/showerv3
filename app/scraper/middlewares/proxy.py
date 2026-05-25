import random
import logging
from pathlib import Path

from scrapy import signals

logger = logging.getLogger(__name__)


class ProxyMiddleware:
    """Rotate through a list of proxies loaded from a file.

    Set PROXY_LIST_PATH in settings or .env to enable.
    If no proxy file is configured, requests go direct.
    """

    def __init__(self, proxy_list_path: str = ""):
        self.proxies: list[str] = []
        self._load_proxies(proxy_list_path)

    @classmethod
    def from_crawler(cls, crawler):
        proxy_path = crawler.settings.get("PROXY_LIST_PATH", "")
        middleware = cls(proxy_path)
        crawler.signals.connect(middleware.spider_opened, signal=signals.spider_opened)
        return middleware

    def _load_proxies(self, path: str):
        if not path:
            return
        p = Path(path)
        if not p.exists():
            logger.warning("Proxy list file not found: %s", path)
            return
        lines = p.read_text().strip().splitlines()
        self.proxies = [line.strip() for line in lines if line.strip() and not line.startswith("#")]
        logger.info("Loaded %d proxies from %s", len(self.proxies), path)

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
        proxy = random.choice(self.proxies)
        if not proxy.startswith("http"):
            proxy = f"http://{proxy}"
        request.meta["proxy"] = proxy
        return None

    def process_exception(self, request, exception, spider):
        proxy = request.meta.get("proxy")
        if proxy and proxy in self.proxies:
            logger.warning("Proxy failed: %s — removing from pool", proxy)
            self.proxies.remove(proxy)
        return None
