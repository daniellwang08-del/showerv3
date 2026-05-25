import scrapy
from abc import abstractmethod

from app.scraper.items import JobItem


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
                 max_pages: int = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.query = query
        self.search_location = location
        self.max_pages = int(max_pages) if max_pages is not None else int(pages)

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
