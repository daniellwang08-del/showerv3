"""Indeed spider -- Tier 3 (Full browser with stealth).

Indeed has aggressive anti-bot protections (Cloudflare, fingerprinting,
behavioral analysis). This spider uses Playwright with stealth settings
and human-like delays. Network interception captures JSON data from
Indeed's internal API when possible.
"""

import json
import random
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote_plus, urlencode

import scrapy

from app.scraper.spiders.base import BaseJobSpider
from app.scraper.utils.captcha import detect_captcha, detect_cloudflare_challenge


class IndeedSpider(BaseJobSpider):
    name = "indeed"
    source_name = "indeed"
    base_url = "https://www.indeed.com"
    allowed_domains = ["indeed.com"]

    custom_settings = {
        "DOWNLOAD_DELAY": 4,
        "RANDOMIZE_DOWNLOAD_DELAY": True,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 1.0,
        "PLAYWRIGHT_MAX_CONTEXTS": 1,
    }

    RESULTS_PER_PAGE = 10

    def start_requests(self):
        query = self.query or "software engineer"
        location = self.search_location or "Remote"

        for page in range(self.max_pages):
            start = page * self.RESULTS_PER_PAGE
            params = {
                "q": query,
                "l": location,
                "start": start,
                "fromage": 7,
            }
            url = f"{self.base_url}/jobs?{urlencode(params)}"

            yield self.make_playwright_request(
                url,
                callback=self.parse_listing,
                meta={
                    "page": page + 1,
                    "search_query": query,
                    "playwright_page_methods": [
                        {"method": "wait_for_timeout", "args": [random.randint(2000, 5000)]},
                    ],
                },
            )

    def parse_listing(self, response):
        if detect_cloudflare_challenge(response):
            self.logger.warning("Cloudflare challenge on %s - skipping", response.url)
            return
        if detect_captcha(response):
            self.logger.warning("CAPTCHA detected on %s - skipping", response.url)
            return

        mosaic_data = response.css("script#mosaic-data::text").get()
        if mosaic_data:
            yield from self._parse_mosaic_data(mosaic_data, response)
            return

        script_tags = response.css("script::text").getall()
        for script in script_tags:
            if "window.mosaic" in script or "jobResults" in script:
                yield from self._extract_json_from_script(script, response)
                return

        job_cards = response.css(
            "div.job_seen_beacon, div.jobsearch-ResultsList > div, "
            "li.css-5lfssm, div[data-jk], td.resultContent"
        )

        self.logger.info("Found %d job cards on page %s", len(job_cards), response.meta.get("page", "?"))

        for card in job_cards:
            job_key = (
                card.attrib.get("data-jk")
                or card.css("a[data-jk]::attr(data-jk)").get()
                or card.css("a::attr(data-jk)").get()
            )
            if not job_key:
                href = card.css("a::attr(href)").get("")
                jk_match = re.search(r"jk=([a-f0-9]+)", href)
                job_key = jk_match.group(1) if jk_match else None

            if not job_key:
                continue

            title = card.css(
                "h2.jobTitle span::text, a.jcs-JobTitle span::text, "
                "span[id^='jobTitle']::text"
            ).get("").strip()
            company = card.css(
                "span.companyName::text, span[data-testid='company-name']::text, "
                "span.css-1h7lukg::text"
            ).get("").strip()
            location = card.css(
                "div.companyLocation::text, div[data-testid='text-location']::text, "
                "span.css-1restlb::text"
            ).get("").strip()
            salary = card.css(
                "div.salary-snippet-container::text, "
                "div.metadata.salary-snippet-container span::text, "
                "div[data-testid='attribute_snippet_testid']::text"
            ).get()

            snippet = card.css(
                "div.job-snippet::text, td.snip ul li::text"
            ).getall()
            description = " ".join(s.strip() for s in snippet if s.strip())

            date_text = card.css(
                "span.date::text, span.css-qvloho::text"
            ).get("")
            posted_at = self._parse_relative_date(date_text)

            if title:
                yield self.build_job_item(
                    source_job_id=job_key,
                    url=f"{self.base_url}/viewjob?jk={job_key}",
                    title=title,
                    company_name=company,
                    location=location,
                    salary_raw=salary.strip() if salary else None,
                    description=description,
                    posted_at=posted_at,
                )

    def _parse_mosaic_data(self, script_text: str, response):
        try:
            data = json.loads(script_text)
        except json.JSONDecodeError:
            json_match = re.search(r"mosaic-provider-jobcards.*?\"results\":\s*(\[.*?\])", script_text, re.DOTALL)
            if json_match:
                try:
                    results = json.loads(json_match.group(1))
                    yield from self._process_results(results)
                except json.JSONDecodeError:
                    pass
            return

        results = data.get("results", [])
        if not results:
            for key in data:
                if isinstance(data[key], dict) and "results" in data[key]:
                    results = data[key]["results"]
                    break

        yield from self._process_results(results)

    def _extract_json_from_script(self, script: str, response):
        pattern = r'"results"\s*:\s*(\[[\s\S]*?\])\s*[,}]'
        match = re.search(pattern, script)
        if match:
            try:
                results = json.loads(match.group(1))
                yield from self._process_results(results)
            except json.JSONDecodeError:
                pass

    def _process_results(self, results: list):
        for result in results:
            if not isinstance(result, dict):
                continue
            job_key = result.get("jobkey", result.get("jk", ""))
            title = result.get("title", result.get("jobTitle", ""))
            company = result.get("company", result.get("companyName", ""))

            if not title or not job_key:
                continue

            location_data = result.get("formattedLocation", result.get("location", ""))
            salary_snippet = result.get("salarySnippet", {})
            salary_raw = None
            if isinstance(salary_snippet, dict):
                salary_raw = salary_snippet.get("text")
            elif isinstance(salary_snippet, str):
                salary_raw = salary_snippet

            yield self.build_job_item(
                source_job_id=job_key,
                url=f"{self.base_url}/viewjob?jk={job_key}",
                title=title,
                company_name=company,
                location=str(location_data),
                salary_raw=salary_raw,
                description=result.get("snippet", ""),
                job_type=result.get("jobType", None),
                posted_at=self._parse_relative_date(result.get("formattedRelativeTime", "")),
            )

    def _parse_relative_date(self, text: str):
        if not text:
            return None
        text = text.lower().strip()
        now = datetime.now(timezone.utc)
        match = re.search(r"(\d+)\s*(day|hour|minute)", text)
        if match:
            num = int(match.group(1))
            unit = match.group(2)
            if "day" in unit:
                return now - timedelta(days=num)
            elif "hour" in unit:
                return now - timedelta(hours=num)
            elif "minute" in unit:
                return now - timedelta(minutes=num)
        if "just posted" in text or "today" in text:
            return now
        return None

    def parse_job(self, response):
        """Parse individual Indeed job detail page."""
        if detect_captcha(response):
            return

        title = response.css("h1.jobsearch-JobInfoHeader-title span::text").get("")
        company = response.css(
            "div[data-company-name] a::text, "
            "div.jobsearch-InlineCompanyRating a::text"
        ).get("")
        location = response.css(
            "div[data-testid='inlineHeader-companyLocation'] div::text, "
            "div.jobsearch-InlineCompanyRating div::text"
        ).get("")
        description = response.css("div#jobDescriptionText").get("")
        salary = response.css("div#salaryInfoAndJobType span::text").get()

        jk = re.search(r"jk=([a-f0-9]+)", response.url)
        source_id = jk.group(1) if jk else response.url

        if title:
            yield self.build_job_item(
                source_job_id=str(source_id),
                url=response.url,
                title=title.strip(),
                company_name=company.strip(),
                location=location.strip(),
                salary_raw=salary.strip() if salary else None,
                description=description,
            )
