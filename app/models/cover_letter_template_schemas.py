"""Schemas for per-user cover letter template upload and validation."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CoverLetterTemplateStatus = Literal["missing", "processing", "ready", "failed"]


class CoverLetterPlaceholderSpec(BaseModel):
    tag: str
    description: str
    required: bool = False


class CoverLetterTemplateRequirements(BaseModel):
    max_bytes: int
    required_tags: list[CoverLetterPlaceholderSpec] = Field(default_factory=list)
    optional_tags: list[CoverLetterPlaceholderSpec] = Field(default_factory=list)
    layout_example: str = ""
    notes: list[str] = Field(default_factory=list)


class CoverLetterTemplateStatusResponse(BaseModel):
    cover_letter_template_status: CoverLetterTemplateStatus = "missing"
    cover_letter_template_source_filename: str | None = None
    cover_letter_template_error: str | None = None
    cover_letter_template_analyzed_at: datetime | None = None
    cover_letter_template_ready: bool = False
    detected_tags: list[str] = Field(default_factory=list)
    validation_errors: list[str] = Field(default_factory=list)
    validation_warnings: list[str] = Field(default_factory=list)
    requirements: CoverLetterTemplateRequirements | None = None
