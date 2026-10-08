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

from app.extractors.base import GONE_STATUSES, BaseExtractor, ExtractionResult, http_status_of
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html
from app.core.logging import get_logger

logger = get_logger(__name__)

LEVER_API_BASE = "https://api.lever.co/v0/postings"
LEVER_EU_API_BASE = "https://api.eu.lever.co/v0/postings"

# jobs[.eu].lever.co/{company}/{posting_id}[/apply]
_LEVER_URL_PATTERN = re.compile(
    r"jobs\.(eu\.)?lever\.co/([^/?#]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
# Some companies host Lever under their own subdomain via jobs.lever.co iframe,
# leaving the posting id in HTML as `data-posting-id` or in api.lever.co links.
_LEVER_HTML_API_PATTERN = re.compile(
    r"api\.(eu\.)?lever\.co/v0/postings/([^/\"'\s<>]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_LEVER_EMBEDDED_PATTERN = re.compile(
    r"jobs\.(eu\.)?lever\.co/([^/\"'\s<>]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


def _ref(m: re.Match[str]) -> tuple[str, str, bool]:
    # The postings API matches the company slug case-sensitively
    # (``Flex`` resolves, ``flex`` is a 404), so the slug keeps its case.
    return m.group(2).strip(), m.group(3).lower(), bool(m.group(1))


def _parse_lever_url(url: str) -> tuple[str, str, bool] | None:
    """Return (company_slug, posting_id, is_eu) or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        full = f"{parsed.netloc}{parsed.path}"
    except Exception:
        return None
    m = _LEVER_URL_PATTERN.search(full)
    return _ref(m) if m else None


def is_lever_job_url(url: str) -> bool:
    return _parse_lever_url(url) is not None


def extract_lever_refs_from_html(html: str | None) -> list[tuple[str, str, bool]]:
    """Pull (company_slug, posting_id, is_eu) tuples from embedded HTML.
    Useful when a careers page iframes/links a Lever posting.
    """
    if not html:
        return []
    seen: list[tuple[str, str, bool]] = []
    for pat in (_LEVER_HTML_API_PATTERN, _LEVER_EMBEDDED_PATTERN):
        for m in pat.finditer(html):
            ref = _ref(m)
            if ref not in seen:
                seen.append(ref)
            if len(seen) >= 4:
                return seen
    return seen


def _slug_variants(slug: str) -> list[str]:
    return [slug] if slug == slug.lower() else [slug, slug.lower()]


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
        candidates: list[tuple[str, str, bool]] = []
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
        native_gone = False
        for company_slug, posting_id, is_eu in candidates:
            gone = True
            for slug in _slug_variants(company_slug):
                res = await self._fetch_and_convert(slug, posting_id, url, is_eu=is_eu)
                if res.success:
                    logger.info(
                        "lever_api_extraction_success",
                        url=url,
                        company_slug=slug,
                        posting_id=posting_id,
                    )
                    return res
                last_err = res.error
                gone = gone and res.closed
            if ref and (company_slug, posting_id, is_eu) == ref:
                native_gone = gone

        return ExtractionResult(
            success=False,
            method=self.method,
            error=last_err or "Lever API extraction failed",
            closed=native_gone,
        )

    async def _fetch_and_convert(
        self, company_slug: str, posting_id: str, source_url: str, *, is_eu: bool = False
    ) -> ExtractionResult:
        base = LEVER_EU_API_BASE if is_eu else LEVER_API_BASE
        api_url = f"{base}/{company_slug}/{posting_id}?mode=json"

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
                    closed=http_status_of(e2) in GONE_STATUSES,
                )

        if status_code != 200:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Lever API returned {status_code}",
                closed=status_code in GONE_STATUSES,
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

        title = (data.get("text") or "").strip() or None
        cats = data.get("categories") if isinstance(data.get("categories"), dict) else {}
        location = None
        if isinstance(cats, dict):
            location = (cats.get("location") or "").strip() or None
            if not location:
                all_locs = cats.get("allLocations")
                if isinstance(all_locs, list) and all_locs:
                    location = ", ".join(str(x).strip() for x in all_locs if str(x).strip()) or None
        commitment = None
        workplace = None
        if isinstance(cats, dict):
            commitment = (cats.get("commitment") or "").strip() or None
            workplace = (cats.get("workplaceType") or "").strip() or None
        salary_range = None
        salary = data.get("salaryRange")
        if isinstance(salary, dict) and (salary.get("min") or salary.get("max")):
            salary_range = (
                f"{salary.get('min') or '?'} - {salary.get('max') or '?'} "
                f"{salary.get('currency') or ''} {salary.get('interval') or ''}"
            ).strip()

        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data={
                "title": title,
                "company": company_slug.replace("-", " ").replace("_", " ").title(),
                "location": location,
                "employment_type": commitment,
                "workplace": workplace,
                "salary_range": salary_range,
            },
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
