"""
Extract job content from Ashby using the public Posting API.

https://api.ashbyhq.com/posting-api/job-board/{company_slug}

Returns plain text content (not structured fields) for downstream LLM analysis.
No API key required.
"""

import json
import re
from urllib.parse import urlparse

from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html
from app.core.logging import get_logger

logger = get_logger(__name__)

ASHBY_URL_PATTERN = re.compile(
    r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
ASHBY_JID_QUERY_PATTERN = re.compile(
    r"[?&]ashby_jid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_SLUG_FROM_HTML_PATTERNS = (
    re.compile(r"jobs\.ashbyhq\.com/([^/\"'\s<>]+)/", re.IGNORECASE),
    re.compile(r"jobs\.ashbyhq\.com%2F([^%\"'\s]+)%2F", re.IGNORECASE),
)
ASHBY_API_BASE = "https://api.ashbyhq.com/posting-api/job-board"
_MAX_SLUG_CANDIDATES = 2


def is_ashby_job_url(url: str) -> bool:
    return _parse_ashby_url(url) is not None


def _parse_ashby_url(url: str) -> tuple[str, str] | None:
    try:
        parsed = urlparse(url)
        host = parsed.netloc or ""
        path = parsed.path or ""
        full = f"{host}{path}"
        m = ASHBY_URL_PATTERN.search(full)
        if m:
            return m.group(1), m.group(2).lower()
    except Exception:
        pass
    return None


def parse_ashby_jid_from_url(url: str) -> str | None:
    if not url:
        return None
    m = ASHBY_JID_QUERY_PATTERN.search(url)
    return m.group(1).lower() if m else None


def extract_ashby_company_slugs_from_html(html: str | None) -> list[str]:
    if not html:
        return []
    seen: list[str] = []
    for pat in _SLUG_FROM_HTML_PATTERNS:
        for m in pat.finditer(html):
            slug = m.group(1).strip().rstrip("/")
            if slug and slug not in seen:
                seen.append(slug)
            if len(seen) >= _MAX_SLUG_CANDIDATES:
                return seen
    return seen


class AshbyApiExtractor(BaseExtractor):
    """Extract job content via Ashby public Posting API as plain text."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return _parse_ashby_url(url) is not None

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        parsed = _parse_ashby_url(url)
        if not parsed:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Invalid Ashby URL: could not parse company_slug/job_id",
            )

        company_slug, job_id = parsed
        return await self._fetch_and_convert(company_slug, job_id, url)

    async def extract_embedded(self, url: str, html: str) -> ExtractionResult:
        """
        Company career pages with ``?ashby_jid=<uuid>`` and Ashby board slug in HTML.
        """
        job_id = parse_ashby_jid_from_url(url)
        if not job_id:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No ashby_jid in URL",
            )
        slugs = extract_ashby_company_slugs_from_html(html)
        if not slugs:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Could not find jobs.ashbyhq.com board slug in HTML",
            )
        last_err: str | None = None
        for company_slug in slugs:
            res = await self._fetch_and_convert(company_slug, job_id, url)
            if res.success:
                logger.info(
                    "ashby_api_embedded_success",
                    url=url,
                    job_id=job_id,
                    company_slug=company_slug,
                )
                return res
            last_err = res.error
        return ExtractionResult(
            success=False,
            method=self.method,
            error=last_err or "Ashby embedded extraction failed",
        )

    async def _fetch_and_convert(self, company_slug: str, job_id: str, url: str) -> ExtractionResult:
        api_url = f"{ASHBY_API_BASE}/{company_slug}?includeCompensation=true"

        try:
            text, status_code, _ = await self._http.fetch_json(api_url)
        except Exception as e:
            logger.warning("ashby_api_fetch_failed", url=api_url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Ashby API request failed: {e}",
            )

        if status_code != 200:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Ashby API returned {status_code}",
            )

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning("ashby_api_json_invalid", url=api_url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Invalid JSON from Ashby API",
            )

        jobs = data.get("jobs") or data.get("results") or []
        if not isinstance(jobs, list):
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Ashby API response has no jobs list",
            )

        job = None
        for j in jobs:
            if not isinstance(j, dict):
                continue
            jid = (j.get("id") or "").lower()
            jurl = (j.get("jobUrl") or j.get("jobPostingUrl") or "").lower()
            if jid == job_id or job_id in jurl:
                job = j
                break

        if not job:
            logger.info(
                "ashby_api_job_not_found",
                url=url,
                job_id=job_id,
                jobs_count=len(jobs),
            )
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Job {job_id} not found in Ashby API response ({len(jobs)} jobs)",
            )

        plain_text = self._job_to_plain_text(job)
        if not plain_text or len(plain_text) < 50:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Insufficient content from Ashby API",
            )

        logger.info("ashby_api_extraction_success", url=url, job_id=job_id, content_length=len(plain_text))
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data=None,
        )

    def _job_to_plain_text(self, job: dict) -> str:
        """Convert Ashby API job object to readable plain text with all available fields."""
        parts: list[str] = []

        if job.get("title"):
            parts.append(f"Title: {job['title']}")

        if job.get("location"):
            parts.append(f"Location: {job['location']}")

        if job.get("employmentType"):
            parts.append(f"Employment Type: {str(job['employmentType']).replace('_', ' ').title()}")

        if job.get("department"):
            parts.append(f"Department: {job['department']}")

        if job.get("team"):
            parts.append(f"Team: {job['team']}")

        if job.get("isRemote"):
            parts.append("Remote: Yes")
        elif job.get("workplaceType"):
            parts.append(f"Workplace Type: {str(job['workplaceType']).replace('_', ' ').title()}")

        comp = job.get("compensation")
        if isinstance(comp, dict):
            summary = (
                comp.get("summary")
                or comp.get("description")
                or comp.get("compensationTierSummary")
                or comp.get("scrapeableCompensationSalarySummary")
            )
            if summary:
                parts.append(f"Compensation: {summary}")
        elif isinstance(comp, str) and comp.strip():
            parts.append(f"Compensation: {comp}")

        if job.get("publishedAt"):
            parts.append(f"Posted: {job['publishedAt']}")

        description = (
            job.get("descriptionPlain")
            or self._html_to_text(job.get("descriptionHtml", ""))
            or ""
        ).strip()
        if description:
            parts.append(f"\n{description}")

        return "\n".join(parts)

    def _html_to_text(self, html: str) -> str:
        if not html:
            return ""
        return plain_text_from_fragment_html(html)
