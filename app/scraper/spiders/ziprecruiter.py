"""ZipRecruiter spider -- Tier 2 (Playwright with network interception).

ZipRecruiter loads job data via internal API calls. We use Playwright
to render the page and intercept the JSON responses, reducing the need
for fragile DOM selectors.
"""

import json
import random
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import scrapy

from app.scraper.spiders.base import BaseJobSpider
from app.scraper.utils.captcha import detect_captcha


class ZipRecruiterSpider(BaseJobSpider):
    name = "ziprecruiter"
    source_name = "ziprecruiter"
    base_url = "https://www.ziprecruiter.com"
    allowed_domains = ["ziprecruiter.com"]

    custom_settings = {
        "DOWNLOAD_DELAY": 3,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "PLAYWRIGHT_MAX_CONTEXTS": 2,
    }

    RESULTS_PER_PAGE = 20

    def start_requests(self):
        query = self.query or "software engineer"
        location = self.search_location or "Remote"

        for page in range(1, self.max_pages + 1):
            params = {
                "search": query,
                "location": location,
                "page": page,
                "days": 7,
            }
            url = f"{self.base_url}/jobs-search?{urlencode(params)}"

            yield self.make_playwright_request(
                url,
                callback=self.parse_listing,
                meta={
                    "page": page,
                    "playwright_page_methods": [
                        {"method": "wait_for_timeout", "args": [random.randint(2000, 4000)]},
                    ],
                },
            )

    def parse_listing(self, response):
        if detect_captcha(response):
            self.logger.warning("CAPTCHA detected on %s — skipping", response.url)
            return

        ld_json = response.css('script[type="application/ld+json"]::text').getall()
        for ld in ld_json:
            try:
                data = json.loads(ld)
                if isinstance(data, list):
                    for item in data:
                        if item.get("@type") == "JobPosting":
                            yield from self._parse_ld_json(item)
                elif isinstance(data, dict) and data.get("@type") == "JobPosting":
                    yield from self._parse_ld_json(data)
            except json.JSONDecodeError:
                continue

        next_data = response.css("script#__NEXT_DATA__::text").get()
        if next_data:
            try:
                data = json.loads(next_data)
                props = data.get("props", {}).get("pageProps", {})
                jobs = props.get("jobs", props.get("jobList", []))
                for job in jobs:
                    yield from self._parse_api_job(job)
                return
            except json.JSONDecodeError:
                pass

        script_tags = response.css("script::text").getall()
        for script in script_tags:
            if '"jobList"' in script or '"jobs"' in script:
                pattern = r'"(?:jobList|jobs)"\s*:\s*(\[[\s\S]*?\])\s*[,}]'
                match = re.search(pattern, script)
                if match:
                    try:
                        jobs = json.loads(match.group(1))
                        for job in jobs:
                            yield from self._parse_api_job(job)
                        return
                    except json.JSONDecodeError:
                        continue

        job_cards = response.css(
            "article.job-listing, div.job_result, "
            "div[data-testid='job-listing'], li.job-listing"
        )
        self.logger.info("ZipRecruiter: %d job cards via DOM on page %s", len(job_cards), response.meta.get("page", "?"))

        for card in job_cards:
            title_el = card.css(
                "h2.job-title a::text, a.job_link::text, "
                "h2 a::text, span.job-title::text"
            )
            title = title_el.get("").strip()

            href = card.css(
                "h2.job-title a::attr(href), a.job_link::attr(href), "
                "h2 a::attr(href)"
            ).get("")

            company = card.css(
                "a.company-name::text, span.company-name::text, "
                "p.company-name::text, a[data-testid='company-name']::text"
            ).get("").strip()

            location = card.css(
                "span.location::text, p.job-location::text, "
                "span[data-testid='job-location']::text"
            ).get("").strip()

            salary = card.css(
                "span.salary::text, p.job-salary::text, "
                "span[data-testid='job-salary']::text"
            ).get()

            snippet = card.css("p.job-snippet::text, div.job-snippet::text").get("")

            source_id = ""
            if href:
                id_match = re.search(r"/([a-f0-9]+)(?:\?|$)", href)
                source_id = id_match.group(1) if id_match else href.split("/")[-1].split("?")[0]

            if title and source_id:
                job_url = href if href.startswith("http") else f"{self.base_url}{href}"
                yield self.build_job_item(
                    source_job_id=source_id,
                    url=job_url,
                    title=title,
                    company_name=company,
                    location=location,
                    salary_raw=salary.strip() if salary else None,
                    description=snippet.strip(),
                )

    def _parse_ld_json(self, data: dict):
        title = data.get("title", "")
        if not title:
            return

        company_data = data.get("hiringOrganization", {})
        company = company_data.get("name", "") if isinstance(company_data, dict) else ""

        location_data = data.get("jobLocation", {})
        location = ""
        if isinstance(location_data, dict):
            address = location_data.get("address", {})
            if isinstance(address, dict):
                city = address.get("addressLocality", "")
                state = address.get("addressRegion", "")
                location = f"{city}, {state}" if city else state

        salary_data = data.get("baseSalary", {})
        salary_raw = None
        if isinstance(salary_data, dict):
            value = salary_data.get("value", {})
            if isinstance(value, dict):
                min_val = value.get("minValue")
                max_val = value.get("maxValue")
                currency = salary_data.get("currency", "USD")
                if min_val:
                    salary_raw = f"{currency} {min_val}"
                    if max_val:
                        salary_raw += f" - {max_val}"

        url = data.get("url", "")
        source_id = re.search(r"/([a-f0-9]+)(?:\?|$)", url)

        posted = data.get("datePosted", "")
        posted_at = None
        if posted:
            try:
                posted_at = datetime.fromisoformat(posted.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        yield self.build_job_item(
            source_job_id=source_id.group(1) if source_id else url.split("/")[-1],
            url=url or f"{self.base_url}/jobs",
            title=title,
            company_name=company,
            location=location,
            salary_raw=salary_raw,
            description=data.get("description", ""),
            job_type=data.get("employmentType", "").lower() if data.get("employmentType") else None,
            posted_at=posted_at,
        )

    def _parse_api_job(self, job: dict):
        title = job.get("title", job.get("name", ""))
        if not title:
            return

        source_id = str(job.get("id", job.get("jobId", "")))
        url = job.get("url", job.get("job_url", ""))
        if not url:
            url = f"{self.base_url}/jobs/{source_id}"
        elif not url.startswith("http"):
            url = f"{self.base_url}{url}"

        company = job.get("company", job.get("hiring_company", {}).get("name", ""))
        if isinstance(company, dict):
            company = company.get("name", "")

        location = job.get("location", job.get("formatted_location", ""))
        salary_raw = job.get("salary", job.get("salary_range", ""))
        if isinstance(salary_raw, dict):
            salary_raw = salary_raw.get("text", str(salary_raw))

        yield self.build_job_item(
            source_job_id=source_id,
            url=url,
            title=title,
            company_name=str(company),
            location=str(location),
            salary_raw=str(salary_raw) if salary_raw else None,
            description=job.get("snippet", job.get("description", "")),
            job_type=job.get("employment_type", None),
        )

    def parse_job(self, response):
        """Parse individual ZipRecruiter job detail page."""
        if detect_captcha(response):
            return

        ld_json = response.css('script[type="application/ld+json"]::text').get()
        if ld_json:
            try:
                data = json.loads(ld_json)
                if isinstance(data, dict) and data.get("@type") == "JobPosting":
                    yield from self._parse_ld_json(data)
                    return
            except json.JSONDecodeError:
                pass

        title = response.css("h1.job-title::text, h1::text").get("").strip()
        company = response.css("a.company-name::text, span.company-name::text").get("").strip()
        description = response.css("div.job-description, div.jobDescriptionSection").get("")

        if title:
            yield self.build_job_item(
                source_job_id=response.url.split("/")[-1].split("?")[0],
                url=response.url,
                title=title,
                company_name=company,
                description=description,
            )
