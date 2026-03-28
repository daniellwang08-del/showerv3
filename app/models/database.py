from sqlalchemy import Column, String, Text, DateTime, Float, Integer, Enum as SQLEnum, Index, JSON, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import declarative_base
from sqlalchemy.sql import func
from app.models.schemas import ExtractionMethod, ExtractionStatus
import uuid

Base = declarative_base()


class User(Base):
    """User account with single profile (one profile per account)."""
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String(255), nullable=False, unique=True, index=True)
    name = Column(String(100), nullable=True)  # Display name (header)
    password_hash = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Profile fields (one profile per user)
    name_first = Column(String(100), nullable=True)
    name_middle = Column(String(100), nullable=True)
    name_last = Column(String(100), nullable=True)
    profile_title = Column(String(200), nullable=True)
    profile_email = Column(String(255), nullable=True)
    phone_country_code = Column(String(10), nullable=True)
    phone_number = Column(String(30), nullable=True)
    linkedin_url = Column(String(500), nullable=True)
    github_url = Column(String(500), nullable=True)
    profile_summary = Column(Text, nullable=True)
    technical_skills = Column(JSON, default=list)
    work_experience = Column(JSON, default=list)
    education = Column(JSON, default=list)
    certificates = Column(JSON, default=list)
    extra = Column(JSON, default=list)

    # Cached OpenAI-ready text (updated on profile save)
    profile_openai_cache = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_users_email", "email"),
        Index("ix_users_is_active", "is_active"),
    )


class JobExtraction(Base):
    __tablename__ = "job_extractions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_url = Column(Text, nullable=False)
    normalized_url = Column(String(2048), nullable=False, unique=True)
    domain = Column(String(255), nullable=False, index=True)
    status = Column(SQLEnum(ExtractionStatus), default=ExtractionStatus.PENDING, nullable=False)
    extraction_method = Column(SQLEnum(ExtractionMethod), nullable=True)
    title = Column(String(500), nullable=True)
    company = Column(String(500), nullable=True)
    location = Column(String(500), nullable=True)
    employment_type = Column(String(500), nullable=True)
    salary_range = Column(String(200), nullable=True)
    description = Column(Text, nullable=True)
    responsibilities = Column(JSON, default=list)
    requirements = Column(JSON, default=list)
    benefits = Column(JSON, default=list)
    posted_date = Column(DateTime, nullable=True)
    application_deadline = Column(DateTime, nullable=True)
    remote_policy = Column(String(500), nullable=True)
    experience_level = Column(String(500), nullable=True)
    industry = Column(String(200), nullable=True)
    raw_metadata = Column(JSON, default=dict)
    raw_html = Column(Text, nullable=True)
    confidence_score = Column(Float, nullable=True)
    error_message = Column(Text, nullable=True)
    retry_count = Column(Float, default=0)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    completed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_job_extractions_status", "status"),
        Index("ix_job_extractions_created_at", "created_at"),
        Index("ix_job_extractions_domain_status", "domain", "status"),
    )


class ValidJob(Base):
    __tablename__ = "valid_jobs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_url = Column(Text, nullable=False, unique=True)
    normalized_url = Column(String(2048), nullable=False, unique=True)
    domain = Column(String(255), nullable=False, index=True)
    title = Column(String(500), nullable=True)
    company = Column(String(500), nullable=False)
    location = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    posted_date = Column(DateTime, nullable=True)
    experience_level = Column(String(100), nullable=True)
    industry = Column(String(200), nullable=True)
    raw_metadata = Column(JSON, default=dict)
    similarity_hash = Column(String(64), nullable=True, index=True)
    extraction_id = Column(String(36), nullable=True, index=True)
    scraped_at = Column(DateTime, nullable=True)
    click_count = Column(Integer, default=0, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_valid_jobs_company", "company"),
        Index("ix_valid_jobs_domain_company", "domain", "company"),
        Index("ix_valid_jobs_created_at", "created_at"),
    )


class InvalidJob(Base):
    __tablename__ = "invalid_jobs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_url = Column(Text, nullable=False, unique=True)
    normalized_url = Column(String(2048), nullable=False, unique=True)
    domain = Column(String(255), nullable=False, index=True)
    title = Column(String(500), nullable=True)
    company = Column(String(500), nullable=False)
    location = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    posted_date = Column(DateTime, nullable=True)
    experience_level = Column(String(100), nullable=True)
    industry = Column(String(200), nullable=True)
    raw_metadata = Column(JSON, default=dict)
    duplicate_of_job_id = Column(String(36), nullable=True, index=True)
    duplication_reason = Column(String(500), nullable=True)
    similarity_score = Column(Float, nullable=True)
    similarity_hash = Column(String(64), nullable=True, index=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_invalid_jobs_company", "company"),
        Index("ix_invalid_jobs_domain_company", "domain", "company"),
        Index("ix_invalid_jobs_duplicate_of", "duplicate_of_job_id"),
        Index("ix_invalid_jobs_created_at", "created_at"),
    )


class JobMatchResult(Base):
    """Cached AI job–profile match analysis result."""
    __tablename__ = "job_match_results"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    valid_job_id = Column(String(36), ForeignKey("valid_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    overall_score = Column(Integer, nullable=False)
    dimension_scores = Column(JSON, nullable=False)
    summary = Column(Text, nullable=True)
    strengths = Column(JSON, default=list, nullable=False)
    gaps = Column(JSON, default=list, nullable=False)
    recommendation = Column(String(50), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("valid_job_id", "user_id", name="uq_job_match_valid_job_user"),
    )


class JobMatchInProgress(Base):
    """Tracks in-progress AI job match analysis for real-time UI status."""
    __tablename__ = "job_match_in_progress"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    valid_job_id = Column(String(36), ForeignKey("valid_jobs.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("valid_job_id", "user_id", name="uq_job_match_progress_valid_job_user"),
    )


class ValidJobUserApplication(Base):
    """Per-user mark that the user applied to this valid job posting (UI + persistence)."""
    __tablename__ = "valid_job_user_applications"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    valid_job_id = Column(String(36), ForeignKey("valid_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    applied_at = Column(DateTime, server_default=func.now(), nullable=False)
    applied_by_name = Column(String(300), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "valid_job_id", name="uq_valid_job_user_application"),
        Index("ix_valid_job_user_applications_user_valid", "user_id", "valid_job_id"),
    )


class APIPatternRegistry(Base):
    __tablename__ = "api_pattern_registry"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    domain_pattern = Column(String(255), nullable=False, unique=True)
    api_endpoint_template = Column(Text, nullable=True)
    json_ld_selector = Column(String(255), nullable=True)
    extraction_hints = Column(JSON, default=dict)
    priority = Column(Float, default=0)
    is_active = Column(Float, default=1)
    success_rate = Column(Float, default=0.0)
    last_success_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
