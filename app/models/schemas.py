from pydantic import BaseModel, Field, HttpUrl, field_validator
from datetime import datetime
from enum import Enum
from typing import Any


class ExtractionMethod(str, Enum):
    API_JSON_LD = "api_json_ld"
    API_VENDOR = "api_vendor"
    STATIC_HTML = "static_html"
    BROWSER_RENDER = "browser_render"


class ExtractionStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class JobDescriptionSchema(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    company: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=500)
    employment_type: str | None = Field(default=None, max_length=100)
    salary_range: str | None = Field(default=None, max_length=200)
    description: str = Field(..., min_length=10)
    responsibilities: list[str] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    benefits: list[str] = Field(default_factory=list)
    posted_date: datetime | None = None
    application_deadline: datetime | None = None
    remote_policy: str | None = None
    experience_level: str | None = None
    industry: str | None = None
    raw_metadata: dict[str, Any] = Field(default_factory=dict)


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
    confidence_score: float | None = None


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
    match_overall_score: int | None = None
    match_status: str | None = None
    click_count: int = 0
    is_active: bool
    created_at: datetime
    updated_at: datetime


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
    confidence_score: float | None = None
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
