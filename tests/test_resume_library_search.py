"""Unit tests for resume library + job-build search helpers."""

from app.storage.resume_document_repository import resume_search_ilike_pattern
from app.services.resume_design_service import (
    _merge_tailored_into_design,
    _norm_key,
    _serialize_search_job_build,
)
from app.services.resume_themes import default_design


def test_ilike_pattern_wraps_and_escapes_wildcards():
    assert resume_search_ilike_pattern("Acme") == "%Acme%"
    assert resume_search_ilike_pattern("100%") == r"%100\%%"
    assert resume_search_ilike_pattern("a_b") == r"%a\_b%"
    assert resume_search_ilike_pattern(r"a\b") == r"%a\\b%"


def test_norm_key_is_case_insensitive():
    assert _norm_key("Impruvon", "Senior Software Engineer") == _norm_key(
        "impruvon", "senior software engineer"
    )
    assert _norm_key(None, None) == "::"


def test_merge_tailored_maps_bullets_to_contributions():
    base = default_design()
    tailored = {
        "profile_summary": "Seasoned engineer.",
        "technical_skills": [{"category": "Backend", "skills": "Python, FastAPI"}],
        "work_experience": [
            {
                "company_name": "Acme",
                "job_title": "Engineer",
                "period_start": "2020-01",
                "period_end": None,
                "location": "Remote",
                "employment_type": "Full-time",
                "project_name": "Platform",
                "project_description": "Built APIs.",
                "used_skills": "Python",
                "bullets": ["Shipped X", "Led Y"],
            }
        ],
    }
    merged = _merge_tailored_into_design(base, tailored)
    assert merged.content is not None
    assert merged.content.profile_summary == "Seasoned engineer."
    assert merged.content.technical_skills[0].category == "Backend"
    we = merged.content.work_experience[0]
    assert we.company_name == "Acme"
    assert we.project_title == "Platform"
    assert we.contributions == ["Shipped X", "Led Y"]


def test_serialize_job_build_hit():
    class B:
        id = "build-1"
        content_generation_status = "completed"
        created_at = None
        updated_at = None

    class J:
        id = "job-1"
        company = "Impruvon"
        title = "Senior Software Engineer"

    hit = _serialize_search_job_build(B(), J(), active_id=None)
    assert hit["kind"] == "job_build"
    assert hit["company"] == "Impruvon"
    assert hit["job_title"] == "Senior Software Engineer"
    assert hit["content_ready"] is True
