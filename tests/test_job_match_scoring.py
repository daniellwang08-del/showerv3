"""Tests for Phase A match score computation and scoring context helpers."""

from types import SimpleNamespace

from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.job_match_service import (
    _compute_overall_score,
    _format_custom_guidance_text,
    _format_job_preferences_text,
    _format_source_documents_for_scoring,
    _normalize_work_mode,
    _parse_match_section,
    _zero_match_result,
)


def test_match_dimension_weights_sum_to_one():
    assert abs(sum(MATCH_DIMENSION_WEIGHTS.values()) - 1.0) < 1e-9


def test_compute_overall_score_weighted_average():
    dims = {
        "skills_match": 90,
        "experience_match": 80,
        "job_title_similarity": 70,
        "industry_domain_match": 60,
        "education": 50,
        "user_preferences": 40,
    }
    # 90*0.30 + 80*0.20 + 70*0.15 + 60*0.18 + 50*0.05 + 40*0.12 = 71.6 -> 72
    assert _compute_overall_score(dims) == 72


def test_industry_weight_elevated_over_education():
    assert MATCH_DIMENSION_WEIGHTS["industry_domain_match"] > MATCH_DIMENSION_WEIGHTS["education"]
    assert MATCH_DIMENSION_WEIGHTS["industry_domain_match"] >= 0.15


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


def test_format_job_preferences_empty_is_neutral():
    text = _format_job_preferences_text(None)
    assert "50" in text
    assert "remote" in text.lower()


def test_format_custom_guidance_only_when_custom_mode():
    empty = _format_custom_guidance_text(prompt_mode="default", prompt_custom="Prefer fintech")
    assert "No custom guidance" in empty

    custom = _format_custom_guidance_text(
        prompt_mode="custom",
        prompt_custom="Target Staff Engineer IC roles in healthcare startups.",
    )
    assert "Staff Engineer" in custom
    assert "healthcare" in custom


def test_format_source_documents_for_scoring_includes_projects():
    doc = SimpleNamespace(
        company_name="Acme Health",
        filename="acme-projects.pdf",
        extracted_text="",
        structured_data={
            "company_name": "Acme Health",
            "projects": [
                {
                    "name": "Claims Platform",
                    "summary": "Built claims intake for hospitals",
                    "technologies": ["Python", "Kafka"],
                    "outcomes": ["Reduced processing time 40%"],
                }
            ],
        },
    )
    text = _format_source_documents_for_scoring([doc])
    assert "Acme Health" in text
    assert "Claims Platform" in text
    assert "Python" in text


def test_format_source_documents_empty():
    text = _format_source_documents_for_scoring([])
    assert "No attached source documents" in text
