"""Normalize, score, and infer job location strings.

ATS extractors, labeled JD headers, and the match LLM all write
``Job.location``. This module keeps the most specific place name and recovers
a location from posting text when the structured field is empty.
"""

from __future__ import annotations

import re

from app.services.country_catalog import CITIES_BY_LENGTH
from app.services.job_field_utils import clean_optional_job_field, normalize_work_mode_display
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
# JSON-LD text puts the address on the line after a bare "Location:" label
# ("Location:\nCountry: US"), and the value capture runs onto that line.
_ADDRESS_PART_LABEL_RE = re.compile(r"(?i)^(?:country|city|state/region|state|region)\s*:\s*")
_BASED_IN_RE = re.compile(
    r"(?i)\b(?:based in|located in|this role is (?:based|located) in)\s+"
    r"([A-Z][A-Za-z '\-]{1,40}(?:,\s*[A-Z][A-Za-z '\-]{1,30}){0,2})"
)


# Work-mode words live in the Mode column, so they are dropped from Location.
_MODE_WORD = (
    r"(?:(?:fully|100\s*%|full[\s-]*time)[\s-]*)?remote(?:[\s-]+(?:first|friendly|eligible|ok|only|optional))?"
    r"|hybrid(?:[\s-]+remote)?"
    r"|on[\s-]?site|in[\s-]?office|in[\s-]?person|office[\s-]+based"
    r"|work(?:ing)?[\s-]+from[\s-]+(?:home|anywhere)|wfh|telecommut\w*"
)
_MODE_RUN = rf"(?:{_MODE_WORD})(?:\s*(?:or|and|&|/|\+|,)\s*(?:{_MODE_WORD}))*"
_MODE_PHRASE_RE = re.compile(
    r"(?i)(?:(?<=[A-Za-z.])-based\s+|(?:\s*,)?\s+(?:or|and|&)\s+(?=\S)|(?<=\()(?:or|and)\s+)?"
    rf"(?<![A-Za-z0-9])({_MODE_RUN})(?![A-Za-z0-9])"
    r"(?:\s+(?:in|within|from|across|only\s+in)(?![A-Za-z0-9]))?"
)
_EMPTY_BRACKETS_RE = re.compile(r"(?i)[(\[]\s*(?:open\s+to|or|and|&|only)?\s*[)\]]")
_LOCATION_SEP_RE = re.compile(r"(\s*(?:[,;|\u2022\u00b7/:]|\s[-\u2013\u2014]\s)\s*)")
# Separators kept when a mode word between two places is dropped, strongest first.
_SEP_RANK = (";", "|", "\u2022", "\u00b7", "/", "-", "\u2013", "\u2014", ",", ":")
_EDGE_JUNK = " \t-\u2013\u2014,:;"
_CONNECTOR_ONLY = frozenset({"or", "and", "&", "+", "in", "only", "based", "open to"})


def _sep_for(seps: list[str]) -> str:
    sep = min((s.strip() for s in seps), key=lambda s: _SEP_RANK.index(s) if s in _SEP_RANK else 99)
    if sep in {"-", "\u2013", "\u2014"}:
        return " - "
    if sep == ":":
        return ", "
    if sep in {"|", "/", "\u2022", "\u00b7"}:
        return f" {sep} "
    return f"{sep} "


def _clean_piece(piece: str) -> str:
    text = re.sub(r"\(\s+", "(", re.sub(r"\s+\)", ")", piece)).strip(_EDGE_JUNK)
    if text.startswith(".") and not re.match(r"\.\w\.", text):
        text = text.lstrip(". ")
    while text.startswith("(") and text.endswith(")") and text.count("(") == 1:
        text = text[1:-1].strip(_EDGE_JUNK)
    if text.count("(") != text.count(")"):
        text = text.replace("(", "").replace(")", "").strip(_EDGE_JUNK)
    return "" if text.lower() in _CONNECTOR_ONLY else text


def split_work_mode_from_location(location: str | None) -> tuple[str | None, str | None]:
    """Drop work-mode words from a location and report the mode they named.

    ``"Remote - United States"`` becomes ``("United States", "remote")`` and a
    bare ``"Hybrid"`` becomes ``(None, "hybrid")``. Place names are untouched.
    """
    text = clean_optional_job_field(location)
    if not text:
        return None, None
    modes: list[str] = []

    def _drop(match: re.Match[str]) -> str:
        mode = normalize_work_mode_display(match.group(1))
        if mode:
            modes.append(mode)
        return " "

    stripped = _MODE_PHRASE_RE.sub(_drop, text)
    if not modes:
        return text, None
    stripped = _EMPTY_BRACKETS_RE.sub(" ", re.sub(r"(?i)\(\s*open\s+to\s+", "(", stripped))

    pieces = _LOCATION_SEP_RE.split(stripped)
    out: list[str] = []
    pending: list[str] = []
    for i, piece in enumerate(pieces):
        if i % 2:
            pending.append(piece)
            continue
        cleaned = _clean_piece(piece)
        if not cleaned:
            continue
        if out:
            out.append(_sep_for(pending or [","]))
        out.append(cleaned)
        pending = []
    result = re.sub(r"\s{2,}", " ", "".join(out)).strip(_EDGE_JUNK)
    return (result or None), modes[0]


def strip_work_mode_from_location(location: str | None) -> str | None:
    return split_work_mode_from_location(location)[0]


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
        raw = _ADDRESS_PART_LABEL_RE.sub("", raw)
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
