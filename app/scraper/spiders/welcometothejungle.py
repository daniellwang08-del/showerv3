"""Welcome to the Jungle spider -- Tier 1 (Algolia API).

WTTJ uses Algolia for its job search. We hit the public Algolia search API
directly -- no browser needed. The API key is embedded in WTTJ's frontend JS
and is restricted by Referer header.
"""

import json
from datetime import datetime
from urllib.parse import quote

import scrapy

from app.scraper.spiders.base import BaseJobSpider

ALGOLIA_APP_ID = "CSEKHVMS53"
ALGOLIA_API_KEY = "4bd8f6215d0cc52b26430765769e65a0"
ALGOLIA_INDEX_EN = "wttj_jobs_production_en"
ALGOLIA_URL = f"https://{ALGOLIA_APP_ID.lower()}-dsn.algolia.net/1/indexes/{ALGOLIA_INDEX_EN}/query"


class WelcomeToTheJungleSpider(BaseJobSpider):
    name = "welcometothejungle"
    source_name = "welcometothejungle"
    base_url = "https://www.welcometothejungle.com"
    allowed_domains = ["welcometothejungle.com", "algolia.net"]

    custom_settings = {
        "DOWNLOAD_DELAY": 1,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 2,
        "DOWNLOAD_HANDLERS": {
            "http": "scrapy.core.downloader.handlers.http.HTTPDownloadHandler",
            "https": "scrapy.core.downloader.handlers.http.HTTPDownloadHandler",
        },
    }

    HITS_PER_PAGE = 50

    DEFAULT_SEARCH_TERMS = [
        "software engineer",
        "data engineer",
        "backend developer",
        "frontend developer",
        "full stack developer",
        "devops engineer",
        "machine learning",
        "product manager",
        "data scientist",
        "mobile developer",
    ]

    def start_requests(self):
        terms = [self.query] if self.query else self.DEFAULT_SEARCH_TERMS
        for term in terms:
            yield from self._make_algolia_request(term, page=0)

    def _make_algolia_request(self, query: str, page: int = 0, filters: str = ""):
        body = {
            "query": query,
            "hitsPerPage": self.HITS_PER_PAGE,
            "page": page,
        }
        if filters:
            body["filters"] = filters

        headers = {
            "x-algolia-application-id": ALGOLIA_APP_ID,
            "x-algolia-api-key": ALGOLIA_API_KEY,
            "Content-Type": "application/json",
            "Referer": "https://www.welcometothejungle.com/",
            "Origin": "https://www.welcometothejungle.com",
        }

        yield scrapy.Request(
            ALGOLIA_URL,
            method="POST",
            body=json.dumps(body),
            headers=headers,
            callback=self.parse_listing,
            meta={
                "search_query": query,
                "page": page,
                "filters": filters,
                "playwright": False,
            },
            dont_filter=True,
        )

    def parse_listing(self, response):
        try:
            data = json.loads(response.text)
        except json.JSONDecodeError:
            self.logger.error("Failed to parse Algolia response from %s", response.url)
            return

        hits = data.get("hits", [])
        nb_pages = data.get("nbPages", 0)
        current_page = data.get("page", 0)
        query = response.meta["search_query"]

        self.logger.info(
            "WTTJ Algolia: query='%s' page=%d/%d hits=%d",
            query, current_page + 1, nb_pages, len(hits),
        )

        for hit in hits:
            item = self._parse_hit(hit)
            if item:
                yield item

        if current_page + 1 < nb_pages and current_page + 1 < self.max_pages:
            yield from self._make_algolia_request(
                query,
                page=current_page + 1,
                filters=response.meta.get("filters", ""),
            )

    def _parse_hit(self, hit: dict) -> dict | None:
        title = hit.get("name", "")
        if not title:
            return None

        org = hit.get("organization", {})
        if isinstance(org, dict):
            company_name = org.get("name", "")
            org_slug = org.get("slug", "")
        else:
            company_name = ""
            org_slug = ""

        job_slug = hit.get("slug", hit.get("reference", ""))
        source_job_id = hit.get("reference", hit.get("objectID", str(job_slug)))

        if org_slug and job_slug:
            url = f"{self.base_url}/en/companies/{org_slug}/jobs/{job_slug}"
        else:
            url = f"{self.base_url}/en/jobs/{source_job_id}"

        offices = hit.get("offices", [])
        location = ""
        if isinstance(offices, list) and offices:
            first = offices[0]
            if isinstance(first, dict):
                city = first.get("city", "")
                country = first.get("country_code", "")
                location = f"{city}, {country}" if city and country else city or country

        remote_level = hit.get("remote", "")
        is_remote = remote_level in ("fulltime", "partial")

        def _text(val):
            if not val:
                return ""
            if isinstance(val, list):
                return "\n".join(str(v) for v in val)
            return str(val)

        desc_parts = [
            _text(hit.get("summary")),
            _text(hit.get("profile")),
            _text(hit.get("key_missions")),
        ]
        description = "\n\n".join(p for p in desc_parts if p)

        sal_min = hit.get("salary_yearly_minimum") or hit.get("salary_minimum")
        sal_max = hit.get("salary_yearly_maximum") or hit.get("salary_maximum")
        sal_currency = hit.get("salary_currency", "EUR")
        sal_period = hit.get("salary_period", "yearly")

        salary_raw = None
        if sal_min:
            salary_raw = f"{sal_min}"
            if sal_max:
                salary_raw += f" - {sal_max}"
            salary_raw += f" {sal_currency}/{sal_period}"

        published = hit.get("published_at", "")
        posted_at = None
        if published:
            try:
                posted_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        contract = hit.get("contract_type", "")
        experience = hit.get("experience_level_minimum", hit.get("experience_level", ""))

        return self.build_job_item(
            source_job_id=str(source_job_id),
            url=url,
            title=title,
            company_name=company_name,
            location=location,
            is_remote=is_remote,
            salary_raw=salary_raw,
            salary_min_cents=int(sal_min * 100) if sal_min else None,
            salary_max_cents=int(sal_max * 100) if sal_max else None,
            salary_currency=sal_currency,
            salary_period=sal_period,
            description=description,
            job_type=contract.lower() if contract else None,
            experience_level=str(experience) if experience else None,
            tags=hit.get("skills", []),
            posted_at=posted_at,
        )

    def parse_job(self, response):
        """Not used -- all data comes from Algolia API."""
        pass
