"""Canonical user_job_status exclusion_type values and hidden-list categories."""

from __future__ import annotations

BELOW_MIN_SCORE_EXCLUSION = "below_min_score"
EXTRACTION_FAILED_EXCLUSION = "extraction_failed"
SAME_URL_EXCLUSION = "same_url"
STRICT_SIMILARITY_EXCLUSION = "strict_similarity"
LOWER_SCORE_EXCLUSION = "lower_score"
SUPERSEDED_BY_HIGHER_EXCLUSION = "superseded_by_higher"
APPLIED_COMPANY_EXCLUSION = "applied_company"
BLOCKED_DOMAIN_EXCLUSION = "blocked_domain"

INVALID_JOB_CATEGORIES = frozenset({"duplicates", "low_score", "extraction_failed"})

_CATEGORY_ONLY: dict[str, frozenset[str | None]] = {
    "low_score": frozenset({BELOW_MIN_SCORE_EXCLUSION}),
    "extraction_failed": frozenset({EXTRACTION_FAILED_EXCLUSION}),
}


def exclusion_types_for_category(category: str) -> frozenset[str | None] | None:
    """Return allowed exclusion types for a tab, or None for the default duplicates tab."""
    if category == "duplicates":
        return None
    return _CATEGORY_ONLY.get(category)


def matches_invalid_job_category(exclusion_type: str | None, category: str) -> bool:
    if category == "duplicates":
        if exclusion_type is None:
            return True
        return exclusion_type not in {
            BELOW_MIN_SCORE_EXCLUSION,
            EXTRACTION_FAILED_EXCLUSION,
        }
    allowed = _CATEGORY_ONLY.get(category)
    if allowed is None:
        return False
    return exclusion_type in allowed
