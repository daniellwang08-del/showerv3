"""
Extract job content from Workday-hosted career sites.

Workday URLs follow the pattern:

    https://{tenant}.{cluster}.myworkdayjobs.com/{lang?}/{site}/job/.../{title}_{jobreqid}

The customer-experience JSON endpoint exposes the same data without auth:

    POST https://{tenant}.{cluster}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{external_path}
    Accept: application/json

We:
1. Parse tenant, cluster, site, and external path from the URL.
2. POST the cxs endpoint with an empty JSON body to receive the JD blob.
3. Convert the response to plain text.

If the cxs call fails (some tenants disable it / response shape varies), we
fall back to fetching the HTML page directly via curl_cffi (Workday gates
plain httpx behind anti-bot).
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService, _CURL_CFFI_AVAILABLE
from app.services.job_content_cleaner import plain_text_from_fragment_html, plain_text_from_document_html
from app.core.logging import get_logger

logger = get_logger(__name__)

# {tenant}.{cluster}.myworkdayjobs.com/{lang}/{site}/job/.../{title}_{jobreqid}
_WORKDAY_HOST_PATTERN = re.compile(
    r"^([a-z0-9-]+)\.([a-z0-9]+)\.myworkdayjobs\.com$",
    re.IGNORECASE,
)
# Also matches custom-domain Workday tenants where path contains /wday/
_WORKDAY_PATH_PATTERN = re.compile(
    r"/(?P<site>[A-Za-z0-9_-]+)/job/(?P<external_path>[^?#]+)",
    re.IGNORECASE,
)
_LANG_PREFIX = re.compile(r"^/(?:[a-z]{2}(?:-[A-Z]{2})?)/", re.IGNORECASE)


def _parse_workday_url(url: str) -> dict | None:
    """Return {tenant, cluster, site, external_path, host} or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    host = (parsed.netloc or "").lower()
    if "myworkdayjobs.com" not in host:
        return None
    host_match = _WORKDAY_HOST_PATTERN.match(host)
    tenant: str | None = None
    cluster: str | None = None
    if host_match:
        tenant = host_match.group(1).lower()
        cluster = host_match.group(2).lower()
    path = parsed.path or ""
    path_no_lang = _LANG_PREFIX.sub("/", path)
    m = _WORKDAY_PATH_PATTERN.search(path_no_lang)
    if not m:
        return None
    site = m.group("site")
    external_path = m.group("external_path").strip("/")
    if not tenant:
        # Some Workday tenants use a custom domain; fall back to splitting host.
        parts = host.split(".")
        if len(parts) >= 2:
            tenant = parts[0]
            cluster = parts[1]
    return {
        "host": host,
        "tenant": tenant,
        "cluster": cluster,
        "site": site,
        "external_path": external_path,
    }


def is_workday_job_url(url: str) -> bool:
    return _parse_workday_url(url) is not None


class WorkdayExtractor(BaseExtractor):
    """Workday cxs JSON extractor with HTML fallback."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return _parse_workday_url(url) is not None

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        info = _parse_workday_url(url)
        if not info:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Could not parse Workday URL components",
            )

        tenant = info.get("tenant")
        site = info.get("site")
        external_path = info.get("external_path")
        host = info.get("host")

        if not (tenant and site and external_path and host):
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Incomplete Workday URL components",
            )

        cxs_url = f"https://{host}/wday/cxs/{tenant}/{site}/job/{external_path}"
        json_result = await self._fetch_cxs(cxs_url, url)
        if json_result.success:
            return json_result

        html_result = await self._fetch_html_fallback(url)
        if html_result.success:
            return html_result

        return ExtractionResult(
            success=False,
            method=self.method,
            error=json_result.error or html_result.error or "Workday extraction failed",
        )

    async def _fetch_cxs(self, cxs_url: str, source_url: str) -> ExtractionResult:
        if not _CURL_CFFI_AVAILABLE:
            try:
                text, status_code, _ = await self._http.fetch_json(cxs_url)
            except Exception as e:
                return ExtractionResult(
                    success=False, method=self.method,
                    error=f"Workday cxs fetch failed (no curl_cffi): {e}",
                )
        else:
            try:
                from curl_cffi.requests import AsyncSession
                async with AsyncSession(impersonate="chrome", timeout=20) as session:
                    resp = await session.get(
                        cxs_url,
                        headers={
                            "Accept": "application/json",
                            "Accept-Language": "en-US,en;q=0.9",
                            "X-Requested-With": "XMLHttpRequest",
                            "Referer": source_url,
                        },
                        allow_redirects=True,
                    )
                    status_code = resp.status_code
                    text = resp.text
                    logger.info(
                        "workday_cxs_fetch",
                        url=cxs_url,
                        status_code=status_code,
                        content_length=len(resp.content or b""),
                    )
            except Exception as e:
                return ExtractionResult(
                    success=False, method=self.method,
                    error=f"Workday cxs fetch error: {e}",
                )

        if status_code != 200:
            return ExtractionResult(
                success=False, method=self.method,
                error=f"Workday cxs returned {status_code}",
            )

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            return ExtractionResult(
                success=False, method=self.method,
                error=f"Invalid JSON from Workday cxs: {e}",
            )

        plain_text = self._cxs_to_plain_text(data)
        if not plain_text or len(plain_text) < 80:
            return ExtractionResult(
                success=False, method=self.method,
                error="Insufficient content from Workday cxs",
            )

        logger.info(
            "workday_cxs_extraction_success",
            url=source_url, content_length=len(plain_text),
        )
        return ExtractionResult(
            success=True, method=self.method,
            raw_content=plain_text, structured_data=None,
        )

    async def _fetch_html_fallback(self, source_url: str) -> ExtractionResult:
        try:
            text, status_code, _ = await self._http.fetch_impersonated(source_url)
        except Exception as e:
            return ExtractionResult(
                success=False, method=self.method,
                error=f"Workday HTML fallback failed: {e}",
            )
        if status_code != 200:
            return ExtractionResult(
                success=False, method=self.method,
                error=f"Workday HTML returned {status_code}",
            )

        plain_text = plain_text_from_document_html(text)
        if not plain_text or len(plain_text) < 80:
            return ExtractionResult(
                success=False, method=self.method,
                error="Insufficient content from Workday HTML",
            )

        logger.info(
            "workday_html_extraction_success",
            url=source_url, content_length=len(plain_text),
        )
        return ExtractionResult(
            success=True, method=self.method,
            raw_content=plain_text, structured_data=None,
        )

    def _cxs_to_plain_text(self, data: dict) -> str:
        """Convert a Workday cxs job posting JSON blob to plain text."""
        parts: list[str] = []

        job_info = (data.get("jobPostingInfo") or {}) if isinstance(data, dict) else {}
        if not isinstance(job_info, dict):
            job_info = {}

        title = (job_info.get("title") or data.get("title") or "").strip()
        if title:
            parts.append(f"Title: {title}")

        for label, key in (
            ("Location", "location"),
            ("Time Type", "timeType"),
            ("Posted On", "postedOn"),
            ("Job Type", "jobType"),
            ("Job Family Group", "jobFamilyGroup"),
            ("Job Family", "jobFamily"),
            ("Job Requisition Id", "jobReqId"),
        ):
            val = job_info.get(key)
            if isinstance(val, str) and val.strip():
                parts.append(f"{label}: {val.strip()}")

        # Pay range
        pay = job_info.get("payRange") or job_info.get("payRanges")
        if isinstance(pay, dict):
            mn = pay.get("minimum") or pay.get("min")
            mx = pay.get("maximum") or pay.get("max")
            cur = pay.get("currency") or ""
            interval = pay.get("frequency") or pay.get("interval") or ""
            if mn or mx:
                parts.append(f"Pay Range: {mn or '?'} - {mx or '?'} {cur} {interval}".strip())
        elif isinstance(pay, list):
            for p in pay:
                if not isinstance(p, dict):
                    continue
                mn = p.get("minimum") or p.get("min")
                mx = p.get("maximum") or p.get("max")
                cur = p.get("currency") or ""
                if mn or mx:
                    parts.append(f"Pay Range: {mn or '?'} - {mx or '?'} {cur}".strip())

        locations_extra = job_info.get("additionalLocations") or data.get("additionalLocations")
        if isinstance(locations_extra, list):
            locs = [str(loc).strip() for loc in locations_extra if str(loc).strip()]
            if locs:
                parts.append(f"Additional Locations: {', '.join(locs)}")

        description = job_info.get("jobDescription") or data.get("jobDescription") or ""
        if isinstance(description, str) and description.strip():
            desc = plain_text_from_fragment_html(description) if "<" in description else description.strip()
            if desc:
                parts.append(f"\n{desc}")

        for extra_key in ("externalJobPath", "siteId"):
            val = job_info.get(extra_key)
            if isinstance(val, str) and val.strip():
                parts.append(f"{extra_key}: {val.strip()}")

        return "\n".join(parts).strip()
