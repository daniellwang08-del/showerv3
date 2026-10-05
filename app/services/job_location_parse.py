"""Normalize, score, and infer job location strings.

ATS extractors, labeled JD headers, and the match LLM all write
``Job.location``. This module keeps the most specific place name and recovers
a location from posting text when the structured field is empty.
"""

from __future__ import annotations

import re

from app.services.country_catalog import CITIES_BY_LENGTH
from app.services.job_field_utils import clean_optional_job_field
from app.services.job_location_classifier import (
    _COMMA_SEGMENT_RE,
    _has_word,
    _looks_like_region_name,
    _normalize,
    detect_countries_in_text,
)

_PLACEHOLDER = frozenset({
    "", "unknown", "n/a", "na", "none", "null", "not specified", "tbd",
    "remote", "hybrid", "on-site", "onsite", "office", "various",
    "multiple locations", "worldwide", "global", "anywhere", "flexible",
    "fully remote", "work from home", "wfh",
})

_LOCATION_LINE_RE = re.compile(
    r"(?im)^(?:job\s+)?(?:all\s+)?locations?\s*[:\-]\s*(.+)$"
)
_BASED_IN_RE = re.compile(
    r"(?i)\b(?:based in|located in|this role is (?:based|located) in)\s+"
    r"([A-Z][A-Za-z '\-]{1,40}(?:,\s*[A-Z][A-Za-z '\-]{1,30}){0,2})"
)


def _has_known_city(text: str) -> bool:
    return any(_has_word(text, city) for city in CITIES_BY_LENGTH)


def location_specificity(location: str | None) -> int:
    """How much geographic detail ``location`` carries. Higher is better.

    0 empty / placeholder, 1 remote-or-worldwide only, 2 country or vague
    place, 3 city, 4 city plus country/state.
    """
    text = _normalize(location)
    if not text or text in _PLACEHOLDER:
        return 0
    codes = detect_countries_in_text(text)
    has_city = _has_known_city(text)
    comma = _COMMA_SEGMENT_RE.match(text)
    first = comma.group(1).strip() if comma else ""
    region = comma.group(2).strip() if comma else ""
    first_is_place = bool(first) and first not in _PLACEHOLDER and not first.startswith("remote")
    has_region = bool(
        comma
        and _looks_like_region_name(region)
        and region not in _PLACEHOLDER
    )
    if has_city and (codes or has_region):
        return 4
    if has_city or (has_region and first_is_place):
        return 3
    if codes:
        return 2
    if text.startswith("remote") or text.startswith("hybrid"):
        return 1
    return 1 if len(text) >= 3 else 0


def prefer_job_location(existing: str | None, incoming: str | None) -> str | None:
    """Keep the more specific of two location strings.

    A later LLM pass that returns only ``Remote`` must not overwrite
    ``San Francisco, CA``. Equal scores keep the longer useful string.
    """
    left = clean_optional_job_field(existing)
    right = clean_optional_job_field(incoming)
    if not left:
        return right
    if not right:
        return left
    left_score = location_specificity(left)
    right_score = location_specificity(right)
    if right_score > left_score:
        return right
    if left_score > right_score:
        return left
    return left if len(left) >= len(right) else right


def _usable_inferred(text: str) -> bool:
    if not text or _normalize(text) in _PLACEHOLDER:
        return False
    if detect_countries_in_text(text):
        return True
    if _has_known_city(_normalize(text)):
        return True
    match = _COMMA_SEGMENT_RE.match(_normalize(text))
    return bool(match and _looks_like_region_name(match.group(2).strip()))


def infer_location_from_text(text: str | None) -> str | None:
    """Pull a location from labeled or 'based in' lines in a job posting."""
    if not text:
        return None
    window = text[:8000]
    candidates: list[str] = []
    for match in _LOCATION_LINE_RE.finditer(window):
        raw = match.group(1).strip().split("\n", 1)[0].strip()
        raw = re.split(r"\s*[|•]\s*", raw, maxsplit=1)[0].strip()
        raw = raw.rstrip(" .")
        if raw and len(raw) <= 80:
            candidates.append(raw)
    for match in _BASED_IN_RE.finditer(window[:4000]):
        raw = match.group(1).strip().rstrip(" .")
        if raw and len(raw) <= 80:
            candidates.append(raw)
    best: str | None = None
    for candidate in candidates:
        if _usable_inferred(candidate):
            best = prefer_job_location(best, candidate)
    return best


def resolve_location_countries(location: str | None) -> list[str]:
    """ISO codes for flags and filters. Empty when nothing is recognizable."""
    return detect_countries_in_text(location)
