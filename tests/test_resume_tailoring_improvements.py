"""Resume tailoring improvements: company-matched WE merge + Phase B quality soft-retry."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.job_match_service import (
    generate_tailored_content_phase_b,
    tailored_resume_quality_issues,
)
from app.services.resume_context_builder import _merge_tailored_work_experience


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
    assert any("bullets_below" in i for i in issues)


def _good_resume() -> dict:
    bullets = [f"**Skill{i}** accomplishment line {i}" for i in range(7)]
    return {
        "profile_summary": "Experienced engineer with deep backend and platform ownership across products.",
        "technical_skills": [{"category": "Languages", "skills": "Python, Go"}],
        "work_experience": [
            {
                "company_name": "Acme",
                "job_title": "Engineer",
                "bullets": bullets,
                "project_description": "Platform work",
            }
        ],
    }


@pytest.mark.asyncio
async def test_phase_b_soft_retries_on_quality_issues() -> None:
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
            "Job text " * 20,
            "Profile text with plenty of content for truncation checks.",
        )

    assert call_mock.await_count == 2
    assert tailored is not None
    assert len(tailored["work_experience"][0]["bullets"]) >= 7
    assert cover is not None
    assert "QUALITY RETRY" in call_mock.await_args_list[1].kwargs["user_content"]
