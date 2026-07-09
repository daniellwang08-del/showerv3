"""Tests for Phase A match score computation."""

from app.services.job_match_service import (
    _compute_overall_score,
    _normalize_work_mode,
    _parse_match_section,
    _zero_match_result,
)


def test_compute_overall_score_weighted_average():
    dims = {
        "skills_match": 90,
        "experience_match": 80,
        "job_title_similarity": 70,
        "industry_domain_match": 60,
        "education": 50,
        "user_preferences": 40,
    }
    # 90*0.33 + 80*0.22 + 70*0.13 + 60*0.10 + 50*0.07 + 40*0.15 = 71.7 -> 72
    assert _compute_overall_score(dims) == 72


def test_parse_match_section_recomputes_overall():
    parsed = {
        "overall_score": 99,
        "dimension_scores": {
            "skills_match": 100,
            "experience_match": 100,
            "job_title_similarity": 100,
            "industry_domain_match": 100,
            "education": 100,
            "user_preferences": 100,
        },
        "summary": "Great fit",
        "strengths": ["Strong Python"],
        "gaps": [],
        "recommendation": "strong_match",
    }
    result = _parse_match_section(parsed, recompute_overall=True)
    assert result["overall_score"] == 100


def test_zero_match_result_security_clearance():
    result = _zero_match_result("Requires security clearance", requires_security_clearance=True)
    assert result["overall_score"] == 0
    assert result["requires_security_clearance"] is True
    assert all(v == 0 for v in result["dimension_scores"].values())


def test_normalize_work_mode():
    assert _normalize_work_mode("Remote") == "remote"
    assert _normalize_work_mode("hybrid - 3 days") == "hybrid"
    assert _normalize_work_mode("on-site") == "onsite"
    assert _normalize_work_mode(None) == "unknown"
