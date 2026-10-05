"""Parse and format the candidate's résumé-header home location.

The parser extracts a compact city / state / country from the contact line
(e.g. "San Francisco, CA" or "London, United Kingdom") so onboarding can
persist it as ``User.address`` and tailored résumés can print it in the header.
Street and postal stay off the résumé even when they are known.
"""

from __future__ import annotations

import re
from typing import Any

from app.services.country_catalog import (
    COUNTRY_NAMES,
    PHRASE_TO_CODE,
    country_display_name,
    normalize_country_input,
)
from app.services.job_location_classifier import (
    _US_STATE_ABBREVS,
    _US_STATE_NAMES,
)

_POSTAL_RE = re.compile(
    r"^(.*?)(?:\s+(\d{5}(?:-\d{4})?|\d{4,6}|[A-Z]\d[A-Z]\s*\d[A-Z]\d))$",
    re.IGNORECASE,
)
_BAD_CITY_RE = re.compile(
    r"\b(university|college|bachelor|master|phd|engineer|developer|"
    r"summary|objective|experience|education|skills)\b",
    re.IGNORECASE,
)
_US_STATE_NAME_TO_ABBREV = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE",
    "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC", "puerto rico": "PR",
}
_US_COUNTRY_NAMES = frozenset({
    "united states", "united states of america", "usa", "u.s.", "u.s.a.",
    "u.s.a", "america",
})


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _split_postal(token: str) -> tuple[str, str]:
    text = token.strip()
    if not text:
        return "", ""
    match = _POSTAL_RE.match(text)
    if match and match.group(1).strip():
        return match.group(1).strip(), match.group(2).strip()
    return text, ""


def _country_from_token(token: str) -> str | None:
    text = token.strip()
    if not text:
        return None
    # Résumé headers use "City, ST". A 2-letter US state must not become
    # Canada / India / Albania / … just because those ISO codes collide.
    if len(text) == 2 and text.upper() in _US_STATE_ABBREVS:
        return None
    code = normalize_country_input(text)
    if code:
        return country_display_name(code)
    lowered = text.lower().rstrip(".")
    if lowered in PHRASE_TO_CODE:
        return country_display_name(PHRASE_TO_CODE[lowered])
    return None


def _us_state_from_token(token: str) -> str | None:
    text = token.strip()
    if not text:
        return None
    if text.upper() in _US_STATE_ABBREVS and len(text) <= 2:
        return text.upper()
    lowered = text.lower()
    if lowered in _US_STATE_NAMES:
        return _US_STATE_NAME_TO_ABBREV.get(lowered, text.title())
    return None


def _is_us_country(name: str) -> bool:
    return name.strip().lower().rstrip(".") in _US_COUNTRY_NAMES or name.strip().upper() == "US"


def parse_resume_header_location(text: str | None) -> dict[str, str]:
    """Turn a header location line into city / state / postal / country fields."""
    raw = _clean(text)
    if not raw or _BAD_CITY_RE.search(raw):
        return {}

    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return {}

    city = ""
    state = ""
    postal = ""
    country = ""

    last, postal = _split_postal(parts[-1])
    parts = parts[:-1] + ([last] if last else [])

    if parts:
        country_name = _country_from_token(parts[-1])
        if country_name:
            country = country_name
            parts = parts[:-1]

    if parts:
        us_state = _us_state_from_token(parts[-1])
        if us_state:
            state = us_state
            if not country:
                country = COUNTRY_NAMES["US"]
            parts = parts[:-1]

    if parts:
        city = parts[0].strip()
        if len(parts) > 1 and not state:
            maybe_state = parts[-1].strip()
            if 1 <= len(maybe_state) <= 40:
                state = maybe_state

    if city and _BAD_CITY_RE.search(city):
        return {}
    if not city and not state and not country:
        return {}

    out = {
        "city": city,
        "state": state,
        "postal_code": postal,
        "country": country,
    }
    return {k: v for k, v in out.items() if v}


def format_resume_header_location(addr: Any) -> str:
    """Compact 'City, ST' / 'City, Country' string for the résumé contact row.

    Street and postal are never printed. Empty input returns ''.
    """
    if not addr:
        return ""
    if isinstance(addr, str):
        parsed = parse_resume_header_location(addr)
        if parsed:
            return format_resume_header_location(parsed)
        return _clean(addr)

    data = addr if isinstance(addr, dict) else getattr(addr, "model_dump", lambda: {})()
    if not isinstance(data, dict):
        return ""

    city = _clean(data.get("city"))
    state = _clean(data.get("state"))
    country = _clean(data.get("country"))
    if city and state:
        return f"{city}, {state}"
    if city and country and not _is_us_country(country):
        return f"{city}, {country}"
    if city:
        return city
    if state and country and not _is_us_country(country):
        return f"{state}, {country}"
    return state or country


def merge_address_fields(
    existing: Any,
    *,
    location: str | None = None,
    address: Any = None,
) -> dict[str, Any]:
    """Fill city/state/country from a parsed header line without wiping extras."""
    base: dict[str, Any] = {}
    if isinstance(existing, dict):
        base = dict(existing)
    elif existing is not None and hasattr(existing, "model_dump"):
        base = existing.model_dump()

    incoming: dict[str, Any] = {}
    if isinstance(address, dict):
        incoming = {k: _clean(address.get(k)) for k in ("line1", "line2", "city", "state", "postal_code", "country")}
    elif address is not None and hasattr(address, "model_dump"):
        incoming = address.model_dump()

    parsed = parse_resume_header_location(location) if location else {}

    merged = dict(base)
    for key in ("line1", "line2", "city", "state", "postal_code", "country"):
        value = _clean(incoming.get(key)) or parsed.get(key) or _clean(merged.get(key))
        if value:
            merged[key] = value
    prefs = incoming.get("local_preferences")
    if prefs is None:
        prefs = merged.get("local_preferences")
    merged["local_preferences"] = list(prefs or [])
    return merged


def replace_header_location(existing: Any, location: str) -> dict[str, Any]:
    """Replace city/state/country from a Content location line.

    Street and local_preferences stay. Leftover region from a previous country
    (e.g. MA after switching Boston to London) must not survive.
    """
    base: dict[str, Any] = {}
    if isinstance(existing, dict):
        base = dict(existing)
    elif existing is not None and hasattr(existing, "model_dump"):
        base = existing.model_dump()

    parsed = parse_resume_header_location(location)
    out: dict[str, Any] = {
        "line1": _clean(base.get("line1")),
        "line2": _clean(base.get("line2")),
        "local_preferences": list(base.get("local_preferences") or []),
    }
    if parsed:
        out.update({key: value for key, value in parsed.items() if value})
    elif _clean(location):
        out["city"] = _clean(location)
    return {key: value for key, value in out.items() if value or key == "local_preferences"}


def apply_header_location_to_draft(draft: Any) -> None:
    """Populate ``draft.location`` and ``draft.address`` from whichever is present."""
    from app.models.profile_schemas import AddressInfo

    location = _clean(getattr(draft, "location", None))
    raw_addr = getattr(draft, "address", None)
    merged = merge_address_fields(raw_addr, location=location or None, address=raw_addr)
    has_place = any(_clean(merged.get(k)) for k in ("city", "state", "country", "line1"))
    if not has_place:
        draft.location = location or None
        if not any(_clean(getattr(raw_addr, k, None) if raw_addr is not None else None) for k in ("city", "state", "country")):
            draft.address = None
        return

    draft.address = AddressInfo.model_validate(merged)
    if not location:
        draft.location = format_resume_header_location(draft.address) or None
    else:
        draft.location = location
