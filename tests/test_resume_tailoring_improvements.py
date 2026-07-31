"""Resume tailoring improvements: company-matched WE merge + Phase B quality soft-retry."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.prompts.job_match_phase_b_prompt import (
    JOB_MATCH_PHASE_B_USER_TEMPLATE,
    RESUME_TAILORING_INSTRUCTIONS,
)
from app.services.job_match_service import (
    _pick_better_tailored_resume,
    build_must_cover_requirements,
    generate_tailored_content_phase_b,
    tailored_resume_coverage_score,
    tailored_resume_quality_issues,
)
from app.services.resume_builder_service import build_output_directory
from app.services.resume_context_builder import _merge_tailored_work_experience
from app.utils.resume_keyword_emphasis import (
    apply_keyword_emphasis_to_resume,
    emphasize_keywords_in_text,
)


def test_phase_b_prompt_is_job_first_rewrite():
    assert "near-perfect ATS fit" in RESUME_TAILORING_INSTRUCTIONS
    assert "technologies only" in RESUME_TAILORING_INSTRUCTIONS.lower() or "Technologies only" in RESUME_TAILORING_INSTRUCTIONS
    assert "index 0" in RESUME_TAILORING_INSTRUCTIONS.lower() or "Index 0" in RESUME_TAILORING_INSTRUCTIONS
    assert "{must_cover_requirements}" in JOB_MATCH_PHASE_B_USER_TEMPLATE
    assert "{company_domain_cues}" in JOB_MATCH_PHASE_B_USER_TEMPLATE


def test_build_must_cover_requirements_from_structured_block():
    structured = (
        "Title: Senior Backend Engineer\n"
        "Key requirements (prioritize these in tailored content):\n"
        "- Kubernetes\n"
        "- Kafka event streaming\n"
        "- PostgreSQL\n"
    )
    text = build_must_cover_requirements(structured, "")
    assert "Kubernetes" in text
    assert "Kafka" in text


def test_merge_tailored_work_experience_matches_by_company_not_index():
    profile = [
        {"company_name": "Acme", "job_title": "Engineer", "contributions": ["shipped A"], "project_title": "", "project_intro": "", "description": "", "used_skills": "", "period": "2020–2022", "location": "", "employment_type": "", "job_type": ""},
        {"company_name": "BetaCo", "job_title": "Lead", "contributions": ["led B"], "project_title": "", "project_intro": "", "description": "", "used_skills": "", "period": "2022–Present", "location": "", "employment_type": "", "job_type": ""},
    ]
    # Intentionally reordered relative to profile
    tailored = [
        {
            "company_name": "BetaCo",
            "job_title": "Lead",
            "bullets": ["**Led** platform rewrite", "Improved **latency**"],
            "project_description": "Platform",
            "used_skills": "Go",
        },
        {
            "company_name": "Acme",
            "job_title": "Engineer",
            "bullets": ["Built **API** gateway"],
            "project_description": "Gateway",
            "used_skills": "Python",
        },
    ]
    merged = _merge_tailored_work_experience(profile, tailored)
    assert merged[0]["company_name"] == "Acme"
    assert any("API" in b for b in merged[0]["bullets"])
    assert "**API**" in merged[0]["bullets"][0]
    assert merged[1]["company_name"] == "BetaCo"
    assert any("platform" in b.lower() for b in merged[1]["bullets"])


def test_tailored_resume_quality_issues_flags_thin_bullets():
    resume = {
        "profile_summary": "Short",
        "technical_skills": [],
        "work_experience": [
            {"company_name": "Acme", "job_title": "Eng", "bullets": ["one", "two"]},
        ],
    }
    issues = tailored_resume_quality_issues(resume)
    assert "profile_summary_too_short" in issues
    assert "technical_skills_missing" in issues
    assert any("bullets_below_8" in i for i in issues)


def test_tailored_resume_quality_issues_flags_missing_job_alignment():
    bullets = [f"Generic accomplishment line {i}" for i in range(8)]
    resume = {
        "profile_summary": "Experienced engineer with deep backend and platform ownership across products and teams.",
        "technical_skills": [{"category": "Languages", "skills": "Python, Go"}],
        "work_experience": [
            {"company_name": "Acme", "job_title": "Eng", "bullets": bullets},
        ],
    }
    issues = tailored_resume_quality_issues(
        resume,
        job_anchor_terms=["Kubernetes", "Kafka", "Terraform", "gRPC", "Postgres", "Redis"],
    )
    assert "insufficient_job_keyword_alignment" in issues


def test_tailored_resume_quality_issues_flags_soft_skill_jargon():
    bullets = [f"**Python** accomplishment line {i} with **AWS**" for i in range(8)]
    resume = {
        "profile_summary": (
            "Senior Software Engineer with 10+ years building backend platforms for "
            "high-scale SaaS products using modern cloud stacks."
        ),
        "technical_skills": [
            {"category": "Soft Skills", "skills": "Leadership, Communication, Agile"},
            {"category": "Skills", "skills": "Teamwork, Collaboration"},
        ],
        "work_experience": [
            {"company_name": "Acme", "job_title": "Eng", "bullets": bullets},
        ],
    }
    issues = tailored_resume_quality_issues(
        resume,
        job_anchor_terms=["Python", "AWS", "Kubernetes", "Kafka", "Postgres", "Redis"],
        role_domain_cues=["Software Engineer", "SaaS"],
    )
    assert "technical_skills_contain_soft_jargon" in issues


def test_pick_better_tailored_resume_prefers_higher_coverage():
    weak_bullets = [f"Generic line {i}" for i in range(8)]
    strong_bullets = [
        f"**Kubernetes** and **Kafka** accomplishment {i} on **Postgres**"
        for i in range(8)
    ]
    weak = {
        "profile_summary": "Experienced engineer with deep backend and platform ownership across products and teams.",
        "technical_skills": [{"category": "Languages", "skills": "Python"}],
        "work_experience": [{"company_name": "Acme", "job_title": "Eng", "bullets": weak_bullets}],
    }
    strong = {
        "profile_summary": (
            "Senior Backend Engineer specializing in Kubernetes, Kafka, and Postgres platforms "
            "for high-scale distributed systems."
        ),
        "technical_skills": [
            {"category": "Cloud & DevOps", "skills": "**Kubernetes**, Terraform"},
            {"category": "Data & Messaging", "skills": "**Kafka**, **Postgres**"},
        ],
        "work_experience": [{"company_name": "Acme", "job_title": "Eng", "bullets": strong_bullets}],
    }
    anchors = ["Kubernetes", "Kafka", "Postgres", "Terraform", "gRPC", "Redis"]
    chosen = _pick_better_tailored_resume(weak, strong, job_anchor_terms=anchors)
    assert chosen is strong
    assert tailored_resume_coverage_score(strong, job_anchor_terms=anchors) > (
        tailored_resume_coverage_score(weak, job_anchor_terms=anchors)
    )


def test_emphasize_keywords_bolds_tech_terms_without_double_wrap():
    text = "Built Kubernetes services with **Kafka** and Postgres."
    out = emphasize_keywords_in_text(text, ["Kubernetes", "Kafka", "Postgres"])
    assert "**Kubernetes**" in out
    assert "**Postgres**" in out
    assert out.count("**Kafka**") == 1
    assert "****" not in out


def test_apply_keyword_emphasis_to_resume_updates_narrative_fields():
    resume = {
        "profile_summary": "Engineer using Kubernetes daily.",
        "technical_skills": [{"category": "Cloud", "skills": "Kubernetes, AWS"}],
        "work_experience": [
            {
                "company_name": "Acme",
                "job_title": "Eng",
                "project_description": "Ran Kafka pipelines",
                "bullets": ["Scaled Postgres clusters"],
                "used_skills": "Kafka, Postgres",
            }
        ],
    }
    out = apply_keyword_emphasis_to_resume(
        resume, ["Kubernetes", "Kafka", "Postgres", "AWS"]
    )
    assert "**Kubernetes**" in out["profile_summary"]
    assert "**AWS**" in out["technical_skills"][0]["skills"]
    assert "**Kafka**" in out["work_experience"][0]["project_description"]
    assert "**Postgres**" in out["work_experience"][0]["bullets"][0]


def test_build_output_directory_is_unique_per_job(tmp_path, monkeypatch):
    from app.core import config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "resume_output_root", str(tmp_path))

    a = build_output_directory("Acme Corp", "job-aaaa-1111")
    b = build_output_directory("Acme Corp", "job-bbbb-2222")
    c = build_output_directory("", "job-cccc-3333")
    d = build_output_directory("", "job-dddd-4444")

    assert a != b
    assert c != d
    assert a.name == "job-aaaa-1111"
    assert b.name == "job-bbbb-2222"
    assert Path(a).is_dir() and Path(b).is_dir()


def _good_resume() -> dict:
    bullets = [
        f"**Kubernetes** **Kafka** accomplishment line {i} on **Postgres**"
        for i in range(8)
    ]
    return {
        "profile_summary": (
            "Senior Backend Engineer with deep Kubernetes, Kafka, and Postgres ownership "
            "across distributed SaaS platforms."
        ),
        "technical_skills": [
            {"category": "Cloud & DevOps", "skills": "**Kubernetes**, Terraform"},
            {"category": "Data & Messaging", "skills": "**Kafka**, **Postgres**, Redis"},
        ],
        "work_experience": [
            {
                "company_name": "Acme",
                "job_title": "Engineer",
                "bullets": bullets,
                "project_description": "Platform work on **Kubernetes**",
            }
        ],
    }


@pytest.mark.asyncio
async def test_phase_b_soft_retries_and_picks_better_draft() -> None:
    thin = {
        "tailored_resume": {
            "profile_summary": "Too short",
            "technical_skills": [{"category": "X", "skills": "Y"}],
            "work_experience": [
                {"company_name": "Acme", "job_title": "Eng", "bullets": ["a", "b"]},
            ],
        },
        "cover_letter": {"body": "Dear Hiring Manager,\n\nI am interested.\n"},
    }
    good = {
        "tailored_resume": _good_resume(),
        "cover_letter": {"body": "Dear Hiring Manager,\n\nFull letter body here.\n"},
    }

    with (
        patch(
            "app.services.job_match_service._call_openai_json",
            new_callable=AsyncMock,
            side_effect=[thin, good],
        ) as call_mock,
        patch("app.services.job_match_service.get_effective_value_sync", return_value=4096),
        patch("app.services.job_match_service.get_settings") as gs,
    ):
        gs.return_value = SimpleNamespace(openai_max_tokens=4096)
        tailored, cover = await generate_tailored_content_phase_b(
            "Job text with Kubernetes Kafka Postgres Terraform requirements " * 5,
            "Profile text with plenty of content for truncation checks.",
            structured_context=(
                "Title: Senior Backend Engineer\n"
                "Key requirements (prioritize these in tailored content):\n"
                "- Kubernetes\n- Kafka\n- Postgres\n- Terraform\n"
            ),
        )

    assert call_mock.await_count == 2
    assert tailored is not None
    assert len(tailored["work_experience"][0]["bullets"]) >= 8
    assert cover is not None
    assert "QUALITY RETRY" in call_mock.await_args_list[1].kwargs["user_content"]
    assert "must_cover_requirements" not in call_mock.await_args_list[0].kwargs["user_content"]
    assert "Must-cover requirements" in call_mock.await_args_list[0].kwargs["user_content"]
    # Bold post-pass should leave or add emphasis on JD tech terms.
    blob = " ".join(tailored["work_experience"][0]["bullets"])
    assert "**Kubernetes**" in blob or "Kubernetes" in blob
