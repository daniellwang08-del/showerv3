"""Canonical user_job_status exclusion_type values and hidden-list categories."""

from __future__ import annotations

from sqlalchemy import or_

BELOW_MIN_SCORE_EXCLUSION = "below_min_score"
NOT_A_JOB_POSTING_EXCLUSION = "not_a_job_posting"
SECURITY_CLEARANCE_EXCLUSION = "security_clearance"
EXTRACTION_FAILED_EXCLUSION = "extraction_failed"
SAME_URL_EXCLUSION = "same_url"
STRICT_SIMILARITY_EXCLUSION = "strict_similarity"
LOWER_SCORE_EXCLUSION = "lower_score"
SUPERSEDED_BY_HIGHER_EXCLUSION = "superseded_by_higher"
APPLIED_COMPANY_EXCLUSION = "applied_company"
BLOCKED_DOMAIN_EXCLUSION = "blocked_domain"
LINKEDIN_JOB_EXCLUSION = "linkedin_job"
NON_US_LOCATION_EXCLUSION = "non_us_location"  # legacy rows (pre country-preferences)
OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION = "outside_preferred_countries"
LOCATION_UNKNOWN_EXCLUSION = "location_unknown"

# Location-based auto-exclusions (safe to bulk-restore when prefs change).
LOCATION_EXCLUSION_TYPES = frozenset({
    NON_US_LOCATION_EXCLUSION,
    OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION,
    LOCATION_UNKNOWN_EXCLUSION,
})

INVALID_JOB_CATEGORIES = frozenset({
    "duplicates",
    "low_score",
    "extraction_failed",
    "non_us",
})

_CATEGORY_ONLY: dict[str, frozenset[str | None]] = {
    "low_score": frozenset({
        BELOW_MIN_SCORE_EXCLUSION,
        NOT_A_JOB_POSTING_EXCLUSION,
        SECURITY_CLEARANCE_EXCLUSION,
    }),
    "extraction_failed": frozenset({EXTRACTION_FAILED_EXCLUSION}),
    # Category key kept as "non_us" for API compatibility; it now means
    # "outside the user's preferred countries" and covers legacy rows too.
    "non_us": frozenset({NON_US_LOCATION_EXCLUSION, OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION}),
}

_EXCLUDED_FROM_DUPLICATES_TAB = frozenset({
    BELOW_MIN_SCORE_EXCLUSION,
    NOT_A_JOB_POSTING_EXCLUSION,
    SECURITY_CLEARANCE_EXCLUSION,
    EXTRACTION_FAILED_EXCLUSION,
    NON_US_LOCATION_EXCLUSION,
    OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION,
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
        return exclusion_type_column.in_(
            [
                BELOW_MIN_SCORE_EXCLUSION,
                NOT_A_JOB_POSTING_EXCLUSION,
                SECURITY_CLEARANCE_EXCLUSION,
            ]
        )
    if category == "extraction_failed":
        return exclusion_type_column == EXTRACTION_FAILED_EXCLUSION
    if category == "non_us":
        return exclusion_type_column.in_(
            [NON_US_LOCATION_EXCLUSION, OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION]
        )
    return or_(
        exclusion_type_column.is_(None),
        exclusion_type_column.notin_(list(_EXCLUDED_FROM_DUPLICATES_TAB)),
    )
