"""
Extract Welcome to the Jungle job content via the public Algolia search API.

WTTJ job pages are protected by AWS WAF (HTTP 202 + ``x-amzn-waf-action: challenge``),
which blocks both httpx and headless Playwright.  The same Algolia index the WTTJ
frontend uses is publicly accessible with the embedded API key - identical to the
Scrapy spider in ``app.scraper.spiders.welcometothejungle``.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.core.logging import get_logger

logger = get_logger(__name__)

ALGOLIA_APP_ID = "CSEKHVMS53"
ALGOLIA_API_KEY = "4bd8f6215d0cc52b26430765769e65a0"
ALGOLIA_INDEX_EN = "wttj_jobs_production_en"
ALGOLIA_URL = f"https://{ALGOLIA_APP_ID.lower()}-dsn.algolia.net/1/indexes/{ALGOLIA_INDEX_EN}/query"

WTTJ_HOST = "welcometothejungle.com"

WTTJ_JOB_URL_PATTERN = re.compile(
    rf"(?:https?://)?(?:www\.)?{re.escape(WTTJ_HOST)}/"
    r"(?:[a-z]{{2}}/)?companies/([^/?#]+)/jobs/([^/?#]+)",
    re.IGNORECASE,
)


def is_wttj_job_url(url: str) -> bool:
    return parse_wttj_job_url(url) is not None


def parse_wttj_job_url(url: str) -> tuple[str, str] | None:
    """Return (company_slug, job_slug) from a WTTJ job URL."""
    if not url:
        return None
    m = WTTJ_JOB_URL_PATTERN.search(url.strip())
    if not m:
        return None
    return m.group(1).strip(), m.group(2).strip()


def _text(val) -> str:
    if not val:
        return ""
    if isinstance(val, list):
        return "\n".join(str(v) for v in val if v)
    return str(val)


def _format_hit_as_plain_text(hit: dict) -> str:
    title = hit.get("name", "").strip()
    org = hit.get("organization") or {}
    company = org.get("name", "").strip() if isinstance(org, dict) else ""

    offices = hit.get("offices") or []
    location = ""
    if isinstance(offices, list) and offices:
        first = offices[0]
        if isinstance(first, dict):
            city = first.get("city", "")
            country = first.get("country_code", "")
            location = f"{city}, {country}" if city and country else city or country

    contract = hit.get("contract_type", "")
    remote = hit.get("remote", "")
    experience = hit.get("experience_level_minimum") or hit.get("experience_level", "")

    sal_min = hit.get("salary_yearly_minimum") or hit.get("salary_minimum")
    sal_max = hit.get("salary_yearly_maximum") or hit.get("salary_maximum")
    sal_currency = hit.get("salary_currency", "EUR")
    sal_period = hit.get("salary_period", "yearly")
    salary_line = ""
    if sal_min:
        salary_line = f"{sal_min}"
        if sal_max:
            salary_line += f" - {sal_max}"
        salary_line += f" {sal_currency}/{sal_period}"

    desc_parts = [
        _text(hit.get("summary")),
        _text(hit.get("profile")),
        _text(hit.get("key_missions")),
    ]
    description = "\n\n".join(p for p in desc_parts if p)

    skills = hit.get("skills") or []
    skills_line = ", ".join(str(s) for s in skills if s) if skills else ""

    lines = [
        f"Title: {title}" if title else "",
        f"Company: {company}" if company else "",
        f"Location: {location}" if location else "",
        f"Contract: {contract}" if contract else "",
        f"Remote: {remote}" if remote else "",
        f"Experience: {experience}" if experience else "",
        f"Salary: {salary_line}" if salary_line else "",
        f"Skills: {skills_line}" if skills_line else "",
        "",
        description,
    ]
    return "\n".join(line for line in lines if line is not None).strip()


class WttjAlgoliaExtractor(BaseExtractor):
    """Fetch WTTJ job postings from Algolia by company + job slug."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return is_wttj_job_url(url)

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        parsed = parse_wttj_job_url(url)
        if not parsed:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Not a WTTJ job URL",
            )

        company_slug, job_slug = parsed
        try:
            hit = await self._fetch_hit(company_slug, job_slug)
        except Exception as e:
            logger.warning("wttj_algolia_fetch_failed", url=url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=str(e),
            )

        if not hit:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"WTTJ job not found in Algolia: {company_slug}/{job_slug}",
            )

        plain_text = _format_hit_as_plain_text(hit)
        if len(plain_text) < 100:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="WTTJ Algolia hit returned insufficient text",
            )

        logger.info(
            "wttj_algolia_extract_success",
            url=url,
            company_slug=company_slug,
            job_slug=job_slug,
            content_length=len(plain_text),
        )
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
        )

    async def _fetch_hit(self, company_slug: str, job_slug: str) -> dict | None:
        """Query Algolia for a single job by organization + slug."""
        filters = f'organization.slug:"{company_slug}" AND slug:"{job_slug}"'
        body = {
            "query": "",
            "filters": filters,
            "hitsPerPage": 1,
            "page": 0,
        }
        headers = {
            "x-algolia-application-id": ALGOLIA_APP_ID,
            "x-algolia-api-key": ALGOLIA_API_KEY,
            "Content-Type": "application/json",
            "Referer": "https://www.welcometothejungle.com/",
            "Origin": "https://www.welcometothejungle.com",
        }

        response_text, status_code, _ = await self._http.post_json(
            ALGOLIA_URL,
            body=body,
            headers=headers,
        )
        if status_code >= 400:
            raise RuntimeError(f"Algolia HTTP {status_code}")

        data = json.loads(response_text)
        hits = data.get("hits") or []
        if hits:
            return hits[0]

        # Fallback: slug may differ slightly - search by company slug + job slug token
        fallback_body = {
            "query": job_slug.replace("_", " ").replace("-", " "),
            "filters": f'organization.slug:"{company_slug}"',
            "hitsPerPage": 5,
            "page": 0,
        }
        response_text, status_code, _ = await self._http.post_json(
            ALGOLIA_URL,
            body=fallback_body,
            headers=headers,
        )
        if status_code >= 400:
            return None

        data = json.loads(response_text)
        for hit in data.get("hits") or []:
            slug = (hit.get("slug") or "").strip()
            ref = (hit.get("reference") or "").strip()
            if slug == job_slug or ref == job_slug or job_slug in slug:
                return hit
        return None
