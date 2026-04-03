"""
Resolve job postings via Greenhouse Job Board API (no API key).

Embedded career sites (e.g. company.com/careers/jobs/123?gh_jid=) often render a Greenhouse
``job_app`` iframe (application form + EEO), not the JD. The public endpoint returns the real
``content`` HTML for the role.

https://developers.greenhouse.io/job-board-integration.html
"""
from __future__ import annotations

import json
import re
from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html
from app.core.logging import get_logger

logger = get_logger(__name__)

GREENHOUSE_API_BASE = "https://boards-api.greenhouse.io/v1/boards"
# boards.greenhouse.io/{token}/jobs/{id} — token in path
_BOARD_JOBS_IN_PATH = re.compile(
    r"(?:boards|job-boards|jobs)\.greenhouse\.io/([^/\"'\s<>]+)/jobs/(\d+)",
    re.IGNORECASE,
)
# job id in path: .../jobs/7528... (company career sites)
_JOBS_NUMERIC_PATH = re.compile(r"/jobs/(\d+)(?:\?|$|/)", re.IGNORECASE)
_GH_JID_QUERY = re.compile(r"[?&]gh_jid=(\d+)", re.IGNORECASE)
# Board token in embed / script references
_TOKEN_FROM_HTML_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"job-boards\.greenhouse\.io/embed/[^\"'\s<>]*[?&]for=([^&\"'\s<>]+)",
        re.IGNORECASE,
    ),
    re.compile(
        r"boards\.greenhouse\.io/([^/\"'\s<>]+)/jobs/",
        re.IGNORECASE,
    ),
    re.compile(
        r"boards-api\.greenhouse\.io/v1/boards/([^/\"'\s<>]+)/",
        re.IGNORECASE,
    ),
    re.compile(
        r"greenhouse\.io/embed/job_app\?[^\"'\s<>]*[?&]for=([^&\"'\s<>]+)",
        re.IGNORECASE,
    ),
)
_MAX_TOKEN_CANDIDATES = 4


def parse_greenhouse_job_id_from_url(url: str) -> str | None:
    """Numeric Greenhouse job id from path ``/jobs/{id}`` or ``gh_jid=``."""
    if not url:
        return None
    m = _BOARD_JOBS_IN_PATH.search(url)
    if m:
        return m.group(2)
    m = _JOBS_NUMERIC_PATH.search(url)
    if m:
        return m.group(1)
    m = _GH_JID_QUERY.search(url)
    return m.group(1) if m else None


def greenhouse_board_tokens_from_url(url: str) -> list[str]:
    """Board token from a native Greenhouse jobs URL (path), if present."""
    if not url:
        return []
    m = _BOARD_JOBS_IN_PATH.search(url)
    if m:
        return [m.group(1).strip()]
    return []


def extract_greenhouse_board_tokens_from_html(html: str | None) -> list[str]:
    """Collect board token candidates from page HTML (embeds, links, API URLs)."""
    if not html:
        return []
    # Do not require the substring "greenhouse" — CSR shells often omit it until embeds load.
    seen: list[str] = []
    for pat in _TOKEN_FROM_HTML_PATTERNS:
        for m in pat.finditer(html):
            tok = m.group(1).strip().rstrip("/")
            if tok and tok not in seen and len(tok) <= 120:
                seen.append(tok)
            if len(seen) >= _MAX_TOKEN_CANDIDATES:
                return seen
    return seen


def greenhouse_extraction_token_candidates(url: str, html: str | None) -> list[str]:
    """Ordered unique board tokens: URL path first, then HTML-derived."""
    out: list[str] = []
    for t in greenhouse_board_tokens_from_url(url):
        if t not in out:
            out.append(t)
    for t in extract_greenhouse_board_tokens_from_html(html):
        if t not in out:
            out.append(t)
    return out


class GreenhouseBoardExtractor(BaseExtractor):
    """Fetch a single job via Greenhouse boards API."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        jid = parse_greenhouse_job_id_from_url(url)
        if not jid:
            return False
        if greenhouse_board_tokens_from_url(url):
            return True
        if html and ("greenhouse" in html.lower() or "gh_jid" in url.lower()):
            return True
        return False

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        job_id = parse_greenhouse_job_id_from_url(url)
        if not job_id:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Could not parse Greenhouse job id from URL",
            )
        tokens = greenhouse_extraction_token_candidates(url, html)
        if not tokens:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No Greenhouse board token (company slug) found in URL or HTML",
            )
        last_err: str | None = None
        for board_token in tokens:
            res = await self._fetch_job(board_token, job_id, url)
            if res.success:
                logger.info(
                    "greenhouse_board_api_success",
                    url=url,
                    job_id=job_id,
                    board_token=board_token,
                )
                return res
            last_err = res.error
        return ExtractionResult(
            success=False,
            method=self.method,
            error=last_err or "Greenhouse board API extraction failed",
        )

    async def _fetch_job(self, board_token: str, job_id: str, source_url: str) -> ExtractionResult:
        api_url = f"{GREENHOUSE_API_BASE}/{board_token}/jobs/{job_id}"
        try:
            text, status_code, _ = await self._http.fetch_json(api_url)
        except Exception as e:
            logger.debug("greenhouse_board_api_fetch_failed", url=api_url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=str(e),
            )
        if status_code != 200:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Greenhouse API returned {status_code}",
            )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Invalid JSON: {e}",
            )
        if not isinstance(data, dict):
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Unexpected Greenhouse API response",
            )
        structured = self._map_job(data, source_url)
        if not structured:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Could not map Greenhouse job to structured fields",
            )
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=text,
            structured_data=structured,
            confidence=0.97,
        )

    def _map_job(self, job: dict, source_url: str) -> dict | None:
        title = (job.get("title") or "").strip()
        raw_content = job.get("content") or ""
        if isinstance(raw_content, str) and "<" in raw_content:
            description = plain_text_from_fragment_html(raw_content)
        else:
            description = plain_text_from_fragment_html(str(raw_content)) if raw_content else ""

        if not title or len(description or "") < 40:
            return None

        company = job.get("company_name")
        if isinstance(company, str):
            company = company.strip() or None
        else:
            company = None

        loc = job.get("location")
        location: str | None = None
        if isinstance(loc, dict):
            location = (loc.get("name") or "").strip() or None
        elif isinstance(loc, str):
            location = loc.strip() or None

        absolute_url = job.get("absolute_url") or source_url

        return {
            "title": title,
            "company": company,
            "location": location,
            "description": description,
            "employment_type": None,
            "salary_range": None,
            "raw_html": str(raw_content) if raw_content else "",
            "raw_metadata": {"source": "greenhouse_board_api", "absolute_url": absolute_url},
        }
