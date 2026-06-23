from pydantic import BaseModel, Field, field_validator
from datetime import datetime
import re


# ---- Nested schemas ----

class TechnicalSkillBlock(BaseModel):
    category: str = Field(..., min_length=1, max_length=100)
    skills: str = Field(..., max_length=2000)


def _empty_to_none(v: str | None) -> str | None:
    return None if (v is None or (isinstance(v, str) and not v.strip())) else v


class WorkExperienceBlock(BaseModel):
    company_name: str = Field(..., min_length=1, max_length=200)
    job_title: str = Field(..., min_length=1, max_length=200)
    period_start: str | None = Field(default=None, max_length=20)
    period_end: str | None = Field(default=None, max_length=20)
    location: str | None = Field(default=None, max_length=200)
    job_type: str | None = Field(default=None, max_length=20)  # onsite, hybrid, remote
    description: str | None = Field(default=None, max_length=12000)

    @field_validator("period_start", "period_end", "location", "job_type", "description", mode="before")
    @classmethod
    def empty_to_none(cls, v):
        return _empty_to_none(v)


class EducationBlock(BaseModel):
    university_name: str = Field(..., min_length=1, max_length=200)
    degree: str = Field(..., min_length=1, max_length=200)
    mark: str | None = Field(default=None, max_length=100)
    period_start: str | None = Field(default=None, max_length=20)
    period_end: str | None = Field(default=None, max_length=20)
    location: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("mark", "period_start", "period_end", "location", "description", mode="before")
    @classmethod
    def empty_to_none(cls, v):
        return _empty_to_none(v)


class CertificateBlock(BaseModel):
    name: str = Field(..., min_length=1, max_length=300)


class EEOPreferences(BaseModel):
    """Voluntary EEO / demographic answers. Strings empty -> None; yes/no fields
    are tri-state booleans (None = unspecified, engine uses its default)."""
    gender: str | None = Field(default=None, max_length=50)
    race: str | None = Field(default=None, max_length=100)
    hispanic_latino: bool | None = None
    veteran_status: bool | None = None
    disability_status: bool | None = None
    work_authorized: bool | None = None
    needs_sponsorship: bool | None = None

    @field_validator("gender", "race", mode="before")
    @classmethod
    def empty_to_none(cls, v):
        return _empty_to_none(v)


class AddressInfo(BaseModel):
    """Mailing address for application autofill (empty strings -> None)."""
    line1: str | None = Field(default=None, max_length=200)
    line2: str | None = Field(default=None, max_length=200)
    city: str | None = Field(default=None, max_length=120)
    state: str | None = Field(default=None, max_length=120)
    postal_code: str | None = Field(default=None, max_length=20)
    country: str | None = Field(default=None, max_length=120)

    @field_validator("line1", "line2", "city", "state", "postal_code", "country", mode="before")
    @classmethod
    def empty_to_none(cls, v):
        return _empty_to_none(v)


# ---- Validation helpers ----

def _email_valid(v: str) -> str:
    if not v or "@" not in v or "." not in v:
        raise ValueError("Invalid email format")
    return v.lower().strip()


def _linkedin_valid(v: str) -> str:
    v = (v or "").strip()
    if not v:
        raise ValueError("LinkedIn URL is required")
    if "linkedin.com/in/" not in v.lower():
        raise ValueError("Invalid LinkedIn URL (expected linkedin.com/in/...)")
    return v


def _github_valid(v: str | None) -> str | None:
    if not v or not v.strip():
        return None
    v = v.strip()
    if "github.com/" not in v.lower():
        raise ValueError("Invalid GitHub URL (expected github.com/...)")
    return v


def _phone_valid(v: str) -> str:
    v = (v or "").strip()
    if not v:
        raise ValueError("Phone number is required")
    if not re.match(r"^[\d\s\-+()]{7,25}$", v):
        raise ValueError("Invalid phone number format")
    return v


# ---- Request schemas ----

# ---- Resume import (loose extraction; validated again on profile save) ----


class ResumeSkillBlock(BaseModel):
    category: str | None = None
    skills: str | None = None


class ResumeWorkBlock(BaseModel):
    company_name: str | None = None
    job_title: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    location: str | None = None
    job_type: str | None = None
    description: str | None = None


class ResumeEducationBlock(BaseModel):
    university_name: str | None = None
    degree: str | None = None
    mark: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    location: str | None = None
    description: str | None = None


class ResumeCertBlock(BaseModel):
    name: str | None = None


class ResumeExtractedDraft(BaseModel):
    """Structured profile fields extracted from a résumé (all optional)."""

    name_first: str | None = None
    name_middle: str | None = None
    name_last: str | None = None
    title: str | None = None
    email: str | None = None
    phone_country_code: str | None = None
    phone_number: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    profile_summary: str | None = None
    technical_skills: list[ResumeSkillBlock] = Field(default_factory=list)
    work_experience: list[ResumeWorkBlock] = Field(default_factory=list)
    education: list[ResumeEducationBlock] = Field(default_factory=list)
    certificates: list[ResumeCertBlock] = Field(default_factory=list)
    extra: list[str] = Field(default_factory=list)


class ResumeParseResponse(BaseModel):
    draft: ResumeExtractedDraft
    source_kind: str
    warnings: list[str] = Field(default_factory=list)


class ProfileCreateRequest(BaseModel):
    name_first: str = Field(..., min_length=1, max_length=100)
    name_middle: str | None = Field(default=None, max_length=100)
    name_last: str = Field(..., min_length=1, max_length=100)
    title: str = Field(..., min_length=1, max_length=200)
    email: str = Field(..., min_length=5, max_length=255)
    phone_country_code: str = Field(..., min_length=1, max_length=10)
    phone_number: str = Field(..., min_length=7, max_length=30)
    linkedin_url: str = Field(..., min_length=10, max_length=500)
    github_url: str | None = Field(default=None, max_length=500)
    profile_summary: str = Field(..., min_length=1, max_length=5000)
    technical_skills: list[TechnicalSkillBlock] = Field(default_factory=list)
    work_experience: list[WorkExperienceBlock] = Field(default_factory=list)
    education: list[EducationBlock] = Field(default_factory=list)
    certificates: list[CertificateBlock] = Field(default_factory=list)
    extra: list[str] = Field(default_factory=list)
    eeo_preferences: EEOPreferences = Field(default_factory=EEOPreferences)
    address: AddressInfo = Field(default_factory=AddressInfo)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return _email_valid(v)

    @field_validator("linkedin_url")
    @classmethod
    def validate_linkedin(cls, v: str) -> str:
        return _linkedin_valid(v)

    @field_validator("github_url")
    @classmethod
    def validate_github(cls, v: str | None) -> str | None:
        return _github_valid(v)

    @field_validator("name_middle", mode="before")
    @classmethod
    def empty_middle_to_none(cls, v):
        return _empty_to_none(v)

    @field_validator("phone_number")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        return _phone_valid(v)


# Alias: single profile uses same schema for create/update
ProfileUpdateRequest = ProfileCreateRequest


# ---- Response schema (single profile per user) ----

class ProfileResponse(BaseModel):
    user_id: str
    name: str
    name_first: str | None = None
    name_middle: str | None = None
    name_last: str | None = None
    title: str | None = None
    email: str | None = None
    phone_country_code: str | None = None
    phone_number: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    profile_summary: str | None = None
    technical_skills: list[dict] = Field(default_factory=list)
    work_experience: list[dict] = Field(default_factory=list)
    education: list[dict] = Field(default_factory=list)
    certificates: list[dict] = Field(default_factory=list)
    extra: list[str] = Field(default_factory=list)
    eeo_preferences: dict = Field(default_factory=dict)
    address: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
