"""Classify structured job locations against a user's preferred countries.

Generalizes the original US-only pool filter: every user has a list of
preferred ISO country codes (``users.country_preferences``). A job stays
visible when its location explicitly matches a preferred country, names a
region containing one (EU, APAC, …), says it is worldwide, or is
unknown/ambiguous. Only locations that explicitly resolve OUTSIDE the
preferred set are dropped, the historical "only explicit non-US is dropped"
policy, applied per user.

The legacy US-only API (``classify_job_location`` / ``keeps_us_job_pool``)
is preserved as a thin wrapper over the generalized classifier with
``allowed_countries={"US"}``.
"""

from __future__ import annotations

import re
from enum import Enum
from functools import lru_cache
from typing import Any, Iterable

from app.services.country_catalog import (
    CITIES_BY_LENGTH,
    CITY_TO_CODE,
    COUNTRY_NAMES,
    PHRASE_TO_CODE,
    PHRASES_BY_LENGTH,
    REGION_GROUPS,
    SUBDIVISION_TO_CODE,
    WORLDWIDE_TOKENS,
    describe_country_list,
)

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

# Region tokens longest-first so "asia pacific" wins over "asia".
_REGION_TOKENS_BY_LENGTH: tuple[str, ...] = tuple(
    sorted(REGION_GROUPS, key=len, reverse=True)
)


def _looks_like_region_name(region: str) -> bool:
    region = region.strip()
    if not region or not _REGION_NAME_RE.match(region):
        return False
    return len(region.split()) <= 3


class LocationVerdict(str, Enum):
    """Legacy US-pool verdict (kept for stored data and existing callers)."""
    US = "us"
    NON_US = "non_us"
    UNKNOWN = "unknown"


class CountryMatchVerdict(str, Enum):
    MATCH = "match"          # explicitly inside the preferred countries
    NO_MATCH = "no_match"    # explicitly outside the preferred countries
    UNKNOWN = "unknown"      # missing / placeholder / ambiguous → keep visible


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


def _looks_like_us_city_state(segment: str) -> bool:
    match = _COMMA_SEGMENT_RE.match(segment.strip())
    if not match:
        return False
    region = match.group(2).strip()
    region_upper = region.upper()
    if region_upper in _US_STATE_ABBREVS:
        return True
    return region in _US_STATE_NAMES


def _detect_cities(text: str) -> set[str]:
    codes: set[str] = set()
    for city in CITIES_BY_LENGTH:
        if _has_word(text, city):
            codes.add(CITY_TO_CODE[city])
    return codes


def _detect_country_codes(text: str) -> set[str]:
    """All country codes named by country, city, or city-region form."""
    codes: set[str] = set()
    for phrase in PHRASES_BY_LENGTH:
        if _has_word(text, phrase):
            codes.add(PHRASE_TO_CODE[phrase])
    if _contains_us_country(text):
        codes.add("US")

    # A trailing region wins over the city's default country so "Paris, TX"
    # is US and "London, ON" is Canada, not France / UK.
    if _looks_like_us_city_state(text):
        # "Berlin, DE" is Germany in job posts, not Berlin, Delaware. Only
        # keep the US-state reading when the city is not a known foreign city
        # whose ISO code is this same two-letter token.
        city_codes = _detect_cities(text)
        match = _COMMA_SEGMENT_RE.match(text.strip())
        region = match.group(2).strip().upper() if match else ""
        foreign = city_codes - {"US"}
        if foreign and region in foreign:
            codes |= foreign
            return codes
        codes.add("US")
        # Legacy quirk kept on purpose: "City, Georgia" reads as the US state,
        # not the country Georgia.
        codes.discard("GE")
        return codes

    match = _COMMA_SEGMENT_RE.match(text.strip())
    if match:
        region = match.group(2).strip()
        sub_code = SUBDIVISION_TO_CODE.get(region) or SUBDIVISION_TO_CODE.get(region.upper())
        if sub_code:
            codes.add(sub_code)
            return codes
        if len(region) == 2 and region.upper() in COUNTRY_NAMES:
            codes.add(region.upper())
            return codes

    codes |= _detect_cities(text)
    return codes


def _detect_region_groups(text: str) -> list[frozenset[str]]:
    groups: list[frozenset[str]] = []
    for token in _REGION_TOKENS_BY_LENGTH:
        if _has_word(text, token):
            groups.append(REGION_GROUPS[token])
    return groups


def _is_worldwide(text: str) -> bool:
    if text in WORLDWIDE_TOKENS:
        return True
    for token in WORLDWIDE_TOKENS:
        # "international" only counts as an exact match ("International Airport",
        # "international travel" must not read as open-to-any-country).
        if token == "international":
            continue
        if _has_word(text, token):
            return True
    return False


def _split_into_segments(text: str) -> list[str]:
    if not text:
        return []
    segments = [seg for seg in _SEGMENT_SPLIT_RE.split(text) if seg.strip()]
    return segments or [text]


def _classify_segment_for_countries(
    segment: str,
    allowed: frozenset[str],
    *,
    allow_region_fallback: bool,
    strict_unrecognized_region: bool,
) -> CountryMatchVerdict:
    """Classify one location segment against the preferred-country set.

    ``allow_region_fallback`` gates the generic "city, region" heuristic. It is
    enabled for the trusted structured ``location`` field but disabled for the
    free-form ``remote_policy`` text, whose prose (e.g. "..., travel less than
    25%") must never be mistaken for a foreign region.

    ``strict_unrecognized_region`` keeps the historical US-only behavior where
    an unrecognized "City, Region" (region is not a US state) is treated as
    foreign. It is only safe for the {"US"} preference set because US postings
    near-universally use the "City, ST" format; for other preference sets an
    unrecognized region stays UNKNOWN (kept visible).
    """
    text = _normalize(segment)
    if not text:
        return CountryMatchVerdict.UNKNOWN

    # Explicit country / region signals win, and are checked FIRST so
    # "anywhere in Germany" is still resolved by country rather than by the
    # worldwide token. Inclusion wins within a segment: "US or Canada" is
    # eligible for a US-preferring user even though Canada is also named.
    codes = _detect_country_codes(text)
    groups = _detect_region_groups(text)
    if codes or groups:
        if codes & allowed:
            return CountryMatchVerdict.MATCH
        if any(group & allowed for group in groups):
            return CountryMatchVerdict.MATCH
        return CountryMatchVerdict.NO_MATCH

    if _is_worldwide(text):
        return CountryMatchVerdict.MATCH
    if text in _PLACEHOLDER_LOCATIONS:
        return CountryMatchVerdict.UNKNOWN

    # Remote/hybrid descriptive text is prose, not a location. Guard here -
    # BEFORE the generic comma heuristic - so a sentence such as
    # "Remote position ..., travel less than 25%" is not misread as non-US.
    if text.startswith("remote") or text.startswith("hybrid"):
        return CountryMatchVerdict.UNKNOWN

    match = _COMMA_SEGMENT_RE.match(text)
    if match:
        region = match.group(2).strip()
        if region.upper() in _US_STATE_ABBREVS or region in _US_STATE_NAMES:
            return (
                CountryMatchVerdict.MATCH
                if "US" in allowed
                else CountryMatchVerdict.NO_MATCH
            )
        sub_code = SUBDIVISION_TO_CODE.get(region) or SUBDIVISION_TO_CODE.get(region.upper())
        if sub_code:
            return (
                CountryMatchVerdict.MATCH
                if sub_code in allowed
                else CountryMatchVerdict.NO_MATCH
            )
        if (
            allow_region_fallback
            and strict_unrecognized_region
            and len(region) >= 3
            and not region.isdigit()
            # A trailing prose/placeholder word ("Remote", "Hybrid", "Anywhere")
            # is not a foreign region - e.g. "USA, Remote" must not be non-US.
            and region not in _PLACEHOLDER_LOCATIONS
            and _looks_like_region_name(region)
        ):
            return CountryMatchVerdict.NO_MATCH

    return CountryMatchVerdict.UNKNOWN


def classify_job_location_for_countries(
    location: str | None,
    *,
    remote_policy: str | None = None,
    allowed_countries: Iterable[str],
) -> tuple[CountryMatchVerdict, str]:
    """Classify a job's location against a set of preferred country codes.

    Returns ``(verdict, detail)``. An empty preference set disables filtering
    (always MATCH). Segment aggregation mirrors the historical policy:
    an explicit outside-preference segment wins over a matching one, a match
    wins over unknown, and all-unknown stays unknown (kept visible).
    """
    allowed = frozenset(str(c).strip().upper() for c in allowed_countries if str(c).strip())
    location_clean = location.strip() if location and location.strip() else ""
    remote_clean = remote_policy.strip() if remote_policy and remote_policy.strip() else ""
    combined = " | ".join(p for p in (location_clean, remote_clean) if p)

    if not allowed:
        return CountryMatchVerdict.MATCH, "no country preference filter"
    if not location_clean and not remote_clean:
        return CountryMatchVerdict.UNKNOWN, "missing location"

    strict_unrecognized_region = allowed == frozenset({"US"})

    verdicts: list[CountryMatchVerdict] = []
    # Structured location field: trusted - full heuristics incl. the comma region fallback.
    for seg in _split_into_segments(location_clean):
        verdicts.append(
            _classify_segment_for_countries(
                seg,
                allowed,
                allow_region_fallback=True,
                strict_unrecognized_region=strict_unrecognized_region,
            )
        )
    # Remote policy: free-form prose - only trust explicit country/region keywords,
    # never the generic "city, region" fallback (avoids false non-US from sentences).
    for seg in _split_into_segments(remote_clean):
        verdicts.append(
            _classify_segment_for_countries(
                seg,
                allowed,
                allow_region_fallback=False,
                strict_unrecognized_region=strict_unrecognized_region,
            )
        )

    preferred_names = describe_country_list(sorted(allowed))
    if CountryMatchVerdict.NO_MATCH in verdicts:
        return (
            CountryMatchVerdict.NO_MATCH,
            f"location outside preferred countries ({preferred_names}): {combined[:120]}",
        )
    if CountryMatchVerdict.MATCH in verdicts:
        return (
            CountryMatchVerdict.MATCH,
            f"location matches preferred countries: {combined[:120]}",
        )
    return CountryMatchVerdict.UNKNOWN, f"location needs review: {combined[:120]}"


def keeps_preferred_job_pool(
    location: str | None,
    *,
    remote_policy: str | None = None,
    allowed_countries: Iterable[str],
) -> tuple[bool, CountryMatchVerdict, str]:
    """Whether a job should stay in the user's visible pool.

    Only locations that explicitly resolve outside the preferred countries are
    dropped. Missing / ambiguous locations are kept so users can filter them
    later themselves. An empty preference list keeps everything.
    """
    verdict, detail = classify_job_location_for_countries(
        location,
        remote_policy=remote_policy,
        allowed_countries=allowed_countries,
    )
    return verdict != CountryMatchVerdict.NO_MATCH, verdict, detail


def detect_countries_in_text(text: str | None) -> list[str]:
    """Best-effort country codes named in a free-form location string.

    Used by the resume country auto-detector. Returns explicit country hits
    first; falls back to the "City, Region" subdivision heuristic
    ("Toronto, Ontario" → CA, "Austin, TX" → US). Empty when nothing
    recognizable is found.
    """
    normalized = _normalize(text)
    if not normalized or normalized in _PLACEHOLDER_LOCATIONS:
        return []
    codes: set[str] = set()
    for seg in _split_into_segments(normalized):
        codes |= _detect_country_codes(seg)
    return sorted(codes)


# ---- Legacy US-only API (wrappers over the generalized classifier) ----

_LEGACY_US_SET = frozenset({"US"})

_COUNTRY_TO_LOCATION_VERDICT = {
    CountryMatchVerdict.MATCH: LocationVerdict.US,
    CountryMatchVerdict.NO_MATCH: LocationVerdict.NON_US,
    CountryMatchVerdict.UNKNOWN: LocationVerdict.UNKNOWN,
}


def classify_job_location(
    location: str | None,
    *,
    remote_policy: str | None = None,
) -> tuple[LocationVerdict, str]:
    """Return (verdict, detail) using structured location and optional remote policy.

    Legacy US-pool classification, equivalent to the generalized classifier
    with ``allowed_countries={"US"}``.
    """
    location_clean = location.strip() if location and location.strip() else ""
    remote_clean = remote_policy.strip() if remote_policy and remote_policy.strip() else ""
    combined = " | ".join(p for p in (location_clean, remote_clean) if p)

    verdict, _detail = classify_job_location_for_countries(
        location,
        remote_policy=remote_policy,
        allowed_countries=_LEGACY_US_SET,
    )
    mapped = _COUNTRY_TO_LOCATION_VERDICT[verdict]
    if not location_clean and not remote_clean:
        return LocationVerdict.UNKNOWN, "missing location"
    if mapped == LocationVerdict.NON_US:
        return mapped, f"non-US location detected: {combined[:120]}"
    if mapped == LocationVerdict.US:
        return mapped, f"US location: {combined[:120]}"
    return mapped, f"location needs review: {combined[:120]}"


def job_was_added_by_user(raw_metadata: Any, user_id: str) -> bool:
    """True when this viewer submitted the job (not an admin FA add)."""
    meta = raw_metadata if isinstance(raw_metadata, dict) else {}
    if not meta.get("submitted_data"):
        return False
    if str(meta.get("submitted_by_admin") or "").lower() == "true":
        return False
    return str(meta.get("submitted_by_user_id") or "") == str(user_id or "")


def job_added_by_user_clause(user_id: str):
    """SQLAlchemy clause matching ``job_was_added_by_user``."""
    from sqlalchemy import and_, or_

    from app.models.database import Job

    return and_(
        Job.raw_metadata["submitted_data"].isnot(None),
        Job.raw_metadata["submitted_by_user_id"].as_string() == (user_id or ""),
        or_(
            Job.raw_metadata["submitted_by_admin"].as_string().is_(None),
            Job.raw_metadata["submitted_by_admin"].as_string() != "true",
        ),
    )


def _sql_word_pattern(phrase: str) -> str:
    """Alphanumeric-boundary pattern for Postgres ``~*`` (POSIX classes)."""
    return rf"(^|[^[:alnum:]]){re.escape(phrase)}([^[:alnum:]]|$)"


@lru_cache(maxsize=64)
def _allowed_location_regex(allowed: frozenset[str]) -> str | None:
    """POSIX regex that matches an explicit preferred-country signal."""
    if not allowed:
        return None
    phrases: list[str] = [p for p, code in PHRASE_TO_CODE.items() if code in allowed]
    phrases.extend(city for city, code in CITY_TO_CODE.items() if code in allowed)
    phrases.extend(code.lower() for code in allowed if code not in _US_STATE_ABBREVS or code == "US")
    for token, group in REGION_GROUPS.items():
        if group & allowed:
            phrases.append(token)
    extras: list[str] = []
    if "US" in allowed:
        extras.append(_sql_word_pattern("us"))
        extras.append(rf",\s*(?:{'|'.join(sorted(_US_STATE_ABBREVS))})([^[:alnum:]]|$)")
        phrases.extend(name for name in _US_STATE_NAMES)
    if not phrases and not extras:
        return None
    parts = [_sql_word_pattern(p) for p in phrases]
    parts.extend(extras)
    return "(?:" + ")|(?:".join(parts) + ")"


@lru_cache(maxsize=64)
def _outside_location_regex(allowed: frozenset[str]) -> str | None:
    """POSIX regex that matches locations explicitly outside ``allowed``."""
    if not allowed:
        return None

    forbidden: list[str] = []
    for phrase, code in PHRASE_TO_CODE.items():
        if code in allowed:
            continue
        if phrase == "georgia" and "US" in allowed:
            continue
        forbidden.append(phrase)

    for token, group in REGION_GROUPS.items():
        if group.isdisjoint(allowed):
            forbidden.append(token)

    from app.services.country_catalog import COUNTRY_NAMES, SUBDIVISION_TO_CODE

    for city, code in CITY_TO_CODE.items():
        if code not in allowed:
            forbidden.append(city)

    for name, code in SUBDIVISION_TO_CODE.items():
        if code not in allowed:
            forbidden.append(name.lower() if name != name.upper() else name)

    # Bare ISO codes ("London, GB") that are not also US state abbreviations.
    for code in COUNTRY_NAMES:
        if code in allowed or code in _US_STATE_ABBREVS:
            continue
        forbidden.append(code.lower())

    extras: list[str] = []
    if "US" not in allowed:
        abbrevs = "|".join(sorted(_US_STATE_ABBREVS))
        extras.append(rf",\s*(?:{abbrevs})([^[:alnum:]]|$)")
        for name in _US_STATE_NAMES:
            if name == "georgia" and "GE" in allowed:
                continue
            forbidden.append(name)
        extras.append(_sql_word_pattern("us"))

    if not forbidden and not extras:
        return None

    parts = [_sql_word_pattern(p) for p in forbidden]
    parts.extend(extras)
    return "(?:" + ")|(?:".join(parts) + ")"


def location_explicitly_outside_preferences_clause(allowed_countries: Iterable[str]):
    """SQL: ``Job.location`` names a country/region outside the preference set."""
    allowed = frozenset(str(c).strip().upper() for c in allowed_countries if str(c).strip())
    pattern = _outside_location_regex(allowed)
    if not pattern:
        return None

    from sqlalchemy import func

    from app.models.database import Job

    return func.coalesce(Job.location, "").op("~*")(pattern)


def location_matches_preferred_clause(allowed_countries: Iterable[str]):
    """SQL: ``Job.location`` names a preferred country or overlapping region."""
    allowed = frozenset(str(c).strip().upper() for c in allowed_countries if str(c).strip())
    pattern = _allowed_location_regex(allowed)
    if not pattern:
        return None

    from sqlalchemy import func

    from app.models.database import Job

    return func.coalesce(Job.location, "").op("~*")(pattern)


def preferred_pool_visibility_clause(user_id: str, allowed_countries: Iterable[str]):
    """Keep jobs this viewer added; hide others that explicitly resolve outside prefs.

    Empty preferences disable location filtering. A location that names both a
    preferred country and a non-preferred one stays visible (``US or Canada``
    for a US user). Only explicit outside-only locations are dropped.
    """
    from sqlalchemy import or_

    allowed = [str(c).strip().upper() for c in allowed_countries if str(c).strip()]
    if not allowed:
        return None
    outside = location_explicitly_outside_preferences_clause(allowed)
    if outside is None:
        return None
    matching = location_matches_preferred_clause(allowed)
    if matching is None:
        return or_(job_added_by_user_clause(user_id), ~outside)
    return or_(job_added_by_user_clause(user_id), matching, ~outside)


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
