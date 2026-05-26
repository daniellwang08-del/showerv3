"""Classify structured job locations as US, non-US, or unknown for post-analysis dedup."""

from __future__ import annotations

import re
from enum import Enum

_US_STATE_ABBREVS = frozenset({
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
    "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
    "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
    "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
    "PR", "GU", "VI", "AS", "MP",
})

_US_STATE_NAMES = frozenset({
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
    "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
    "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
    "virginia", "washington", "west virginia", "wisconsin", "wyoming",
    "district of columbia", "puerto rico",
})

_US_COUNTRY_PHRASES = (
    "united states of america",
    "united states",
    "u.s.a.",
    "u.s.a",
    "usa",
    "u.s.",
    "us-only",
    "us only",
    "america",
)

_NON_US_COUNTRY_PHRASES = (
    "afghanistan", "albania", "algeria", "andorra", "angola", "argentina", "armenia",
    "australia", "austria", "azerbaijan", "bahrain", "bangladesh", "belarus", "belgium",
    "bolivia", "bosnia", "brazil", "bulgaria", "cambodia", "cameroon", "canada",
    "chile", "china", "colombia", "costa rica", "croatia", "cuba", "cyprus",
    "czech republic", "czechia", "denmark", "dominican republic", "ecuador", "egypt",
    "el salvador", "estonia", "ethiopia", "finland", "france", "georgia", "germany",
    "ghana", "greece", "guatemala", "honduras", "hong kong", "hungary", "iceland",
    "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy", "jamaica",
    "japan", "jordan", "kazakhstan", "kenya", "korea", "kuwait", "latvia", "lebanon",
    "libya", "lithuania", "luxembourg", "macau", "malaysia", "malta", "mexico",
    "moldova", "mongolia", "morocco", "myanmar", "nepal", "netherlands", "new zealand",
    "nicaragua", "nigeria", "norway", "oman", "pakistan", "panama", "paraguay", "peru",
    "philippines", "poland", "portugal", "qatar", "romania", "russia", "saudi arabia",
    "serbia", "singapore", "slovakia", "slovenia", "south africa", "spain", "sri lanka",
    "sweden", "switzerland", "syria", "taiwan", "thailand", "turkey", "ukraine",
    "united arab emirates", "united kingdom", "uruguay", "uzbekistan", "venezuela",
    "vietnam",
)

_NON_US_SHORT_REGIONS = frozenset({
    "uk", "u.k.", "u.k", "eu", "europe", "emea", "apac", "latam", "mea",
    "england", "scotland", "wales", "northern ireland",
})

_PLACEHOLDER_LOCATIONS = frozenset({
    "", "unknown", "n/a", "na", "none", "not specified", "tbd", "remote", "hybrid",
    "on-site", "onsite", "office", "various", "multiple locations", "worldwide",
    "global", "anywhere", "flexible",
})

_SEGMENT_SPLIT_RE = re.compile(r"\s*(?:\||/|;|\u2022|\n|·)\s*")
_COMMA_SEGMENT_RE = re.compile(r"^(.+?),\s*(.+)$")


class LocationVerdict(str, Enum):
    US = "us"
    NON_US = "non_us"
    UNKNOWN = "unknown"


def _normalize(text: str | None) -> str:
    if not text:
        return ""
    cleaned = text.strip().lower()
    cleaned = cleaned.replace("–", "-").replace("—", "-")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned


def _contains_us_country(text: str) -> bool:
    padded = f" {text} "
    for phrase in _US_COUNTRY_PHRASES:
        if phrase == "america":
            if "latin america" in text or "south america" in text:
                continue
        if f" {phrase} " in padded or text == phrase:
            return True
    if re.search(r"\bus\b", text) and "focus" not in text:
        return True
    return False


def _contains_non_us_country(text: str) -> bool:
    padded = f" {text} "
    for phrase in _NON_US_COUNTRY_PHRASES:
        if f" {phrase} " in padded or text.endswith(f", {phrase}") or text == phrase:
            return True
    for region in _NON_US_SHORT_REGIONS:
        if text == region or text.endswith(f", {region}") or f" {region} " in padded:
            return True
    return False


def _looks_like_us_city_state(segment: str) -> bool:
    match = _COMMA_SEGMENT_RE.match(segment.strip())
    if not match:
        return False
    region = match.group(2).strip()
    region_upper = region.upper()
    if region_upper in _US_STATE_ABBREVS:
        return True
    return region in _US_STATE_NAMES


def _classify_segment(segment: str) -> LocationVerdict:
    text = _normalize(segment)
    if not text or text in _PLACEHOLDER_LOCATIONS:
        return LocationVerdict.UNKNOWN

    if _contains_non_us_country(text):
        return LocationVerdict.NON_US
    if _looks_like_us_city_state(text):
        return LocationVerdict.US
    if _contains_us_country(text):
        return LocationVerdict.US

    match = _COMMA_SEGMENT_RE.match(text)
    if match:
        region = match.group(2).strip()
        if region.upper() in _US_STATE_ABBREVS or region in _US_STATE_NAMES:
            return LocationVerdict.US
        if len(region) >= 3 and not region.isdigit():
            return LocationVerdict.NON_US

    if text.startswith("remote") or text.startswith("hybrid"):
        if _contains_us_country(text):
            return LocationVerdict.US
        if _contains_non_us_country(text):
            return LocationVerdict.NON_US
        return LocationVerdict.UNKNOWN

    return LocationVerdict.UNKNOWN


def classify_job_location(
    location: str | None,
    *,
    remote_policy: str | None = None,
) -> tuple[LocationVerdict, str]:
    """Return (verdict, detail) using structured location and optional remote policy."""
    parts: list[str] = []
    if location and location.strip():
        parts.append(location.strip())
    if remote_policy and remote_policy.strip():
        parts.append(remote_policy.strip())

    if not parts:
        return LocationVerdict.UNKNOWN, "missing location"

    combined = " | ".join(parts)
    segments = [seg for seg in _SEGMENT_SPLIT_RE.split(combined) if seg.strip()]
    if not segments:
        segments = [combined]

    verdicts = [_classify_segment(seg) for seg in segments]
    if LocationVerdict.NON_US in verdicts:
        return LocationVerdict.NON_US, f"non-US location detected: {combined[:120]}"
    if all(v == LocationVerdict.US for v in verdicts):
        return LocationVerdict.US, f"US location: {combined[:120]}"
    if LocationVerdict.US in verdicts and LocationVerdict.UNKNOWN in verdicts:
        return LocationVerdict.US, f"US location with unspecified segments: {combined[:120]}"
    return LocationVerdict.UNKNOWN, f"location needs review: {combined[:120]}"
