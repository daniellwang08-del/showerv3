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

# A trailing comma token only counts as a foreign region when it looks like an
# actual place name (a few alphabetic words) - NOT descriptive prose such as
# "travel less than 25%", which a remote-policy sentence can produce.
_REGION_NAME_RE = re.compile(r"^[a-z][a-z .'\-]*$")


def _looks_like_region_name(region: str) -> bool:
    region = region.strip()
    if not region or not _REGION_NAME_RE.match(region):
        return False
    return len(region.split()) <= 3


class LocationVerdict(str, Enum):
    US = "us"
    NON_US = "non_us"
    UNKNOWN = "unknown"


def _normalize(text: str | None) -> str:
    if not text:
        return ""
    cleaned = text.strip().lower()
    cleaned = cleaned.replace("\u2013", "-").replace("\u2014", "-")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned


def _has_word(text: str, phrase: str) -> bool:
    """True when ``phrase`` appears as a standalone token in ``text``.

    Alphanumeric boundaries are required, so surrounding punctuation ("USA,",
    "(US)", "US or Canada") still counts while embedded matches ("focus", "usa"
    when searching for "us") do not.
    """
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text) is not None


def _contains_us_country(text: str) -> bool:
    for phrase in _US_COUNTRY_PHRASES:
        if phrase == "america" and ("latin america" in text or "south america" in text):
            continue
        if _has_word(text, phrase):
            return True
    # Bare "us" token (word-bounded, so "usa"/"focus"/"bonus" never match).
    if _has_word(text, "us"):
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


def _split_into_segments(text: str) -> list[str]:
    if not text:
        return []
    segments = [seg for seg in _SEGMENT_SPLIT_RE.split(text) if seg.strip()]
    return segments or [text]


def _classify_segment(segment: str, *, allow_region_fallback: bool = True) -> LocationVerdict:
    """Classify one location segment.

    ``allow_region_fallback`` gates the generic "city, region" heuristic. It is
    enabled for the trusted structured ``location`` field but disabled for the
    free-form ``remote_policy`` text, whose prose (e.g. "..., travel less than
    25%") must never be mistaken for a foreign region.
    """
    text = _normalize(segment)
    if not text or text in _PLACEHOLDER_LOCATIONS:
        return LocationVerdict.UNKNOWN

    # US inclusion wins: a segment that names the US (a state, a city/state, or
    # the country) is US-eligible even when it lists other countries too, e.g.
    # "US or Canada", "US, LATAM, and India", "United States or Canada". This is
    # checked BEFORE the non-US keyword scan so a co-mentioned foreign country
    # cannot flip an explicitly US-eligible posting to non-US.
    if _looks_like_us_city_state(text) or _contains_us_country(text):
        return LocationVerdict.US
    if _contains_non_us_country(text):
        return LocationVerdict.NON_US

    # Remote/hybrid descriptive text is prose, not a location. Guard here -
    # BEFORE the generic comma heuristic - so a sentence such as
    # "Remote position ..., travel less than 25%" is not misread as non-US.
    if text.startswith("remote") or text.startswith("hybrid"):
        return LocationVerdict.UNKNOWN

    match = _COMMA_SEGMENT_RE.match(text)
    if match:
        region = match.group(2).strip()
        if region.upper() in _US_STATE_ABBREVS or region in _US_STATE_NAMES:
            return LocationVerdict.US
        if (
            allow_region_fallback
            and len(region) >= 3
            and not region.isdigit()
            # A trailing prose/placeholder word ("Remote", "Hybrid", "Anywhere")
            # is not a foreign region - e.g. "USA, Remote" must not be non-US.
            and region not in _PLACEHOLDER_LOCATIONS
            and _looks_like_region_name(region)
        ):
            return LocationVerdict.NON_US

    return LocationVerdict.UNKNOWN


def classify_job_location(
    location: str | None,
    *,
    remote_policy: str | None = None,
) -> tuple[LocationVerdict, str]:
    """Return (verdict, detail) using structured location and optional remote policy."""
    location_clean = location.strip() if location and location.strip() else ""
    remote_clean = remote_policy.strip() if remote_policy and remote_policy.strip() else ""

    if not location_clean and not remote_clean:
        return LocationVerdict.UNKNOWN, "missing location"

    verdicts: list[LocationVerdict] = []
    # Structured location field: trusted - full heuristics incl. the comma region fallback.
    for seg in _split_into_segments(location_clean):
        verdicts.append(_classify_segment(seg, allow_region_fallback=True))
    # Remote policy: free-form prose - only trust explicit country/region keywords,
    # never the generic "city, region" fallback (avoids false non-US from sentences).
    for seg in _split_into_segments(remote_clean):
        verdicts.append(_classify_segment(seg, allow_region_fallback=False))

    combined = " | ".join(p for p in (location_clean, remote_clean) if p)
    if LocationVerdict.NON_US in verdicts:
        return LocationVerdict.NON_US, f"non-US location detected: {combined[:120]}"
    if verdicts and all(v == LocationVerdict.US for v in verdicts):
        return LocationVerdict.US, f"US location: {combined[:120]}"
    if LocationVerdict.US in verdicts and LocationVerdict.UNKNOWN in verdicts:
        return LocationVerdict.US, f"US location with unspecified segments: {combined[:120]}"
    return LocationVerdict.UNKNOWN, f"location needs review: {combined[:120]}"


def keeps_us_job_pool(
    location: str | None,
    *,
    remote_policy: str | None = None,
) -> tuple[bool, LocationVerdict, str]:
    """Whether a job should stay in the visible US-focused pool.

    Only explicit non-US locations are dropped. Missing / ambiguous locations are
    kept (treated as US) so users can filter them later themselves.
    """
    verdict, detail = classify_job_location(location, remote_policy=remote_policy)
    return verdict != LocationVerdict.NON_US, verdict, detail
