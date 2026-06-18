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

    # Deduplication recycle window: jobs older than this many days are treated
    # as "fresh" at their company — a new posting won't be auto-excluded even
    # if the user already applied to an older posting there. Default 60 days.
    dedup_recycle_days = Column(Integer, default=60, nullable=False, server_default="60")
    dedup_recycle_mode = Column(String(20), default="default", nullable=False, server_default="default")

    # OpenAI: "default" uses server OPENAI_API_KEY; "custom" uses encrypted user key.
    openai_key_mode = Column(String(20), default="default", nullable=False, server_default="default")
    openai_api_key_encrypted = Column(Text, nullable=True)

    # Active LLM provider powering this user's AI work ("openai" | "anthropic" | "gemini").
    llm_provider = Column(String(20), default="openai", nullable=False, server_default="openai")

    # Anthropic / Gemini bring-your-own keys (mode "default" uses the server key;
    # "custom" uses the encrypted user-provided key). Mirrors the OpenAI pattern.
    anthropic_key_mode = Column(String(20), default="default", nullable=False, server_default="default")
    anthropic_api_key_encrypted = Column(Text, nullable=True)
    gemini_key_mode = Column(String(20), default="default", nullable=False, server_default="default")
    gemini_api_key_encrypted = Column(Text, nullable=True)

    # Minimum match score: jobs below threshold are hidden (below_min_score exclusion).
    min_match_score_mode = Column(String(20), default="default", nullable=False, server_default="default")
    min_match_score = Column(Integer, default=0, nullable=False, server_default="0")

    # Resume tailoring (Phase B): default uses built-in instructions; custom stores editable instructions.
    resume_tailoring_prompt_mode = Column(String(20), default="default", nullable=False, server_default="default")
    resume_tailoring_prompt_custom = Column(Text, nullable=True)

    # Cover letter generation (Phase B, Task 2): separate editable instructions from resume tailoring.
    cover_letter_prompt_mode = Column(String(20), default="default", nullable=False, server_default="default")
    cover_letter_prompt_custom = Column(Text, nullable=True)

    # Per-user resume DOCX template (blueprint-driven document generation).
    resume_template_status = Column(String(30), default="missing", nullable=False, server_default="missing")
    resume_template_source_path = Column(Text, nullable=True)
    resume_template_working_path = Column(Text, nullable=True)
    resume_template_blueprint = Column(JSON, nullable=True)
    resume_template_error = Column(Text, nullable=True)
    resume_template_source_filename = Column(String(500), nullable=True)
    resume_template_profile_work_count = Column(Integer, nullable=True)
    resume_template_analyzed_at = Column(DateTime, nullable=True)

    # Per-user cover letter DOCX template (placeholder-driven document generation).
    cover_letter_template_status = Column(String(30), default="missing", nullable=False, server_default="missing")
    cover_letter_template_source_path = Column(Text, nullable=True)
    cover_letter_template_working_path = Column(Text, nullable=True)
    cover_letter_template_source_filename = Column(String(500), nullable=True)
    cover_letter_template_error = Column(Text, nullable=True)
    cover_letter_template_detected_tags = Column(JSON, nullable=True)
    cover_letter_template_analyzed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_users_email", "email"),
        Index("ix_users_is_active", "is_active"),
    )


class ProfileSourceDocument(Base):
    """Per-user project source documents for resume tailoring (C: structured on upload)."""
    __tablename__ = "profile_source_documents"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    filename = Column(String(500), nullable=False)
    source_kind = Column(String(20), nullable=False)
    company_name = Column(String(200), nullable=True)
    extracted_text = Column(Text, nullable=True)
    structured_data = Column(JSON, nullable=True)
    char_count = Column(Integer, default=0, nullable=False, server_default="0")
    project_count = Column(Integer, default=0, nullable=False, server_default="0")
    parse_status = Column(String(20), default="pending", nullable=False, server_default="pending")
    parse_error = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_psd_user_parse_status", "user_id", "parse_status"),
    )


class JobExtraction(Base):
    __tablename__ = "job_extractions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_url = Column(Text, nullable=False)
    normalized_url = Column(String(2048), nullable=False, index=True)
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
    is_job_posting = Column(Boolean, nullable=True)
    raw_plain_text = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    completed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_job_extractions_status", "status"),
        Index("ix_job_extractions_created_at", "created_at"),
        Index("ix_job_extractions_domain_status", "domain", "status"),
    )


class Job(Base):
    """Unified job table — every submitted/scraped job lives here exactly once."""
    __tablename__ = "jobs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_url = Column(Text, nullable=False)
    normalized_url = Column(String(2048), nullable=False, index=True)
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
    sheet_posted_at = Column(DateTime, nullable=True)
    status = Column(String(30), default="active", nullable=False, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_jobs_company", "company"),
        Index("ix_jobs_domain_company", "domain", "company"),
        Index("ix_jobs_created_at", "created_at"),
    )


class UserJobStatus(Base):
    """Per-user job status — tracks whether a job is active, duplicated, or
    hidden for a specific user.  Replaces the old user_job_exclusions,
    user_dismissed_duplicates, and per-user aspects of invalid_jobs.
    """
    __tablename__ = "user_job_status"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    job_id = Column(
        String(36),
        ForeignKey("jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status = Column(String(30), nullable=False)
    duplicated_because_id = Column(
        String(36),
        ForeignKey("jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    exclusion_type = Column(String(50), nullable=True)
    reason = Column(Text, nullable=True)
    match_score_at_decision = Column(Float, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_user_job_status"),
        Index("ix_ujs_user_id", "user_id"),
        Index("ix_ujs_job_id", "job_id"),
        Index("ix_ujs_user_status", "user_id", "status"),
    )


class JobMatchResult(Base):
    """Cached AI job-profile match analysis result."""
    __tablename__ = "job_match_results"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    overall_score = Column(Integer, nullable=False)
    dimension_scores = Column(JSON, nullable=False)
    summary = Column(Text, nullable=True)
    strengths = Column(JSON, default=list, nullable=False)
    gaps = Column(JSON, default=list, nullable=False)
    recommendation = Column(String(50), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("job_id", "user_id", name="uq_job_match_job_user"),
    )


class JobMatchInProgress(Base):
    """Tracks in-progress AI job match analysis for real-time UI status."""
    __tablename__ = "job_match_in_progress"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("job_id", "user_id", name="uq_job_match_progress_job_user"),
    )


class ValidJobUserApplication(Base):
    """Per-user mark that the user applied to this job posting (UI + persistence)."""
    __tablename__ = "valid_job_user_applications"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    applied_at = Column(DateTime, server_default=func.now(), nullable=False)
    applied_by_name = Column(String(300), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_job_user_application"),
    )


class ResumeBuildResult(Base):
    """Tracks per-job tailored resume & cover letter document generation."""
    __tablename__ = "resume_build_results"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    resume_docx_status = Column(String(20), default="pending", nullable=False)
    resume_pdf_status = Column(String(20), default="pending", nullable=False)
    cover_letter_docx_status = Column(String(20), default="pending", nullable=False)
    cover_letter_pdf_status = Column(String(20), default="pending", nullable=False)

    resume_docx_path = Column(Text, nullable=True)
    resume_pdf_path = Column(Text, nullable=True)
    cover_letter_docx_path = Column(Text, nullable=True)
    cover_letter_pdf_path = Column(Text, nullable=True)

    tailored_resume_data = Column(JSON, nullable=True)
    cover_letter_data = Column(JSON, nullable=True)

    content_generation_status = Column(String(20), default="pending", nullable=False)
    content_generation_error = Column(Text, nullable=True)

    output_directory = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("job_id", "user_id", name="uq_resume_build_job_user"),
    )


class GoogleSheetsConfig(Base):
    """Per-user Google Sheets integration settings.

    tab_groups stores a list of groups, where each group is a list of tab names.
    E.g. [["CHELL", "Victor"], ["Adekunle", "Elsie"]]
    Jobs round-robin between groups; all tabs in a group receive the same URL.
    """
    __tablename__ = "google_sheets_config"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    spreadsheet_url = Column(Text, nullable=False)
    spreadsheet_id = Column(String(255), nullable=False)
    tab_groups = Column(JSON, default=list)
    round_robin_index = Column(Integer, default=0)
    auto_post_threshold = Column(Integer, default=75)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class ApplicationSession(Base):
    """Per-user in-progress job application worked on through the assistant
    extension. Holds a snapshot of the structured job description so the
    extension can keep working (and chatting) about a job until the user
    completes or removes it. One session per (user, job).
    """
    __tablename__ = "application_sessions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    # "in_progress" while the user is applying; "completed" once they finish.
    status = Column(String(20), default="in_progress", nullable=False, server_default="in_progress")
    # Snapshot of the structured JD (title/company/responsibilities/...) at the
    # time the session started, so it stays stable for the duration of applying.
    job_snapshot = Column(JSON, nullable=True)
    job_url = Column(Text, nullable=True)
    job_title = Column(String(500), nullable=True)
    company = Column(String(500), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_application_session_user_job"),
        Index("ix_application_sessions_user_status", "user_id", "status"),
    )


class AssistantMessage(Base):
    """A single turn in the job-specific assistant conversation. The
    conversation is identified by (user_id, job_id); messages are ordered by
    created_at. Persisted so reopening a job restores the chat.
    """
    __tablename__ = "assistant_messages"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False)  # "user" | "assistant"
    content = Column(Text, nullable=False)
    # Optional answer-style metadata used to render the question that produced
    # this answer (e.g. {"style": "concise", "field_type": "textarea"}).
    meta = Column(JSON, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_assistant_messages_user_job", "user_id", "job_id", "created_at"),
    )


class APIPatternRegistry(Base):
    __tablename__ = "api_pattern_registry"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    domain_pattern = Column(String(255), nullable=False, unique=True)
    api_endpoint_template = Column(Text, nullable=True)
    json_ld_selector = Column(String(255), nullable=True)
    extraction_hints = Column(JSON, default=dict)
    priority = Column(Float, default=0)
    is_active = Column(Boolean, default=True)
    success_rate = Column(Float, default=0.0)
    last_success_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
