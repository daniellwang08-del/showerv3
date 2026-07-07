"""Schemas for the Resume Builder "OneClick AI" chat center.

This is a job-less tailoring surface: the user pastes a raw job description into the
builder's AI center and the assistant can analyze the match, tailor the resume, or
refine a previous tailoring. Nothing here persists a Job/ValidJob — results are handed
straight back to the Resume Builder's design content.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.models.resume_design_schemas import ContentSkill, ContentWork


class ResumeAiChatMessage(BaseModel):
    """One turn of the conversation as supplied by the client."""

    role: Literal["user", "assistant"]
    content: str = ""


class ResumeAiChatRequest(BaseModel):
    messages: list[ResumeAiChatMessage] = Field(default_factory=list)
    # The job description the client most recently captured, so "refine"/follow-up
    # turns can re-tailor without the user re-pasting the whole posting.
    last_job_description: str | None = None


class ResumeAiMatch(BaseModel):
    overall_score: int = 0
    recommendation: str = ""
    summary: str = ""
    strengths: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    dimension_scores: dict[str, int] = Field(default_factory=dict)


class ResumeAiTailoredContent(BaseModel):
    """The tailored sections only. The frontend merges these onto the profile-seeded
    content so header/education/certificates are preserved."""

    profile_summary: str = ""
    technical_skills: list[ContentSkill] = Field(default_factory=list)
    work_experience: list[ContentWork] = Field(default_factory=list)


ResumeAiAction = Literal["tailored", "analyzed", "none"]


class ResumeAiChatResponse(BaseModel):
    reply: str = ""
    intent: str = "chat"
    action: ResumeAiAction = "none"
    # Echo of the job description used this turn, so the client can remember it for
    # subsequent "refine" turns.
    job_description: str | None = None
    job_title: str | None = None
    company: str | None = None
    content: ResumeAiTailoredContent | None = None
    cover_letter: str | None = None
    match: ResumeAiMatch | None = None
