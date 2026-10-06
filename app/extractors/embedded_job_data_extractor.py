"""
Read the job record that ATS pages embed in their own HTML.

Some boards render the posting from a JSON blob shipped with the page, so the
exact title / location / pay fields are in the static HTML even when the
visible text is a JS shell or a run of unlabeled sidebar chips:

- Rippling (``ats.rippling.com`` and white-label boards): Next.js
  ``<script id="__NEXT_DATA__">`` with ``props.pageProps.apiData.jobPost``.
- UKG Pro Recruiting (``*.rec.pro.ukg.net``): inline
  ``new US.Opportunity.CandidateOpportunityDetail({...})`` constructor call.

Detection is by payload shape, not host, so custom career domains on the same
ATS are covered too. No extra network calls.
"""

from __future__ import annotations

import html as html_lib
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable

from app.core.logging import get_logger
from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.job_content_cleaner import plain_text_from_fragment_html

logger = get_logger(__name__)

_NEXT_DATA_RE = re.compile(
    r"<script[^>]*\bid=[\"']__NEXT_DATA__[\"'][^>]*>(.*?)</script>",
    re.IGNORECASE | re.DOTALL,
)
_UKG_OPPORTUNITY_MARKER = "CandidateOpportunityDetail("
_UKG_LOGO_ALT_RE = re.compile(
    r"<img\b[^>]*data-automation=[\"']navbar-(?:small|large)-logo[\"'][^>]*>",
    re.IGNORECASE,
)
_ALT_ATTR_RE = re.compile(r"\balt=[\"']([^\"']{2,80})[\"']", re.IGNORECASE)
_CURRENCY_SYMBOLS = {"USD": "$", "CAD": "$", "AUD": "$", "EUR": "\u20ac", "GBP": "\u00a3"}
_MIN_TEXT_CHARS = 200


def _clean(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value).strip()
    return text or None


def _iso_date(value: Any) -> str | None:
    text = _clean(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.date().isoformat()


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        try:
            num = float(value.replace(",", "").strip())
        except ValueError:
            return None
        return num if num > 0 else None
    return None


def _money(num: float, symbol: str) -> str:
    whole = int(num) if float(num).is_integer() else num
    return f"{symbol}{whole:,}" if isinstance(whole, int) else f"{symbol}{whole:,.2f}"


def format_pay_range(
    low: Any, high: Any, currency: str | None, *, per_hour: bool = False
) -> str | None:
    """``$115,000 - $120,000 USD`` (same display shape as ``infer_salary_from_text``)."""
    lo, hi = _number(low), _number(high)
    if lo is None and hi is None:
        return None
    code = (currency or "").strip().upper()
    symbol = _CURRENCY_SYMBOLS.get(code, "")
    if lo is not None and hi is not None and hi != lo:
        out = f"{_money(lo, symbol)} - {_money(hi, symbol)}"
    else:
        out = _money(lo if lo is not None else hi, symbol)
    if code:
        out += f" {code}"
    if per_hour:
        out += " per hour"
    return out


def _description_text(*fragments: Any) -> str:
    parts = []
    for frag in fragments:
        if isinstance(frag, str) and frag.strip():
            text = plain_text_from_fragment_html(frag) if "<" in frag else frag.strip()
            if text:
                parts.append(text)
    return "\n\n".join(parts)


def _to_plain_text(fields: dict[str, Any], description: str) -> str:
    header = []
    for label, key in (
        ("Title", "title"),
        ("Company", "company"),
        ("Location", "location"),
        ("Department", "department"),
        ("Employment Type", "employment_type"),
        ("Workplace Type", "workplace"),
        ("Salary", "salary_range"),
    ):
        value = fields.get(key)
        if value:
            header.append(f"{label}: {value}")
    return ("\n".join(header) + "\n\n" + description).strip()


# ── Rippling ──────────────────────────────────────────────────────────────


def _rippling_location(entry: Any) -> str | None:
    if isinstance(entry, str):
        return _clean(entry)
    if isinstance(entry, dict):
        named = _clean(entry.get("name")) or _clean(entry.get("label"))
        if named:
            return named
        parts = [_clean(entry.get(k)) for k in ("city", "state", "country")]
        return ", ".join(p for p in parts if p) or None
    return None


def _rippling_pay(details: Any) -> str | None:
    if not isinstance(details, list):
        return None
    for item in details:
        if not isinstance(item, dict):
            continue
        low = high = currency = None
        per_hour = False
        for key, value in item.items():
            k = key.lower()
            if low is None and any(t in k for t in ("start", "min", "low")):
                low = value
            elif high is None and any(t in k for t in ("end", "max", "high")):
                high = value
            elif "currency" in k and isinstance(value, str):
                currency = value
            elif any(t in k for t in ("frequency", "interval", "period", "unit")) and isinstance(value, str):
                per_hour = "hour" in value.lower()
        pay = format_pay_range(low, high, currency, per_hour=per_hour)
        if pay:
            return pay
    return None


def parse_rippling_next_data(html: str | None) -> tuple[dict[str, Any], str] | None:
    if not html or "__NEXT_DATA__" not in html:
        return None
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except (json.JSONDecodeError, ValueError):
        return None
    api = ((data.get("props") or {}).get("pageProps") or {}).get("apiData")
    if not isinstance(api, dict):
        return None
    post = api.get("jobPost")
    if not isinstance(post, dict) or not _clean(post.get("name")):
        return None

    board = api.get("jobBoard") if isinstance(api.get("jobBoard"), dict) else {}
    raw_locations = post.get("workLocations") or api.get("workLocations") or []
    if not isinstance(raw_locations, list):
        raw_locations = [raw_locations]
    locations = [loc for loc in (_rippling_location(x) for x in raw_locations) if loc]
    location = "; ".join(dict.fromkeys(locations)) or None

    department = post.get("department") if isinstance(post.get("department"), dict) else {}
    emp = post.get("employmentType")
    employment_type = None
    if isinstance(emp, dict):
        employment_type = _clean(emp.get("id")) or _clean(emp.get("label"))
    elif isinstance(emp, str):
        employment_type = _clean(emp)

    fields: dict[str, Any] = {
        "title": _clean(post.get("name")),
        "company": _clean(post.get("companyName"))
        or _clean(board.get("companyName"))
        or _clean(board.get("title")),
        "location": location,
        "department": _clean(department.get("name")),
        "employment_type": employment_type,
        "workplace": "remote" if location and "remote" in location.lower() else None,
        "salary_range": _rippling_pay(post.get("payRangeDetails") or api.get("payRangeDetails")),
        "posted_date": _iso_date(post.get("createdOn")),
    }
    desc = post.get("description")
    if isinstance(desc, dict):
        description = _description_text(desc.get("company"), desc.get("role"))
    else:
        description = _description_text(desc)
    return fields, description


# ── UKG Pro Recruiting ────────────────────────────────────────────────────


def _ukg_location(entry: Any) -> str | None:
    if not isinstance(entry, dict):
        return None
    address = entry.get("Address") if isinstance(entry.get("Address"), dict) else {}
    country_obj = address.get("Country")
    country = _clean(country_obj.get("Name")) if isinstance(country_obj, dict) else _clean(country_obj)
    state_obj = address.get("State")
    state = _clean(state_obj.get("Code") or state_obj.get("Name")) if isinstance(state_obj, dict) else _clean(state_obj)
    city = _clean(address.get("City"))
    name = _clean(entry.get("LocalizedName"))
    if name and "remote" in name.lower():
        return ", ".join(p for p in (name, country) if p)
    place = ", ".join(p for p in (city, state, country) if p)
    return place or name


def _ukg_company(html: str) -> str | None:
    for tag in _UKG_LOGO_ALT_RE.findall(html):
        alt = _ALT_ATTR_RE.search(tag)
        if alt:
            name = _clean(html_lib.unescape(alt.group(1)))
            if name and "logo" not in name.lower():
                return name
    return None


def parse_ukg_opportunity(html: str | None) -> tuple[dict[str, Any], str] | None:
    if not html:
        return None
    idx = html.find(_UKG_OPPORTUNITY_MARKER)
    if idx < 0:
        return None
    try:
        opp, _end = json.JSONDecoder().raw_decode(html, idx + len(_UKG_OPPORTUNITY_MARKER))
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(opp, dict) or not _clean(opp.get("Title")):
        return None

    locs = opp.get("Locations") if isinstance(opp.get("Locations"), list) else []
    locations = [loc for loc in (_ukg_location(x) for x in locs) if loc]
    location = "; ".join(dict.fromkeys(locations)) or None

    salary = None
    pay = opp.get("PayRange")
    if opp.get("PayRangeVisible") is not False and isinstance(pay, dict):
        salary = format_pay_range(
            pay.get("PayRangeMinimum"), pay.get("PayRangeMaximum"), opp.get("PayRangeCurrencyCode")
        )
    if not salary:
        currency = opp.get("CompensationCurrencyCode")
        salary = format_pay_range(
            opp.get("CompensationAnnualMinimum"), opp.get("CompensationAnnualMaximum"), currency
        ) or format_pay_range(
            opp.get("CompensationHourlyMinimum"), opp.get("CompensationHourlyMaximum"), currency, per_hour=True
        )

    # The board shows its own external publish date, not the requisition's PostedDate.
    posted = None
    memberships = opp.get("JobBoardMemberships")
    if isinstance(memberships, list):
        for member in memberships:
            if isinstance(member, dict) and member.get("PublishedExternal"):
                posted = _iso_date(member.get("ExternalPostedDate"))
                if posted:
                    break

    full_time = opp.get("FullTime")
    fields: dict[str, Any] = {
        "title": _clean(opp.get("Title")),
        "company": _ukg_company(html),
        "location": location,
        "department": _clean(opp.get("JobCategoryName")),
        "employment_type": "Full-time" if full_time is True else ("Part-time" if full_time is False else None),
        "workplace": "remote" if location and "remote" in location.lower() else None,
        "salary_range": salary,
        "posted_date": posted or _iso_date(opp.get("PostedDate")),
    }
    return fields, _description_text(opp.get("Description"))


_PARSERS: tuple[tuple[str, Callable[[str | None], tuple[dict[str, Any], str] | None]], ...] = (
    ("rippling", parse_rippling_next_data),
    ("ukg", parse_ukg_opportunity),
)


def parse_embedded_job(html: str | None) -> tuple[str, dict[str, Any], str] | None:
    """Return ``(source, fields, description_text)`` from the first matching payload."""
    for source, parser in _PARSERS:
        try:
            parsed = parser(html)
        except Exception as e:
            logger.warning("embedded_job_parse_failed", source=source, error=str(e))
            continue
        if parsed:
            fields, description = parsed
            return source, fields, description
    return None


class EmbeddedJobDataExtractor(BaseExtractor):
    """Job fields + description from the ATS record embedded in page HTML."""

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return bool(html) and ("__NEXT_DATA__" in html or _UKG_OPPORTUNITY_MARKER in html)

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        parsed = parse_embedded_job(html)
        if not parsed:
            return ExtractionResult(success=False, method=self.method, error="No embedded job record")
        source, fields, description = parsed
        structured = {k: v for k, v in fields.items() if v}
        structured["embedded_source"] = source
        text = _to_plain_text(fields, description)
        if len(description) < _MIN_TEXT_CHARS:
            # Fields are still trustworthy; let a richer page-text candidate carry the body.
            return ExtractionResult(
                success=False,
                method=self.method,
                structured_data=structured,
                error="Embedded job record has no usable description",
            )
        logger.info(
            "embedded_job_extraction_success",
            url=url,
            source=source,
            title=fields.get("title"),
            location=fields.get("location"),
            content_length=len(text),
        )
        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=text,
            structured_data=structured,
        )
