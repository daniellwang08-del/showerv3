import random
from scrapy import signals
from scrapy.http import Request


BROWSER_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]

ACCEPT_LANGUAGES = [
    "en-US,en;q=0.9",
    "en-GB,en;q=0.9",
    "en-US,en;q=0.9,fr;q=0.8",
    "en-US,en;q=0.8",
]


class StealthMiddleware:
    """Inject browser-realistic headers and optional Playwright stealth settings."""

    @classmethod
    def from_crawler(cls, crawler):
        middleware = cls()
        crawler.signals.connect(middleware.spider_opened, signal=signals.spider_opened)
        return middleware

    def spider_opened(self, spider):
        spider.logger.info("StealthMiddleware enabled")

    def process_request(self, request: Request, spider):
        ua = random.choice(BROWSER_USER_AGENTS)
        request.headers.setdefault(b"User-Agent", ua)
        request.headers.setdefault(b"Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        request.headers.setdefault(b"Accept-Language", random.choice(ACCEPT_LANGUAGES))
        request.headers.setdefault(b"Accept-Encoding", "gzip, deflate, br")
        request.headers.setdefault(b"Sec-Fetch-Dest", "document")
        request.headers.setdefault(b"Sec-Fetch-Mode", "navigate")
        request.headers.setdefault(b"Sec-Fetch-Site", "none")
        request.headers.setdefault(b"Sec-Fetch-User", "?1")
        request.headers.setdefault(b"Upgrade-Insecure-Requests", "1")
        request.headers.setdefault(b"DNT", "1")

        if request.meta.get("playwright"):
            request.meta.setdefault("playwright_context_kwargs", {
                "viewport": {"width": random.randint(1280, 1920), "height": random.randint(800, 1080)},
                "locale": "en-US",
                "timezone_id": "America/New_York",
            })

        return None
