from sqlalchemy import Column, String, Text, Date, DateTime, Float, Integer, Enum as SQLEnum, Index, JSON, Boolean, ForeignKey, LargeBinary, UniqueConstraint
from sqlalchemy.orm import declarative_base, deferred
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
    # Platform admin. Existing users are bootstrapped true via migration 048;
    # new signups default to false.
    is_admin = Column(Boolean, default=False, nullable=False, server_default="false", index=True)
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
    # Heavy profile payloads — deferred so auth/admin list queries stay light.
    # Accessing any of these columns loads that column on demand.
    profile_summary = deferred(Column(Text, nullable=True))
    technical_skills = deferred(Column(JSON, default=list))
    work_experience = deferred(Column(JSON, default=list))
    education = deferred(Column(JSON, default=list))
    certificates = deferred(Column(JSON, default=list))
    extra = deferred(Column(JSON, default=list))

    # Voluntary EEO / demographic answers used to auto-fill application forms
    # (Workday etc.). Object of: gender, race, sexual_orientation,
    # hispanic_latino, veteran_status, disability_status, work_authorized,
    # needs_sponsorship. Null/blank fields fall back to the engine's defaults.
    eeo_preferences = deferred(Column(JSON, default=dict))

    # Legal / home address for application autofill (Workday requires
    # Address/City/State/Postal), plus optional local_preferences (list of
    # preferred job locales). Object of: line1, line2, city, state,
    # postal_code, country, local_preferences.
    address = deferred(Column(JSON, default=dict))

    # Cached OpenAI-ready text (updated on profile save)
    profile_openai_cache = deferred(Column(Text, nullable=True))

    # Deduplication recycle window: jobs older than this many days are treated
    # as "fresh" at their company - a new posting won't be auto-excluded even
    # if the user already applied to an older posting there. Default 60 days.
    dedup_recycle_days = Column(Integer, default=60, nullable=False, server_default="60")
    dedup_recycle_mode = Column(String(20), default="default", nullable=False, server_default="default")

    # Optional dedup rules (platform default → user custom), same pattern as recycle days.
    dedup_applied_company_mode = Column(String(20), default="default", nullable=False, server_default="default")
    dedup_applied_company_enabled = Column(Boolean, default=False, nullable=False, server_default="false")
    dedup_score_comparison_mode = Column(String(20), default="default", nullable=False, server_default="default")
    dedup_score_comparison_enabled = Column(Boolean, default=False, nullable=False, server_default="false")

    # Auto-prepare: when platform JD is ready, enqueue personal match (and optionally full tailor).
    auto_prepare_match = Column(Boolean, default=False, nullable=False, server_default="false")
    auto_prepare_full = Column(Boolean, default=False, nullable=False, server_default="false")

    # Manual URL/paste submit depth: extract | match | full (default full).
    manual_submit_pipeline = Column(String(20), default="full", nullable=False, server_default="full")

    # OpenAI: "default" uses server OPENAI_API_KEY; "custom" uses encrypted user key.
    openai_key_mode = Column(String(20), default="default", nullable=False, server_default="default")
    openai_api_key_encrypted = deferred(Column(Text, nullable=True))

    # Active LLM provider powering this user's AI work ("openai" | "anthropic" | "gemini").
    llm_provider = Column(String(20), default="openai", nullable=False, server_default="openai")
    # Preferred model id for the OpenAI-compatible gateway (many models per key).
    # Null = fall back to admin job binding model, then system openai_model.
    llm_model = Column(String(200), nullable=True)

    # Anthropic / Gemini bring-your-own keys (mode "default" uses the server key;
    # "custom" uses the encrypted user-provided key). Mirrors the OpenAI pattern.
    anthropic_key_mode = Column(String(20), default="default", nullable=False, server_default="default")
    anthropic_api_key_encrypted = deferred(Column(Text, nullable=True))
    gemini_key_mode = Column(String(20), default="default", nullable=False, server_default="default")
    gemini_api_key_encrypted = deferred(Column(Text, nullable=True))

    # Minimum match score: jobs below threshold are hidden (below_min_score exclusion).
    min_match_score_mode = Column(String(20), default="default", nullable=False, server_default="default")
    min_match_score = Column(Integer, default=0, nullable=False, server_default="0")

    # Resume tailoring (Phase B): default uses built-in instructions; custom stores editable instructions.
    resume_tailoring_prompt_mode = Column(String(20), default="default", nullable=False, server_default="default")
    resume_tailoring_prompt_custom = deferred(Column(Text, nullable=True))

    # Cover letter generation (Phase B, Task 2): separate editable instructions from resume tailoring.
    cover_letter_prompt_mode = Column(String(20), default="default", nullable=False, server_default="default")
    cover_letter_prompt_custom = deferred(Column(Text, nullable=True))

    # Free-text job preferences used by the match analysis engine (Phase A).
    job_match_preferences = deferred(Column(Text, nullable=True))

    # Preferred job countries (ISO 3166-1 alpha-2 codes). Empty list = no
    # location filtering (worldwide). Source: 'unset' | 'auto' (resume parse
    # detection) | 'manual' (preferences page). Auto never overwrites manual.
    country_preferences = Column(JSON, default=list, nullable=False, server_default="[]")
    country_preferences_source = Column(
        String(20), default="unset", nullable=False, server_default="unset"
    )

    # Visual resume builder design (theme/typography/colors/layout). Every résumé is
    # compiled from this design; the working template + blueprint are derived from it.
    # These columns MIRROR the currently-active resume in the library (see
    # active_resume_id / ResumeDocument) so the extension, downloads and job-tailoring
    # keep reading one "current" working template.
    resume_template_status = Column(String(30), default="missing", nullable=False, server_default="missing")
    resume_template_working_path = deferred(Column(Text, nullable=True))
    resume_template_blueprint = deferred(Column(JSON, nullable=True))
    resume_template_error = Column(Text, nullable=True)
    resume_template_design = deferred(Column(JSON, nullable=True))

    # Multi-resume library: the resume currently loaded/edited in the builder. Points at
    # a resume_documents row; that row's design is mirrored into the columns above.
    active_resume_id = Column(
        String(36),
        ForeignKey("resume_documents.id", ondelete="SET NULL", name="fk_users_active_resume_id", use_alter=True),
        nullable=True,
    )

    # Per-user cover letter template, compiled from the resume builder design.
    cover_letter_template_status = Column(String(30), default="missing", nullable=False, server_default="missing")
    cover_letter_template_working_path = deferred(Column(Text, nullable=True))
    cover_letter_template_error = Column(Text, nullable=True)


class ResumeCustomTheme(Base):
    """A user-saved resume style theme (typography/colors/layout/sections snapshot)."""

    __tablename__ = "resume_custom_themes"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = Column(String(200), nullable=False)
    description = Column(String(500), nullable=False, default="Custom theme", server_default="Custom theme")
    accent_swatch = Column(String(32), nullable=False, default="#2563eb", server_default="#2563eb")
    design = Column(JSON, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)



class ResumeThemeLove(Base):
    """Per-user loved theme ids (built-in catalog ids or custom theme ids)."""

    __tablename__ = "resume_theme_loves"

    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    theme_id = Column(String(64), primary_key=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (Index("ix_resume_theme_loves_user_id", "user_id"),)


class ResumeDocument(Base):
    """A saved resume in the user's library (multi-resume support).

    Each row is one self-contained resume: a full ResumeDesign JSON (theme + content
    override) plus metadata. The user's active resume is mirrored into the
    users.resume_template_* columns so all existing consumers (extension, download,
    job-tailoring) keep working against a single "current" working template."""
    __tablename__ = "resume_documents"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = Column(String(200), nullable=False, default="Untitled resume")
    # "draft" | "completed" - user-controlled via a "Mark as complete" toggle.
    status = Column(String(20), nullable=False, default="draft", server_default="draft")
    # "manual" | "tailored" - how the resume was created.
    source = Column(String(20), nullable=False, default="manual", server_default="manual")
    # Full design JSON — deferred; search/metadata lists should not load it.
    design = deferred(Column(JSON, nullable=True))
    # For tailored resumes: the role this was tailored to (used for naming/labels).
    job_title = Column(String(300), nullable=True)
    company = Column(String(300), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)



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
    # Large blobs — deferred for metadata list endpoints.
    extracted_text = deferred(Column(Text, nullable=True))
    structured_data = deferred(Column(JSON, nullable=True))
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
    remote_policy = Column(String(500), nullable=True)
    work_mode = Column(String(20), nullable=True)
    experience_level = Column(String(500), nullable=True)
    industry = Column(String(200), nullable=True)
    raw_metadata = Column(JSON, default=dict)
    is_job_posting = Column(Boolean, nullable=True)
    # Large scrape text — only needed for Phase A/B job_text fallback.
    raw_plain_text = deferred(Column(Text, nullable=True))
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
    """Unified job table - every submitted/scraped job lives here exactly once."""
    __tablename__ = "jobs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_url = Column(Text, nullable=False)
    normalized_url = Column(String(2048), nullable=False, index=True)
    domain = Column(String(255), nullable=False, index=True)
    title = Column(String(500), nullable=True)
    company = Column(String(500), nullable=False)
    location = Column(String(500), nullable=True)
    work_mode = Column(String(20), nullable=True)
    # Large JD body — deferred so dashboard/list queries stay light.
    description = deferred(Column(Text, nullable=True))
    posted_date = Column(DateTime, nullable=True)
    experience_level = Column(String(100), nullable=True)
    industry = Column(String(200), nullable=True)
    raw_metadata = Column(JSON, default=dict)
    extraction_id = Column(String(36), nullable=True, index=True)
    scraped_at = Column(DateTime, nullable=True)
    sheet_posted_at = Column(DateTime, nullable=True)
    pumble_posted_at = Column(DateTime, nullable=True)
    status = Column(String(30), default="active", nullable=False, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_jobs_company", "company"),
        Index("ix_jobs_domain_company", "domain", "company"),
        Index("ix_jobs_created_at", "created_at"),
        Index("ix_jobs_work_mode", "work_mode"),
    )


class UserJobStatus(Base):
    """Per-user job status - tracks whether a job is active, duplicated, or
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


class JobEncoding(Base):
    """Once-per-job vector encoding + extracted signals for non-LLM matching.

    Vectors are float32 arrays stored as raw bytes (dimension defined by
    ``model_version``); cosine math runs in Python/numpy — no pgvector
    extension required on the database server.
    """
    __tablename__ = "job_encodings"

    job_id = Column(
        String(36), ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
    )
    model_version = Column(String(200), nullable=False)
    # Embedding of the job title (or best title guess).
    title_vec = deferred(Column(LargeBinary, nullable=True))
    # Embedding of the substantive JD body (description + requirements).
    content_vec = deferred(Column(LargeBinary, nullable=True))
    # {"skill": "required" | "preferred" | "mentioned", ...}
    skills = Column(JSON, default=dict, nullable=False)
    years_required = Column(Integer, nullable=True)
    degree_required = Column(Boolean, nullable=True)
    requires_security_clearance = Column(Boolean, default=False, nullable=False)
    encoded_at = Column(DateTime, server_default=func.now(), nullable=False)


class UserEncoding(Base):
    """Once-per-profile vector encoding, refreshed when the profile changes."""
    __tablename__ = "user_encodings"

    user_id = Column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    model_version = Column(String(200), nullable=False)
    # Embedding of the full experience narrative.
    experience_vec = deferred(Column(LargeBinary, nullable=True))
    # Embedding of job preferences + custom guidance (null when unset).
    prefs_vec = deferred(Column(LargeBinary, nullable=True))
    # [{"title": str, "vec": base64-float32}, ...] recent titles, newest first.
    title_vecs = Column(JSON, default=list, nullable=False)
    # {"skill": recency_weight 0..1, ...}
    skills = Column(JSON, default=dict, nullable=False)
    years_experience = Column(Float, nullable=True)
    has_degree = Column(Boolean, nullable=True)
    # Hash of the encoded inputs; unchanged profiles are never re-encoded.
    profile_hash = Column(String(64), nullable=True)
    encoded_at = Column(DateTime, server_default=func.now(), nullable=False)


class UserJobSource(Base):
    """A job board (Greenhouse/Lever/Ashby/Workable) a user registered.

    Synced periodically: new postings on the board are pulled into the user's
    pipeline via the normal submit/extract flow.
    """
    __tablename__ = "user_job_sources"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    url = Column(Text, nullable=False)
    name = Column(String(200), nullable=False)
    ats_type = Column(String(30), nullable=False)  # greenhouse | lever | ashby | workable
    board_token = Column(String(200), nullable=False)
    enabled = Column(Boolean, default=True, nullable=False, server_default="true")
    last_synced_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    # Postings seen on the board during the last sync.
    last_listing_count = Column(Integer, nullable=True)
    # New jobs created for this user during the last sync.
    last_new_jobs = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "ats_type", "board_token", name="uq_user_job_source_board"),
    )


class MatchEngineComparison(Base):
    """Shadow-mode record: LLM score vs vector score for the same user x job."""
    __tablename__ = "match_engine_comparisons"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id = Column(String(36), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    llm_overall = Column(Integer, nullable=False)
    vector_overall = Column(Integer, nullable=False)
    llm_dimensions = Column(JSON, default=dict, nullable=False)
    vector_dimensions = Column(JSON, default=dict, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_match_engine_comparisons_created_at", "created_at"),
    )


class SystemLogEvent(Base):
    """Persisted structured log for the admin logs dashboard.

    Fed by the structlog sink — HTTP req/res lifecycle, worker tasks, and
    process events share one table keyed by request_id for timelines.
    """
    __tablename__ = "system_log_events"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    created_at = Column(DateTime, server_default=func.now(), nullable=False, index=True)
    level = Column(String(20), nullable=False, index=True)
    event = Column(String(200), nullable=False)
    logger_name = Column(String(200), nullable=True)
    # http | worker | process | system
    category = Column(String(40), nullable=False, default="process", server_default="process", index=True)
    # api | extraction | analysis | tailoring | save | resume | autopost | scraper | encoding
    service = Column(String(40), nullable=False, default="api", server_default="api")
    request_id = Column(String(64), nullable=True, index=True)
    user_id = Column(String(36), nullable=True)
    job_id = Column(String(36), nullable=True)
    extraction_id = Column(String(36), nullable=True)
    worker_job_type = Column(String(80), nullable=True)
    method = Column(String(16), nullable=True)
    path = Column(String(500), nullable=True, index=True)
    status_code = Column(Integer, nullable=True)
    duration_ms = Column(Float, nullable=True)
    client_ip = Column(String(64), nullable=True)
    message = Column(Text, nullable=True)
    payload = Column(JSON, nullable=True)

    __table_args__ = (
        Index("ix_system_log_events_level_created", "level", "created_at"),
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


class PumbleConfig(Base):
    """Per-user Pumble destination. Users may connect multiple workspaces/channels.

    Jobs are posted as thread replies under a daily parent message in the
    configured channel. parent_message_id + parent_posted_date track the
    current day's thread root per destination.
    """
    __tablename__ = "pumble_config"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(255), nullable=True)
    api_key_encrypted = Column(Text, nullable=False)
    workspace_id = Column(String(255), nullable=True)
    channel_id = Column(String(255), nullable=False)
    channel_name = Column(String(255), nullable=False)
    parent_message_id = Column(String(255), nullable=True)
    parent_posted_date = Column(Date, nullable=True)
    is_enabled = Column(Boolean, default=True, nullable=False)
    auto_post_threshold = Column(Integer, default=75)
    # Auto-post filters JSON: work_modes[], exclude_companies[].
    auto_post_filters = Column(JSON, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "channel_id", name="uq_pumble_config_user_channel"),
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
    # Soft toggle: disable auto-post without deleting spreadsheet URL / tab groups.
    is_enabled = Column(Boolean, default=True, nullable=False)
    # Auto-post filters JSON: work_modes[], exclude_companies[].
    auto_post_filters = Column(JSON, nullable=True)
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


class SystemSetting(Base):
    """DB overrides for allowlisted Settings fields (admin System Settings)."""

    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    updated_by_user_id = Column(String(36), nullable=True)


class BlockedDomain(Base):
    """Domains that reject auto job extraction (admin-managed)."""

    __tablename__ = "blocked_domains"

    domain = Column(String(255), primary_key=True)
    reason = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class LlmProviderKey(Base):
    """Admin-managed API key pool entry for a single LLM provider."""

    __tablename__ = "llm_provider_keys"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider = Column(String(20), nullable=False, index=True)  # openai | anthropic | gemini
    label = Column(String(100), nullable=False)
    api_key_encrypted = Column(Text, nullable=False)
    key_hint = Column(String(32), nullable=True)
    is_enabled = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    created_by_user_id = Column(String(36), nullable=True)

    __table_args__ = (
        Index("ix_llm_provider_keys_provider_label", "provider", "label", unique=True),
    )


class LlmJobBinding(Base):
    """Maps a platform LLM job type to a provider key and optional model id.

    ``model`` is especially important for OpenAI-compatible gateways where one
    API key can access many models (discovered via GET /v1/models).
    """

    __tablename__ = "llm_job_bindings"

    job_type = Column(String(50), primary_key=True)
    provider_key_id = Column(
        String(36),
        ForeignKey("llm_provider_keys.id", ondelete="SET NULL"),
        nullable=True,
    )
    provider = Column(String(20), nullable=True)  # optional provider override
    model = Column(String(200), nullable=True)  # optional model id for the bound provider
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    updated_by_user_id = Column(String(36), nullable=True)
