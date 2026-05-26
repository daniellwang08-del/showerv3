"""Pydantic models for resume template blueprints and API payloads."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


TemplateStatus = Literal["missing", "processing", "ready", "stale", "failed"]
TemplateEngine = Literal["blueprint", "legacy_exp_n"]
DetectedTemplateType = Literal["dynamic", "legacy_exp_n", "unknown"]


class FieldBinding(BaseModel):
    tag: str
    path: str
    label: str | None = None


class RepeatBlock(BaseModel):
    loop_open_tag: str = "{{#work_experience}}"
    loop_close_tag: str = "{{/work_experience}}"
    start_index: int
    end_index: int
    item_bindings: list[FieldBinding] = Field(default_factory=list)


class ResumeSection(BaseModel):
    id: str
    label: str
    type: Literal["static", "scalar", "repeat", "optional"] = "static"
    start_index: int = 0
    end_index: int = 0
    optional: bool = False
    bindings: list[FieldBinding] = Field(default_factory=list)
    repeat: RepeatBlock | None = None


class ResumeTemplateAiValidation(BaseModel):
    passed: bool
    template_type: DetectedTemplateType = "unknown"
    summary: str = ""
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    detected_required_tags: list[str] = Field(default_factory=list)
    missing_required_tags: list[str] = Field(default_factory=list)
    validated_at: datetime | None = None


class ResumeTemplateBlueprint(BaseModel):
    version: int = 1
    engine: TemplateEngine = "legacy_exp_n"
    sections: list[ResumeSection] = Field(default_factory=list)
    working_block: RepeatBlock | None = None
    detected_tags: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    ai_validation: ResumeTemplateAiValidation | None = None


class TemplatePlaceholderSpec(BaseModel):
    tag: str
    label: str
    required: bool = True
    description: str
    repeatable: bool = False


class TemplateFormatSpec(BaseModel):
    extension: str
    mime_type: str
    max_bytes: int
    notes: str


class TemplateTypeSpec(BaseModel):
    id: str
    label: str
    engine: TemplateEngine
    recommended: bool = False
    description: str
    required_placeholders: list[TemplatePlaceholderSpec] = Field(default_factory=list)
    optional_placeholders: list[TemplatePlaceholderSpec] = Field(default_factory=list)
    example_snippet: str = ""


class ResumeStyleSectionSpec(BaseModel):
    """One section of the canonical resume layout this app generates."""

    id: str
    heading: str
    description: str
    layout_example: str
    placeholders: list[TemplatePlaceholderSpec] = Field(default_factory=list)
    required: bool = True
    applies_to_profile: bool = True


class ResumeTemplateRequirementsResponse(BaseModel):
    file_format: TemplateFormatSpec
    resume_style_title: str = "Standard résumé layout"
    resume_style_intro: str = ""
    resume_style_sections: list[ResumeStyleSectionSpec] = Field(default_factory=list)
    template_types: list[TemplateTypeSpec] = Field(default_factory=list)
    validation_notes: list[str] = Field(default_factory=list)
    profile_work_count: int = 0


class TemplateVariableDefinition(BaseModel):
    tag: str
    path: str
    label: str
    group: str
    description: str
    repeatable: bool = False


class ResumeTemplateStatusResponse(BaseModel):
    resume_template_status: TemplateStatus
    resume_template_source_filename: str | None = None
    resume_template_error: str | None = None
    resume_template_profile_work_count: int | None = None
    resume_template_analyzed_at: datetime | None = None
    resume_template_ready: bool = False
    sections: list[ResumeSection] = Field(default_factory=list)
    detected_tags: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    profile_work_count: int = 0
    validation_errors: list[str] = Field(default_factory=list)
    detected_template_type: DetectedTemplateType | None = None
    ai_validation: ResumeTemplateAiValidation | None = None
    requirements: ResumeTemplateRequirementsResponse | None = None


class ResumeTemplateBlueprintUpdateRequest(BaseModel):
    blueprint: ResumeTemplateBlueprint


class ResumeTemplatePreviewResponse(BaseModel):
    docx_download_url: str | None = None
    message: str
