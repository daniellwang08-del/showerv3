import scrapy
from abc import abstractmethod
from datetime import date, datetime, timezone

from app.scraper.items import JobItem


def _parse_sync_date(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if len(text) == 10:
            parsed = datetime.strptime(text, "%Y-%m-%d")
        else:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except ValueError:
        return None


class BaseJobSpider(scrapy.Spider):
    """Base class for all job scraping spiders.

    Subclasses must implement:
        - start_requests() or set start_urls
        - parse_listing(response) -> yields requests to detail pages
        - parse_job(response) -> yields JobItem dicts

    Provides shared configuration and helper methods.
    """

    custom_settings: dict = {}

    # Subclasses must set these
    source_name: str = ""
    base_url: str = ""

    def __init__(self, query: str = "", location: str = "", pages: int = 5,
                 max_pages: int = None, posted_since: str | None = None,
                 posted_until: str | None = None, fresh: str | None = None,
                 *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.query = query
        self.search_location = location
        self.max_pages = int(max_pages) if max_pages is not None else int(pages)
        self.posted_since = _parse_sync_date(posted_since)
        self.posted_until = _parse_sync_date(posted_until)
        if self.posted_until is not None:
            self.posted_until = self.posted_until.replace(hour=23, minute=59, second=59)
        self._fresh_mode = str(fresh).lower() in ("1", "true", "yes") if fresh else False

    def _posted_in_range(self, posted_at: datetime | None) -> bool:
        if posted_at is None:
            return True
        dt = posted_at
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        if self.posted_since and dt < self.posted_since:
            return False
        if self.posted_until and dt > self.posted_until:
            return False
        return True

    def _page_too_old(self, posted_dates: list[datetime | None]) -> bool:
        """True when every dated job on the page is before posted_since."""
        if not self.posted_since:
            return False
        dated = [d for d in posted_dates if d is not None]
        if not dated:
            return False
        normalized = []
        for dt in dated:
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            normalized.append(dt)
        return max(normalized) < self.posted_since

    @abstractmethod
    def parse_listing(self, response):
        """Parse a search results page and yield requests to job detail pages."""

    @abstractmethod
    def parse_job(self, response):
        """Parse a job detail page and yield a JobItem dict."""

    def build_job_item(self, **kwargs) -> dict:
        """Helper to build a job item dict with source pre-filled."""
        kwargs.setdefault("source", self.source_name)
        return kwargs

    def make_playwright_request(self, url, callback, **kwargs):
        """Create a request that uses Playwright for rendering."""
        meta = kwargs.pop("meta", {})
        meta["playwright"] = True
        meta["playwright_include_page"] = kwargs.pop("include_page", False)
        return scrapy.Request(url, callback=callback, meta=meta, **kwargs)

    def make_api_request(self, url, callback, headers=None, **kwargs):
        """Create a direct HTTP request for JSON API endpoints."""
        default_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if headers:
            default_headers.update(headers)
        meta = kwargs.pop("meta", {})
        meta["playwright"] = False
        return scrapy.Request(
            url,
            callback=callback,
            headers=default_headers,
            meta=meta,
            **kwargs,
        )
