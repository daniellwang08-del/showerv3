"""Tests for hidden-job category classification."""

from app.services.job_exclusion_types import (
    BELOW_MIN_SCORE_EXCLUSION,
    EXTRACTION_FAILED_EXCLUSION,
    SAME_URL_EXCLUSION,
    STRICT_SIMILARITY_EXCLUSION,
    matches_invalid_job_category,
)


def test_duplicates_tab_includes_strict_similarity_and_same_url():
    assert matches_invalid_job_category(STRICT_SIMILARITY_EXCLUSION, "duplicates") is True
    assert matches_invalid_job_category(SAME_URL_EXCLUSION, "duplicates") is True
    assert matches_invalid_job_category(None, "duplicates") is True


def test_duplicates_tab_excludes_low_score_and_extraction_failed():
    assert matches_invalid_job_category(BELOW_MIN_SCORE_EXCLUSION, "duplicates") is False
    assert matches_invalid_job_category(EXTRACTION_FAILED_EXCLUSION, "duplicates") is False


def test_low_score_tab_only_below_min_score():
    assert matches_invalid_job_category(BELOW_MIN_SCORE_EXCLUSION, "low_score") is True
    assert matches_invalid_job_category(STRICT_SIMILARITY_EXCLUSION, "low_score") is False


def test_extraction_failed_tab_only_extraction_failed():
    assert matches_invalid_job_category(EXTRACTION_FAILED_EXCLUSION, "extraction_failed") is True
    assert matches_invalid_job_category(BELOW_MIN_SCORE_EXCLUSION, "extraction_failed") is False
