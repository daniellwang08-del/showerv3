"""
Extract job data from Ashby using the public Posting API.
https://api.ashbyhq.com/posting-api/job-board/{company_slug}
Returns JSON with all open jobs; filter by job ID from the URL.
No API key required. Fast, direct HTTP request.
"""
import json
import re
from urllib.parse import urlparse

from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.core.logging import get_logger

logger = get_logger(__name__)

# jobs.ashbyhq.com/{slug}/{uuid} or .../application?...
ASHBY_URL_PATTERN = re.compile(
    r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
# Company career sites pass the job id in the query (?ashby_jid=...) while the board slug appears in page HTML.
ASHBY_JID_QUERY_PATTERN = re.compile(
    r"[?&]ashby_jid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_SLUG_FROM_HTML_PATTERNS = (
    re.compile(r"jobs\.ashbyhq\.com/([^/\"'\s<>]+)/", re.IGNORECASE),
    re.compile(r"jobs\.ashbyhq\.com%2F([^%\"'\s]+)%2F", re.IGNORECASE),
)
ASHBY_API_BASE = "https://api.ashbyhq.com/posting-api/job-board"
# At most two slug candidates to avoid extra API latency when HTML mentions multiple boards.
_MAX_SLUG_CANDIDATES = 2


def is_ashby_job_url(url: str) -> bool:
    """Return True if URL is an Ashby job page (fast path for sync processing)."""
    return _parse_ashby_url(url) is not None


def _parse_ashby_url(url: str) -> tuple[str, str] | None:
    """Extract (company_slug, job_id) from Ashby job URL. Returns None if not parseable."""
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
    """Job UUID from ?ashby_jid= on an embedded career page (company domain)."""
    if not url:
        return None
    m = ASHBY_JID_QUERY_PATTERN.search(url)
    return m.group(1).lower() if m else None


def extract_ashby_company_slugs_from_html(html: str | None) -> list[str]:
    """Find Ashby board slug(s) referenced in HTML (links to jobs.ashbyhq.com/{slug}/...)."""
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
    """Extract job data via Ashby public Posting API (no HTML, no browser)."""

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
        return await self._fetch_board_and_map_job(company_slug, job_id, url)

    async def extract_embedded(self, url: str, html: str) -> ExtractionResult:
        """
        Company career pages: ?ashby_jid=<uuid> plus ``jobs.ashbyhq.com/{slug}/`` in HTML.
        One JSON API call per slug candidate (max 2) — fast when slug is present.
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
            res = await self._fetch_board_and_map_job(company_slug, job_id, url)
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

    async def _fetch_board_and_map_job(self, company_slug: str, job_id: str, url: str) -> ExtractionResult:
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

        structured = self._map_job_to_structured(job, company_slug)
        if not structured:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Failed to map Ashby job to structured data",
            )

        logger.info("ashby_api_extraction_success", url=url, job_id=job_id)
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=json.dumps(job),
            structured_data=structured,
            confidence=0.98,
        )

    def _map_job_to_structured(self, job: dict, company_slug: str = "") -> dict | None:
        """Map Ashby API job object to our structured_data format."""
        try:
            title = job.get("title") or ""
            if not title:
                logger.warning("ashby_map_missing_title", company_slug=company_slug)
                return None

            company = company_slug.replace("-", " ").title() if company_slug else None

            location = job.get("location") or ""
            emp_type = job.get("employmentType")
            if emp_type:
                emp_type = str(emp_type).replace("_", " ").title()

            salary = self._format_compensation(job)

            description = (
                job.get("descriptionPlain")
                or self._strip_html(job.get("descriptionHtml", ""))
                or ""
            ).strip()
            if len(description) < 10:
                description = "Job listing from Ashby (description not available)."

            remote = None
            if job.get("isRemote"):
                remote = "Remote"
            elif job.get("workplaceType"):
                remote = str(job.get("workplaceType", "")).replace("_", " ").title()

            posted_date = job.get("publishedAt")

            return {
                "title": title,
                "company": company,
                "location": location,
                "employment_type": emp_type,
                "salary_range": salary,
                "description": description[:50000] if description else "",
                "posted_date": posted_date,
                "requirements": [],
                "responsibilities": [],
                "remote_policy": remote,
                "raw_metadata": {
                    "source": "ashby_api",
                    "department": job.get("department"),
                    "team": job.get("team"),
                    "job_url": job.get("jobUrl"),
                    "workplace_type": job.get("workplaceType"),
                },
            }
        except Exception as e:
            logger.error("ashby_map_failed", error=str(e), company_slug=company_slug)
            return None

    def _format_compensation(self, job: dict) -> str | None:
        comp = job.get("compensation")
        if isinstance(comp, dict):
            return (
                comp.get("summary")
                or comp.get("description")
                or comp.get("compensationTierSummary")
                or comp.get("scrapeableCompensationSalarySummary")
            )
        if isinstance(comp, str):
            return comp
        return None

    def _strip_html(self, html: str) -> str:
        if not html:
            return ""
        return re.sub(r"<[^>]+>", " ", html).strip()
