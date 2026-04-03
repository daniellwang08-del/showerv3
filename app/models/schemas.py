from pydantic import BaseModel, Field, HttpUrl, ValidationInfo, field_validator
from datetime import datetime
from enum import Enum
from typing import Any


def _truncate_optional_job_field(v: Any, max_len: int) -> str | None:
    """Coerce to str, strip, empty -> None; truncate to max_len (matches DB VARCHAR limits on save)."""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    return s[:max_len] if len(s) > max_len else s


def _truncate_required_job_field(v: Any, max_len: int) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    return s[:max_len] if len(s) > max_len else s


class ExtractionMethod(str, Enum):
    API_JSON_LD = "api_json_ld"
    API_VENDOR = "api_vendor"
    STATIC_HTML = "static_html"
    BROWSER_RENDER = "browser_render"


class ExtractionStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    EXTRACTED = "extracted"
    COMPLETED = "completed"
    FAILED = "failed"


class JobDescriptionSchema(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    company: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=500)
    # Align with job_extractions.employment_type String(500)
    employment_type: str | None = Field(default=None, max_length=500)
    salary_range: str | None = Field(default=None, max_length=200)
    description: str = Field(..., min_length=10)
    responsibilities: list[str] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    benefits: list[str] = Field(default_factory=list)
    posted_date: datetime | None = None
    application_deadline: datetime | None = None
    remote_policy: str | None = Field(default=None, max_length=500)
    experience_level: str | None = Field(default=None, max_length=500)
    industry: str | None = Field(default=None, max_length=200)
    raw_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("title", mode="before")
    @classmethod
    def truncate_title(cls, v: Any) -> str:
        return _truncate_required_job_field(v, 500)

    @field_validator(
        "company",
        "location",
        "employment_type",
        "salary_range",
        "remote_policy",
        "experience_level",
        "industry",
        mode="before",
    )
    @classmethod
    def truncate_bounded_optional_strings(cls, v: Any, info: ValidationInfo) -> str | None:
        limits: dict[str, int] = {
            "company": 500,
            "location": 500,
            "employment_type": 500,
            "salary_range": 200,
            "remote_policy": 500,
            "experience_level": 500,
            "industry": 200,
        }
        field_name = info.field_name
        if field_name not in limits:
            return v
        return _truncate_optional_job_field(v, limits[field_name])


class ExtractionRequest(BaseModel):
    url: HttpUrl
    force_refresh: bool = False
    preferred_method: ExtractionMethod | None = None

    @field_validator("url", mode="before")
    @classmethod
    def validate_url(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
        return v


class ExtractionResponse(BaseModel):
    job_id: str
    status: ExtractionStatus
    source_url: str
    normalized_url: str
    extraction_method: ExtractionMethod | None = None
    job_data: JobDescriptionSchema | None = None
    created_at: datetime
    completed_at: datetime | None = None
    error_message: str | None = None
    is_job_posting: bool | None = None


class BatchExtractionRequest(BaseModel):
    urls: list[HttpUrl] = Field(..., min_length=1, max_length=100)
    force_refresh: bool = False


class BatchExtractionResponse(BaseModel):
    batch_id: str
    total_urls: int
    accepted_urls: int
    duplicate_urls: int
    job_ids: list[str]


class HealthResponse(BaseModel):
    status: str
    version: str
    database_connected: bool
    redis_connected: bool
    browser_pool_available: int


class JobSubmissionRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)
    title: str | None = Field(default=None, max_length=500)
    company: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=10000)
    posted_date: datetime | None = None
    experience_level: str | None = None
    industry: str | None = None


class JobSearchQuerySpec(BaseModel):
    """
    Structured job search criteria produced by OpenAI from natural language.
    Applied server-side against valid_jobs + job_extractions + match scores.
    """

    rationale: str | None = Field(default=None, description="Short explanation of how the query was interpreted")
    must_contain_all: list[str] = Field(default_factory=list)
    must_contain_any: list[str] = Field(default_factory=list)
    must_not_contain: list[str] = Field(default_factory=list)
    title_contains_any: list[str] = Field(default_factory=list)
    company_contains_any: list[str] = Field(default_factory=list)
    location_contains_any: list[str] = Field(default_factory=list)
    domain_contains_any: list[str] = Field(default_factory=list)
    experience_level_any: list[str] = Field(default_factory=list)
    industry_any: list[str] = Field(default_factory=list)
    remote_policy_any: list[str] = Field(default_factory=list)
    salary_contains_any: list[str] = Field(default_factory=list)
    recommendation_any: list[str] = Field(default_factory=list)
    min_match_score: int | None = Field(default=None, ge=0, le=100)
    max_match_score: int | None = Field(default=None, ge=0, le=100)
    match_only_analyzed: bool = Field(default=False)
    extraction_completed_only: bool = Field(default=False)
    applied_status: str | None = Field(default=None, description="'applied', 'not_applied', or null")


class AiJobSearchRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)


class AiJobSearchResponse(BaseModel):
    matching_jobs: list[dict]
    query: JobSearchQuerySpec
    total_matching: int


class ValidJobResponse(BaseModel):
    id: str
    source_url: str
    normalized_url: str
    domain: str
    title: str | None
    company: str
    location: str | None
    description: str | None
    posted_date: datetime | None
    experience_level: str | None
    industry: str | None
    similarity_hash: str | None
    scraped_at: datetime | None = None
    extraction_id: str | None = None
    extraction_status: str | None = None
    is_job_posting: bool | None = None
    match_overall_score: int | None = None
    match_status: str | None = None
    click_count: int = 0
    applied_at: datetime | None = None
    applied_by_name: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ValidJobIdsBatchRequest(BaseModel):
    valid_job_ids: list[str] = Field(..., min_length=1, max_length=200)


class JobMatchResponse(BaseModel):
    valid_job_id: str
    overall_score: int
    dimension_scores: dict
    summary: str
    strengths: list[str]
    gaps: list[str]
    recommendation: str
    created_at: datetime | None = None


class JobPromotionInfo(BaseModel):
    """User promotion from duplicates → valid (reason + who + when)."""

    reason: str
    promoted_by: str
    promoted_at: str | None = None


class JobAnalysisResponse(BaseModel):
    """
    Unified payload for the job analysis panel: scraped/structured posting + optional match result.
    """

    valid_job_id: str
    extraction_id: str | None
    extraction_status: ExtractionStatus | None
    source_url: str
    job_data: JobDescriptionSchema | None = None
    extraction_method: ExtractionMethod | None = None
    is_job_posting: bool | None = None
    content_enriched_by_ai: bool = False
    match: JobMatchResponse | None = None
    match_in_progress: bool = False
    promotion: JobPromotionInfo | None = None


class InvalidJobResponse(BaseModel):
    id: str
    source_url: str
    normalized_url: str
    domain: str
    title: str | None
    company: str
    location: str | None
    description: str | None
    posted_date: datetime | None
    experience_level: str | None
    industry: str | None
    duplicate_of_job_id: str | None
    duplication_reason: str | None
    similarity_score: float | None
    similarity_hash: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class JobSubmissionResponse(BaseModel):
    success: bool
    job_id: str | None
    is_duplicate: bool
    duplicate_job_id: str | None
    message: str


class AttachmentExtractUrlsResponse(BaseModel):
    """OpenAI-filtered job URLs extracted from uploaded documents."""

    urls: list[str]
    files_processed: int
    warnings: list[str] = Field(default_factory=list)
