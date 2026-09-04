"""
Extract job content from Workable via its public, keyless job API.

    https://apply.workable.com/api/v2/accounts/{account_slug}/jobs/{shortcode}

This endpoint powers Workable-hosted career pages and requires NO API key,
bearer token, or additional auth (only a browser-like User-Agent + Accept
header, which HTTPService.fetch_json already sends).  It returns a single job
object with HTML ``description`` / ``requirements`` / ``benefits`` fields.

Verified live against apply.workable.com (2026): 200 JSON for native
``apply.workable.com/{slug}/j/{SHORTCODE}`` URLs.
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

# Workable shortcodes are uppercase alphanumeric tokens (e.g. "1E040E3017").
_SHORTCODE = r"([A-Z0-9]{6,20})"

# apply.workable.com/{slug}/j/{SHORTCODE}[/...]
_APPLY_PATTERN = re.compile(
    r"apply\.workable\.com/([A-Za-z0-9._-]+)/j/" + _SHORTCODE,
    re.IGNORECASE,
)
# Legacy {slug}.workable.com/j/{SHORTCODE} or /jobs/{SHORTCODE}
_LEGACY_PATTERN = re.compile(
    r"([A-Za-z0-9._-]+)\.workable\.com/(?:j|jobs)/" + _SHORTCODE,
    re.IGNORECASE,
)
# Embedded widget on a company careers page: shortcode carried as a query param
_JOB_SHORTCODE_QUERY = re.compile(
    r"[?&](?:shortcode|job)=" + _SHORTCODE,
    re.IGNORECASE,
)
_ACCOUNT_FROM_HTML_PATTERNS = (
    re.compile(r"apply\.workable\.com/([A-Za-z0-9._-]+)/", re.IGNORECASE),
    re.compile(r"data-account=[\"']([A-Za-z0-9._-]+)[\"']", re.IGNORECASE),
    re.compile(r"workable\.com/api/accounts/([A-Za-z0-9._-]+)", re.IGNORECASE),
)
_MAX_ACCOUNT_CANDIDATES = 2

WORKABLE_API_BASE = "https://apply.workable.com/api/v2/accounts"


def _parse_workable_url(url: str) -> tuple[str, str] | None:
    """Return (account_slug, shortcode) for a native Workable job URL."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        full = f"{parsed.netloc}{parsed.path}"
    except Exception:
        return None
    m = _APPLY_PATTERN.search(full)
    if m:
        return m.group(1).lower(), m.group(2).upper()
    m = _LEGACY_PATTERN.search(full)
    if m:
        slug = m.group(1).lower()
        if slug not in ("www", "apply"):
            return slug, m.group(2).upper()
    return None


def is_workable_job_url(url: str) -> bool:
    return _parse_workable_url(url) is not None


def parse_workable_shortcode_from_url(url: str) -> str | None:
    if not url:
        return None
    m = _JOB_SHORTCODE_QUERY.search(url)
    return m.group(1).upper() if m else None


def extract_workable_accounts_from_html(html: str | None) -> list[str]:
    if not html:
        return []
    seen: list[str] = []
    for pat in _ACCOUNT_FROM_HTML_PATTERNS:
        for m in pat.finditer(html):
            slug = m.group(1).strip().rstrip("/").lower()
            if slug and slug not in ("www", "apply") and slug not in seen:
                seen.append(slug)
            if len(seen) >= _MAX_ACCOUNT_CANDIDATES:
                return seen
    return seen


class WorkableApiExtractor(BaseExtractor):
    """Extract job content via Workable's public (keyless) job API as plain text."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        if _parse_workable_url(url) is not None:
            return True
        # Embedded widget: shortcode in query + account slug discoverable in HTML.
        return bool(
            parse_workable_shortcode_from_url(url)
            and extract_workable_accounts_from_html(html)
        )

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        parsed = _parse_workable_url(url)
        if parsed:
            slug, shortcode = parsed
            return await self._fetch_and_convert(slug, shortcode, url)

        shortcode = parse_workable_shortcode_from_url(url)
        if shortcode:
            accounts = extract_workable_accounts_from_html(html)
            last_err: str | None = None
            for slug in accounts:
                res = await self._fetch_and_convert(slug, shortcode, url)
                if res.success:
                    logger.info(
                        "workable_api_embedded_success",
                        url=url, shortcode=shortcode, account=slug,
                    )
                    return res
                last_err = res.error
            return ExtractionResult(
                success=False,
                method=self.method,
                error=last_err or "No Workable account slug found in HTML",
            )

        return ExtractionResult(
            success=False,
            method=self.method,
            error="Invalid Workable URL: could not parse account/shortcode",
        )

    async def _fetch_and_convert(self, slug: str, shortcode: str, url: str) -> ExtractionResult:
        api_url = f"{WORKABLE_API_BASE}/{slug}/jobs/{shortcode}"

        try:
            text, status_code, _ = await self._http.fetch_json(api_url)
        except Exception as e:
            logger.warning("workable_api_fetch_failed", url=api_url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Workable API request failed: {e}",
            )

        if status_code != 200:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Workable API returned {status_code}",
            )

        try:
            job = json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning("workable_api_json_invalid", url=api_url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Invalid JSON from Workable API",
            )

        if not isinstance(job, dict) or not job.get("title"):
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Workable API response missing job fields",
            )

        plain_text = self._job_to_plain_text(job)
        if not plain_text or len(plain_text) < 50:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Insufficient content from Workable API",
            )

        logger.info(
            "workable_api_extraction_success",
            url=url, shortcode=shortcode, content_length=len(plain_text),
        )
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data={
                "title": (job.get("title") or "").strip() or None,
                "location": self._format_location(job.get("location")),
                "employment_type": (
                    str(job.get("type")).replace("_", " ").strip()
                    if job.get("type")
                    else None
                ),
                "workplace": (
                    str(job.get("workplace")).replace("_", " ").strip()
                    if job.get("workplace")
                    else ("remote" if job.get("remote") else None)
                ),
                "is_remote": bool(job.get("remote")),
            },
        )

    def _job_to_plain_text(self, job: dict) -> str:
        parts: list[str] = []

        if job.get("title"):
            parts.append(f"Title: {job['title']}")

        loc = self._format_location(job.get("location"))
        if loc:
            parts.append(f"Location: {loc}")

        if job.get("workplace"):
            parts.append(f"Workplace: {str(job['workplace']).replace('_', ' ').title()}")
        elif job.get("remote"):
            parts.append("Remote: Yes")

        if job.get("type"):
            parts.append(f"Employment Type: {str(job['type']).replace('_', ' ').title()}")

        dept = job.get("department")
        if isinstance(dept, list) and dept:
            parts.append(f"Department: {', '.join(str(d) for d in dept)}")
        elif isinstance(dept, str) and dept.strip():
            parts.append(f"Department: {dept}")

        if job.get("published"):
            parts.append(f"Posted: {job['published']}")

        for label, key in (("", "description"), ("Requirements", "requirements"), ("Benefits", "benefits")):
            html = job.get(key)
            if not html:
                continue
            body = plain_text_from_fragment_html(html).strip()
            if body:
                parts.append(f"\n{label}\n{body}" if label else f"\n{body}")

        return "\n".join(parts)

    def _format_location(self, loc) -> str:
        if isinstance(loc, str):
            return loc.strip()
        if isinstance(loc, dict):
            bits = [
                loc.get("city"),
                loc.get("region"),
                loc.get("country"),
            ]
            return ", ".join(b for b in bits if b)
        return ""
