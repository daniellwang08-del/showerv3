"""Tests for Phase B prompt assembly and cover letter prompt settings."""

from __future__ import annotations

from app.prompts.cover_letter_prompt import COVER_LETTER_INSTRUCTIONS
from app.prompts.job_match_phase_b_prompt import (
    JOB_MATCH_PHASE_B_OUTPUT_CONTRACT,
    RESUME_TAILORING_INSTRUCTIONS,
    build_phase_b_system_prompt,
)


def test_build_phase_b_system_prompt_combines_resume_and_cover_letter():
    system = build_phase_b_system_prompt(
        "Custom resume section",
        "Custom cover letter section",
    )
    assert "Custom resume section" in system
    assert "Custom cover letter section" in system
    assert "tailored_resume" in system
    assert "cover_letter" in system
    assert system.endswith(JOB_MATCH_PHASE_B_OUTPUT_CONTRACT.strip()[-20:])


def test_build_phase_b_system_prompt_uses_defaults_when_empty():
    system = build_phase_b_system_prompt("", "")
    assert RESUME_TAILORING_INSTRUCTIONS.strip() in system
    assert COVER_LETTER_INSTRUCTIONS.strip() in system
