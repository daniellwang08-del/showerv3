"""Glassdoor spider -- Tier 2-3 (Playwright with LD+JSON extraction).

Glassdoor provides structured data via JSON-LD and Apollo state embedded
in the page. We use Playwright to render the page and extract structured
data from script tags.
"""

import json
import re
from datetime import datetime
from urllib.parse import quote_plus, urlencode

import scrapy

from app.scraper.spiders.base import BaseJobSpider
from app.scraper.utils.captcha import detect_captcha, detect_cloudflare_challenge


class GlassdoorSpider(BaseJobSpider):
    name = "glassdoor"
    source_name = "glassdoor"
    base_url = "https://www.glassdoor.com"
    allowed_domains = ["glassdoor.com"]

    custom_settings = {
        "DOWNLOAD_DELAY": 4,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "PLAYWRIGHT_MAX_CONTEXTS": 1,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 1.0,
    }

    def start_requests(self):
        query = self.query or "software engineer"
        location = self.search_location or ""

        for page in range(1, self.max_pages + 1):
            keyword_param = quote_plus(query)
            url = f"{self.base_url}/Job/jobs.htm?sc.keyword={keyword_param}"
            if location:
                url += f"&locT=C&locKeyword={quote_plus(location)}"
            if page > 1:
                url += f"&p={page}"

            yield self.make_playwright_request(
                url,
                callback=self.parse_listing,
                meta={"page": page},
            )

    def parse_listing(self, response):
        if detect_cloudflare_challenge(response):
            self.logger.warning("Cloudflare challenge on %s", response.url)
            return
        if detect_captcha(response):
            self.logger.warning("CAPTCHA on %s", response.url)
            return

        ld_json_tags = response.css('script[type="application/ld+json"]::text').getall()
        for ld in ld_json_tags:
            try:
                data = json.loads(ld)
                if isinstance(data, dict) and data.get("@type") == "ItemList":
                    elements = data.get("itemListElement", [])
                    for el in elements:
                        item_data = el.get("item", el)
                        if item_data.get("@type") == "JobPosting":
                            yield from self._parse_job_posting_ld(item_data)
                    if elements:
                        return
                elif isinstance(data, dict) and data.get("@type") == "JobPosting":
                    yield from self._parse_job_posting_ld(data)
                    return
                elif isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict) and item.get("@type") == "JobPosting":
                            yield from self._parse_job_posting_ld(item)
                    return
            except json.JSONDecodeError:
                continue

        scripts = response.css("script::text").getall()
        for script in scripts:
            if "apolloState" in script or "jobListings" in script:
                yield from self._extract_from_apollo(script)
                return

        job_cards = response.css(
            "li.JobsList_jobListItem__wjTHv, li[data-test='jobListing'], "
            "li.react-job-listing, div.jobCard"
        )
        self.logger.info("Glassdoor: %d cards via DOM on page %s", len(job_cards), response.meta.get("page", "?"))

        for card in job_cards:
            title = card.css(
                "a.JobCard_jobTitle__GLyJ1::text, a.job-title::text, "
                "a[data-test='job-link']::text"
            ).get("").strip()

            href = card.css(
                "a.JobCard_jobTitle__GLyJ1::attr(href), a.job-title::attr(href), "
                "a[data-test='job-link']::attr(href)"
            ).get("")

            company = card.css(
                "span.EmployerProfile_employerName__sZlNl::text, "
                "div.job-company::text, span.EmployerProfile_companyName__rtnmn::text"
            ).get("").strip()

            location = card.css(
                "span.JobCard_location__N_iYE::text, "
                "span.job-location::text, div.location::text"
            ).get("").strip()

            salary = card.css(
                "span.JobCard_salaryEstimate__QpbTW::text, "
                "span.salary-estimate::text"
            ).get()

            source_id = ""
            if href:
                id_match = re.search(r"jobListingId=(\d+)", href)
                if id_match:
                    source_id = id_match.group(1)
                else:
                    id_match = re.search(r"-(\d+)\.htm", href)
                    source_id = id_match.group(1) if id_match else href.split("/")[-1]

            if title and source_id:
                job_url = href if href.startswith("http") else f"{self.base_url}{href}"
                yield self.build_job_item(
                    source_job_id=source_id,
                    url=job_url,
                    title=title,
                    company_name=company,
                    location=location,
                    salary_raw=salary.strip() if salary else None,
                )

    def _parse_job_posting_ld(self, data: dict):
        title = data.get("title", "")
        if not title:
            return

        company_data = data.get("hiringOrganization", {})
        company = ""
        if isinstance(company_data, dict):
            company = company_data.get("name", "")

        location_data = data.get("jobLocation", data.get("jobLocationType", ""))
        location = ""
        if isinstance(location_data, dict):
            addr = location_data.get("address", {})
            if isinstance(addr, dict):
                city = addr.get("addressLocality", "")
                state = addr.get("addressRegion", "")
                location = f"{city}, {state}" if city else state
        elif isinstance(location_data, list) and location_data:
            first = location_data[0]
            if isinstance(first, dict):
                addr = first.get("address", {})
                city = addr.get("addressLocality", "")
                state = addr.get("addressRegion", "")
                location = f"{city}, {state}" if city else state

        salary_raw = None
        salary_data = data.get("baseSalary", {})
        if isinstance(salary_data, dict):
            value = salary_data.get("value", {})
            currency = salary_data.get("currency", "USD")
            if isinstance(value, dict):
                min_val = value.get("minValue")
                max_val = value.get("maxValue")
                if min_val:
                    salary_raw = f"{currency} {min_val}"
                    if max_val:
                        salary_raw += f" - {max_val}"

        url = data.get("url", "")
        if not url.startswith("http"):
            url = f"{self.base_url}{url}" if url else ""

        source_id_match = re.search(r"jobListingId=(\d+)", url)
        if not source_id_match:
            source_id_match = re.search(r"-(\d+)\.htm", url)
        source_id = source_id_match.group(1) if source_id_match else url.split("/")[-1]

        posted = data.get("datePosted", "")
        posted_at = None
        if posted:
            try:
                posted_at = datetime.fromisoformat(posted.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        yield self.build_job_item(
            source_job_id=str(source_id),
            url=url,
            title=title,
            company_name=company,
            location=location,
            salary_raw=salary_raw,
            description=data.get("description", ""),
            job_type=data.get("employmentType", "").lower() if data.get("employmentType") else None,
            posted_at=posted_at,
        )

    def _extract_from_apollo(self, script: str):
        pattern = r'"JobPosting:(\d+)".*?"title":"(.*?)".*?"companyName":"(.*?)"'
        for match in re.finditer(pattern, script):
            source_id, title, company = match.groups()
            yield self.build_job_item(
                source_job_id=source_id,
                url=f"{self.base_url}/job-listing/?jl={source_id}",
                title=title,
                company_name=company,
            )

    def parse_job(self, response):
        """Parse individual Glassdoor job page."""
        if detect_captcha(response):
            return

        ld_json = response.css('script[type="application/ld+json"]::text').get()
        if ld_json:
            try:
                data = json.loads(ld_json)
                if isinstance(data, dict) and data.get("@type") == "JobPosting":
                    yield from self._parse_job_posting_ld(data)
                    return
            except json.JSONDecodeError:
                pass
