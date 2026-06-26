"""
Extract job content from Lever using the public Postings API.

Lever exposes every public job posting at:
    https://api.lever.co/v0/postings/{company}/{posting_id}?mode=json

No API key is required and CORS is permissive - but Lever does block plain
``httpx`` requests with 403, so we fetch through the HTTP service's
``fetch_impersonated`` path (curl_cffi Chrome TLS impersonation).

Returns plain text content for downstream LLM analysis.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html
from app.core.logging import get_logger

logger = get_logger(__name__)

LEVER_API_BASE = "https://api.lever.co/v0/postings"

# jobs.lever.co/{company}/{posting_id}[/apply]
_LEVER_URL_PATTERN = re.compile(
    r"jobs\.(?:eu\.)?lever\.co/([^/?#]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
# Some companies host Lever under their own subdomain via jobs.lever.co iframe,
# leaving the posting id in HTML as `data-posting-id` or in api.lever.co links.
_LEVER_HTML_API_PATTERN = re.compile(
    r"api\.lever\.co/v0/postings/([^/\"'\s<>]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_LEVER_EMBEDDED_PATTERN = re.compile(
    r"jobs\.lever\.co/([^/\"'\s<>]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


def _parse_lever_url(url: str) -> tuple[str, str] | None:
    """Return (company_slug, posting_id) or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        full = f"{parsed.netloc}{parsed.path}"
    except Exception:
        return None
    m = _LEVER_URL_PATTERN.search(full)
    if m:
        return m.group(1).strip().lower(), m.group(2).lower()
    return None


def is_lever_job_url(url: str) -> bool:
    return _parse_lever_url(url) is not None


def extract_lever_refs_from_html(html: str | None) -> list[tuple[str, str]]:
    """Pull (company_slug, posting_id) tuples from embedded HTML.
    Useful when a careers page iframes/links a Lever posting.
    """
    if not html:
        return []
    seen: list[tuple[str, str]] = []
    for pat in (_LEVER_HTML_API_PATTERN, _LEVER_EMBEDDED_PATTERN):
        for m in pat.finditer(html):
            slug = m.group(1).strip().lower()
            pid = m.group(2).lower()
            ref = (slug, pid)
            if ref not in seen:
                seen.append(ref)
            if len(seen) >= 4:
                return seen
    return seen


class LeverApiExtractor(BaseExtractor):
    """Extract job content via Lever's public Postings API as plain text."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        if _parse_lever_url(url):
            return True
        return bool(extract_lever_refs_from_html(html))

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        ref = _parse_lever_url(url)
        candidates: list[tuple[str, str]] = []
        if ref:
            candidates.append(ref)
        for embedded in extract_lever_refs_from_html(html):
            if embedded not in candidates:
                candidates.append(embedded)

        if not candidates:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No Lever posting reference (slug + posting id) found",
            )

        last_err: str | None = None
        for company_slug, posting_id in candidates:
            res = await self._fetch_and_convert(company_slug, posting_id, url)
            if res.success:
                logger.info(
                    "lever_api_extraction_success",
                    url=url,
                    company_slug=company_slug,
                    posting_id=posting_id,
                )
                return res
            last_err = res.error

        return ExtractionResult(
            success=False,
            method=self.method,
            error=last_err or "Lever API extraction failed",
        )

    async def _fetch_and_convert(
        self, company_slug: str, posting_id: str, source_url: str
    ) -> ExtractionResult:
        api_url = f"{LEVER_API_BASE}/{company_slug}/{posting_id}?mode=json"

        try:
            text, status_code, _ = await self._http.fetch_impersonated(api_url)
        except Exception:
            try:
                text, status_code, _ = await self._http.fetch_json(api_url)
            except Exception as e2:
                logger.debug("lever_api_fetch_failed", url=api_url, error=str(e2))
                return ExtractionResult(
                    success=False,
                    method=self.method,
                    error=f"Lever API request failed: {e2}",
                )

        if status_code != 200:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Lever API returned {status_code}",
            )

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Invalid JSON from Lever API: {e}",
            )

        if not isinstance(data, dict):
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Unexpected Lever API response shape",
            )

        plain_text = self._posting_to_plain_text(data)
        if not plain_text or len(plain_text) < 50:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Insufficient content from Lever API",
            )

        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data=None,
        )

    def _posting_to_plain_text(self, posting: dict) -> str:
        parts: list[str] = []

        title = (posting.get("text") or "").strip()
        if title:
            parts.append(f"Title: {title}")

        cats = posting.get("categories") or {}
        if isinstance(cats, dict):
            for label, key in (
                ("Team", "team"),
                ("Department", "department"),
                ("Location", "location"),
                ("Employment Type", "commitment"),
                ("Workplace Type", "workplaceType"),
            ):
                val = cats.get(key)
                if isinstance(val, str) and val.strip():
                    pretty = val.replace("_", " ").strip()
                    parts.append(f"{label}: {pretty}")
            all_locs = cats.get("allLocations")
            if isinstance(all_locs, list):
                locs = [str(loc).strip() for loc in all_locs if str(loc).strip()]
                if locs and len(locs) > 1:
                    parts.append(f"All Locations: {', '.join(locs)}")

        salary = posting.get("salaryRange")
        if isinstance(salary, dict):
            mn = salary.get("min")
            mx = salary.get("max")
            cur = salary.get("currency") or ""
            interval = salary.get("interval") or ""
            if mn or mx:
                rng = f"{mn or '?'} - {mx or '?'} {cur} {interval}".strip()
                parts.append(f"Salary: {rng}")

        salary_desc = posting.get("salaryDescription")
        if isinstance(salary_desc, str) and salary_desc.strip():
            cleaned = plain_text_from_fragment_html(salary_desc) if "<" in salary_desc else salary_desc.strip()
            if cleaned:
                parts.append(f"Compensation: {cleaned}")

        posted = posting.get("createdAt") or posting.get("updatedAt")
        if posted:
            parts.append(f"Posted (epoch ms): {posted}")

        description_html = posting.get("descriptionHtml") or posting.get("description") or ""
        if isinstance(description_html, str) and description_html.strip():
            desc = plain_text_from_fragment_html(description_html) if "<" in description_html else description_html.strip()
            if desc:
                parts.append(f"\n{desc}")

        lists = posting.get("lists") or []
        if isinstance(lists, list):
            for lst in lists:
                if not isinstance(lst, dict):
                    continue
                header = (lst.get("text") or "").strip()
                content_html = lst.get("content") or ""
                if not (header or content_html):
                    continue
                body = (
                    plain_text_from_fragment_html(content_html)
                    if "<" in str(content_html)
                    else str(content_html).strip()
                )
                if header and body:
                    parts.append(f"\n{header}:\n{body}")
                elif body:
                    parts.append(f"\n{body}")
                elif header:
                    parts.append(f"\n{header}")

        additional = posting.get("additional") or posting.get("additionalPlain")
        if isinstance(additional, str) and additional.strip():
            extra = plain_text_from_fragment_html(additional) if "<" in additional else additional.strip()
            if extra:
                parts.append(f"\n{extra}")

        return "\n".join(parts).strip()
