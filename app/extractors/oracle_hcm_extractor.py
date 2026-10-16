"""
Extract job content from Oracle Recruiting Cloud (HCM Candidate Experience).

Candidate Experience pages are a JavaScript shell with no posting in the HTML:

    https://{host}/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}

The same posting is served without auth by the HCM REST resource:

    https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
        ?expand=all&onlyData=true&finder=ById;Id="{id}",siteNumber={site}

It carries the declared workplace type (``WorkplaceType``: Remote / Hybrid /
On-site) and every work location, which the rendered page shows but static
HTML and JSON-LD do not. An empty ``items`` list means the requisition is no
longer posted on that site.

The API leaves the employer null, so the site brand (``og:site_name`` minus
"Candidate Experience Site") is offered as ``company_hint``: it names jobs
added by URL alone without overriding a feed's more precise "Pearson VUE".
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote, urlparse

from app.core.logging import get_logger
from app.extractors.base import GONE_STATUSES, BaseExtractor, ExtractionResult, http_status_of
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html

logger = get_logger(__name__)

_CE_PATH = re.compile(
    r"/hcmUI/CandidateExperience/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?sites/(?P<site>[^/]+)/"
    r"(?:job|requisitions/preview)/(?P<id>\d+)",
    re.IGNORECASE,
)
_OG_SITE_NAME = re.compile(
    r"""<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']""",
    re.IGNORECASE,
)
# "Pearson Candidate Experience Site" -> "Pearson", "AF Group Careers Section"
# -> "AF Group". Site names are the employer plus a portal word; the portal
# word alone leaves nothing.
_SITE_NAME_SUFFIX = re.compile(
    r"(?:'s)?\s*(?:-|\|)?\s*\b(?:candidate\s+experience|external\s+career|career|careers|jobs?|"
    r"recruiting)\b(?:\s+(?:site|portal|page|hub|center|centre|section))?\s*$"
    r"|\s+(?:site|portal|section)\s*$",
    re.IGNORECASE,
)

# " | " or a dash with a space on either side; "Hewlett-Packard" stays whole.
_SITE_NAME_SEP = re.compile(r"\s*\|\s*|\s+[-\u2013]\s*|\s*[-\u2013]\s+")
_SITE_NAME_NAV = re.compile(r"(?i)^(?:search|find|view|browse)\b")

_SECTIONS = (
    ("ExternalDescriptionStr", None),
    ("ExternalResponsibilitiesStr", "Responsibilities"),
    ("ExternalQualificationsStr", "Qualifications"),
    ("CorporateDescriptionStr", "About the company"),
    ("OrganizationDescriptionStr", "About the organization"),
)


def parse_oracle_hcm_url(url: str | None) -> tuple[str, str, str] | None:
    """Return (host, site number, requisition id) or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    host = (parsed.netloc or "").lower()
    m = _CE_PATH.search(parsed.path or "")
    if not host or not m:
        return None
    return host, m.group("site"), m.group("id")


def is_oracle_hcm_job_url(url: str | None) -> bool:
    return parse_oracle_hcm_url(url) is not None


def company_from_site_name(site_name: str | None) -> str | None:
    """"Verisk Careers | Verisk" -> "Verisk", "Search Jobs - INL Careers" -> "INL"."""
    for segment in _SITE_NAME_SEP.split(site_name or ""):
        text = segment.strip()
        if not text or _SITE_NAME_NAV.match(text):
            continue
        previous = None
        while text and text != previous:
            previous = text
            text = _SITE_NAME_SUFFIX.sub("", text).strip(" -|,")
        if text:
            return text
    return None


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _location_name(item: object) -> str | None:
    if not isinstance(item, dict):
        return _text(item)
    name = _text(item.get("Name")) or _text(item.get("LocationName"))
    if name:
        return name
    parts = [
        _text(item.get(key))
        for key in ("TownOrCity", "Region2", "Region1", "Country")
    ]
    return ", ".join(p for p in parts if p) or None


def requisition_locations(item: dict) -> list[str]:
    """Primary location first, then secondary and other work locations."""
    found: list[str] = []
    candidates: list[str | None] = [_text(item.get("PrimaryLocation"))]
    for key in ("secondaryLocations", "otherWorkLocations"):
        rows = item.get(key)
        if isinstance(rows, list):
            candidates.extend(_location_name(row) for row in rows)
    for loc in candidates:
        loc = " ".join(loc.split()) if loc else None
        if loc and loc.lower() not in {f.lower() for f in found}:
            found.append(loc)
    return found


def requisition_to_plain_text(item: dict, company: str | None) -> str:
    parts: list[str] = []
    title = _text(item.get("Title"))
    if title:
        parts.append(f"Title: {title}")
    locations = requisition_locations(item)
    if locations:
        parts.append(f"Location: {' / '.join(locations)}")
    workplace = _text(item.get("WorkplaceType"))
    if workplace:
        parts.append(f"Workplace Type: {workplace}")
    schedule = _text(item.get("JobSchedule"))
    if schedule:
        parts.append(f"Employment Type: {schedule}")
    posted = _text(item.get("ExternalPostedStartDate"))
    if posted:
        parts.append(f"Posted: {posted[:10]}")
    for label, key in (
        ("Category", "Category"),
        ("Job Function", "JobFunction"),
        ("Requisition Id", "Id"),
    ):
        value = _text(item.get(key))
        if value:
            parts.append(f"{label}: {value}")
    # Not a "Company:" header: a site brand must not outrank a known employer.
    if company:
        parts.append(f"Careers Site: {company}")

    for key, heading in _SECTIONS:
        body = item.get(key)
        if not isinstance(body, str) or not body.strip():
            continue
        text = plain_text_from_fragment_html(body) if "<" in body else body.strip()
        if text:
            parts.append(f"\n{heading}:\n{text}" if heading else f"\n{text}")
    return "\n".join(parts).strip()


class OracleHcmExtractor(BaseExtractor):
    """Fetch one Oracle Recruiting Cloud requisition as plain text."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return is_oracle_hcm_job_url(url)

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        ref = parse_oracle_hcm_url(url)
        if not ref:
            return ExtractionResult(
                success=False, method=self.method,
                error="Could not parse Oracle HCM site and requisition id",
            )
        host, site, req_id = ref
        finder = quote(f'ById;Id="{req_id}",siteNumber={site}', safe=";=,")
        api_url = (
            f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
            f"?expand=all&onlyData=true&finder={finder}"
        )
        try:
            text, status_code, _ = await self._http.fetch_json(api_url)
        except Exception as e:
            status = http_status_of(e)
            logger.info("oracle_hcm_api_fetch_failed", url=api_url, status=status, error=str(e))
            return ExtractionResult(
                success=False, method=self.method,
                error=f"Oracle HCM API request failed: {e}",
                closed=status in GONE_STATUSES,
            )
        if status_code != 200:
            return ExtractionResult(
                success=False, method=self.method,
                error=f"Oracle HCM API returned {status_code}",
                closed=status_code in GONE_STATUSES,
            )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            return ExtractionResult(success=False, method=self.method, error=f"Invalid JSON: {e}")
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return ExtractionResult(success=False, method=self.method, error="Unexpected Oracle HCM response")
        if not items or not isinstance(items[0], dict):
            return ExtractionResult(
                success=False, method=self.method,
                error="Oracle HCM requisition is no longer posted", closed=True,
            )
        item = items[0]

        # The site brand ("AF Group") reads better than the legal entity
        # ("Accident Fund Insurance Company of America"), which is the fallback.
        company = await self._site_company(url, html) or _text(item.get("LegalEmployer"))
        plain_text = requisition_to_plain_text(item, company)
        if len(plain_text) < 80:
            return ExtractionResult(
                success=False, method=self.method,
                error="Insufficient content from Oracle HCM API",
            )
        logger.info("oracle_hcm_api_success", url=url, content_length=len(plain_text))
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data={
                "title": _text(item.get("Title")),
                "company_hint": company,
                "location": " / ".join(requisition_locations(item)) or None,
                "workplace": _text(item.get("WorkplaceType")),
                "employment_type": _text(item.get("JobSchedule")),
                "posted_date": (_text(item.get("ExternalPostedStartDate")) or "")[:10] or None,
            },
        )

    async def _site_company(self, url: str, html: str | None) -> str | None:
        """Employer from the site's ``og:site_name`` (the API leaves it null)."""
        if not html:
            try:
                html, status_code, _ = await self._http.fetch(url)
            except Exception as e:
                logger.debug("oracle_hcm_site_fetch_failed", url=url, error=str(e))
                return None
            if status_code != 200:
                return None
        m = _OG_SITE_NAME.search(html or "")
        return company_from_site_name(m.group(1)) if m else None
