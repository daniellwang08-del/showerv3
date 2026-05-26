"""Canonical user_job_status exclusion_type values and hidden-list categories."""

from __future__ import annotations

from sqlalchemy import or_

BELOW_MIN_SCORE_EXCLUSION = "below_min_score"
EXTRACTION_FAILED_EXCLUSION = "extraction_failed"
SAME_URL_EXCLUSION = "same_url"
STRICT_SIMILARITY_EXCLUSION = "strict_similarity"
LOWER_SCORE_EXCLUSION = "lower_score"
SUPERSEDED_BY_HIGHER_EXCLUSION = "superseded_by_higher"
APPLIED_COMPANY_EXCLUSION = "applied_company"
BLOCKED_DOMAIN_EXCLUSION = "blocked_domain"
NON_US_LOCATION_EXCLUSION = "non_us_location"
LOCATION_UNKNOWN_EXCLUSION = "location_unknown"

INVALID_JOB_CATEGORIES = frozenset({
    "duplicates",
    "low_score",
    "extraction_failed",
    "non_us",
})

_CATEGORY_ONLY: dict[str, frozenset[str | None]] = {
    "low_score": frozenset({BELOW_MIN_SCORE_EXCLUSION}),
    "extraction_failed": frozenset({EXTRACTION_FAILED_EXCLUSION}),
    "non_us": frozenset({NON_US_LOCATION_EXCLUSION}),
}

_EXCLUDED_FROM_DUPLICATES_TAB = frozenset({
    BELOW_MIN_SCORE_EXCLUSION,
    EXTRACTION_FAILED_EXCLUSION,
    NON_US_LOCATION_EXCLUSION,
})


def exclusion_types_for_category(category: str) -> frozenset[str | None] | None:
    """Return allowed exclusion types for a tab, or None for the default duplicates tab."""
    if category == "duplicates":
        return None
    return _CATEGORY_ONLY.get(category)


def matches_invalid_job_category(exclusion_type: str | None, category: str) -> bool:
    if category == "duplicates":
        if exclusion_type is None:
            return True
        return exclusion_type not in _EXCLUDED_FROM_DUPLICATES_TAB
    allowed = _CATEGORY_ONLY.get(category)
    if allowed is None:
        return False
    return exclusion_type in allowed


def sql_filter_for_invalid_category(exclusion_type_column, category: str):
    """Build a SQLAlchemy filter for GET /jobs/invalid tab queries."""
    if category == "low_score":
        return exclusion_type_column == BELOW_MIN_SCORE_EXCLUSION
    if category == "extraction_failed":
        return exclusion_type_column == EXTRACTION_FAILED_EXCLUSION
    if category == "non_us":
        return exclusion_type_column == NON_US_LOCATION_EXCLUSION
    return or_(
        exclusion_type_column.is_(None),
        exclusion_type_column.notin_(list(_EXCLUDED_FROM_DUPLICATES_TAB)),
    )
