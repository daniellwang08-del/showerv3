"""
Extract job content via the SmartRecruiters public Posting API (no API key).

SmartRecruiters job pages, and especially the one-click apply flow linked
from job boards, sit behind bot protection that returns "You have been
blocked". The public endpoint serves the same posting as JSON:

    https://api.smartrecruiters.com/v1/companies/{company}/postings/{id or uuid}

A 404 there means the posting has been unpublished.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from app.core.logging import get_logger
from app.extractors.base import GONE_STATUSES, BaseExtractor, ExtractionResult, http_status_of
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html

logger = get_logger(__name__)

SMARTRECRUITERS_API_BASE = "https://api.smartrecruiters.com/v1/companies"

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_ONECLICK_PATH = re.compile(rf"^/oneclick-ui/company/([^/]+)/publication/({_UUID})", re.I)
_POSTING_PATH = re.compile(rf"^/([^/]+)/({_UUID}|\d{{6,}})(?:-[^/]*)?/?$", re.I)
_HOSTS = ("jobs.smartrecruiters.com", "careers.smartrecruiters.com")

_SECTIONS = (
    ("companyDescription", "About the company"),
    ("jobDescription", "Job description"),
    ("qualifications", "Qualifications"),
    ("additionalInformation", "Additional information"),
)


def parse_smartrecruiters_url(url: str | None) -> tuple[str, str] | None:
    """Return (company identifier, posting id or uuid) or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if (parsed.netloc or "").lower() not in _HOSTS:
        return None
    path = parsed.path or ""
    m = _ONECLICK_PATH.match(path) or _POSTING_PATH.match(path)
    if not m:
        return None
    return m.group(1), m.group(2).lower()


def is_smartrecruiters_job_url(url: str | None) -> bool:
    return parse_smartrecruiters_url(url) is not None


def _label(value: object) -> str | None:
    if isinstance(value, dict):
        value = value.get("label") or value.get("name")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _location(loc: object) -> tuple[str | None, str | None]:
    if not isinstance(loc, dict):
        return None, None
    text = loc.get("fullLocation") or ", ".join(
        str(loc[k]).strip() for k in ("city", "region", "country") if loc.get(k)
    )
    workplace = None
    if loc.get("remote"):
        workplace = "remote"
    elif loc.get("hybrid"):
        workplace = "hybrid"
    return (text.strip() or None) if isinstance(text, str) else None, workplace


def posting_to_plain_text(data: dict) -> str:
    parts: list[str] = []
    title = (data.get("name") or "").strip()
    if title:
        parts.append(f"Title: {title}")
    company = _label(data.get("company"))
    if company:
        parts.append(f"Company: {company}")
    location, workplace = _location(data.get("location"))
    if location:
        parts.append(f"Location: {location}")
    if workplace:
        parts.append(f"Workplace Type: {workplace}")
    for label, key in (
        ("Employment Type", "typeOfEmployment"),
        ("Experience Level", "experienceLevel"),
        ("Department", "department"),
        ("Function", "function"),
    ):
        value = _label(data.get(key))
        if value:
            parts.append(f"{label}: {value}")
    if data.get("releasedDate"):
        parts.append(f"Posted: {data['releasedDate']}")

    sections = ((data.get("jobAd") or {}).get("sections") or {}) if isinstance(data.get("jobAd"), dict) else {}
    for key, fallback_title in _SECTIONS:
        section = sections.get(key) if isinstance(sections, dict) else None
        if not isinstance(section, dict):
            continue
        body = section.get("text") or ""
        text = plain_text_from_fragment_html(body) if "<" in body else body.strip()
        if text:
            parts.append(f"\n{(section.get('title') or fallback_title).strip()}:\n{text}")
    return "\n".join(parts).strip()


class SmartRecruitersApiExtractor(BaseExtractor):
    """Fetch one SmartRecruiters posting as plain text."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return is_smartrecruiters_job_url(url)

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        ref = parse_smartrecruiters_url(url)
        if not ref:
            return ExtractionResult(
                success=False, method=self.method,
                error="Could not parse SmartRecruiters company and posting id",
            )
        company, posting_id = ref
        api_url = f"{SMARTRECRUITERS_API_BASE}/{company}/postings/{posting_id}"
        try:
            text, status_code, _ = await self._http.fetch_json(api_url)
        except Exception as e:
            status = http_status_of(e)
            logger.info("smartrecruiters_api_fetch_failed", url=api_url, status=status, error=str(e))
            return ExtractionResult(
                success=False, method=self.method,
                error=f"SmartRecruiters API request failed: {e}",
                closed=status in GONE_STATUSES,
            )
        if status_code != 200:
            return ExtractionResult(
                success=False, method=self.method,
                error=f"SmartRecruiters API returned {status_code}",
                closed=status_code in GONE_STATUSES,
            )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            return ExtractionResult(success=False, method=self.method, error=f"Invalid JSON: {e}")
        if not isinstance(data, dict):
            return ExtractionResult(success=False, method=self.method, error="Unexpected SmartRecruiters response")
        if data.get("active") is False:
            return ExtractionResult(
                success=False, method=self.method,
                error="SmartRecruiters posting is inactive", closed=True,
            )

        plain_text = posting_to_plain_text(data)
        if len(plain_text) < 80:
            return ExtractionResult(
                success=False, method=self.method,
                error="Insufficient content from SmartRecruiters API",
            )
        location, workplace = _location(data.get("location"))
        logger.info("smartrecruiters_api_success", url=url, content_length=len(plain_text))
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data={
                "title": (data.get("name") or "").strip() or None,
                "company": _label(data.get("company")),
                "location": location,
                "workplace": workplace,
                "employment_type": _label(data.get("typeOfEmployment")),
            },
        )
