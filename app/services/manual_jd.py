"""Admin manual job-description paste for extraction-failed (or empty) jobs."""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import undefer

from app.core.logging import get_logger
from app.models.database import Job, JobExtraction, UserJobStatus
from app.services.job_exclusion_types import EXTRACTION_FAILED_EXCLUSION
from app.services.url_manager import URLManager
from app.storage.repository import JobExtractionRepository, _utcnow
from app.utils.text_sanitizer import sanitize_for_postgres_text

logger = get_logger(__name__)

MIN_MANUAL_JD_LENGTH = 10
MAX_MANUAL_JD_LENGTH = 500_000


async def ensure_job_extraction(session, job: Job) -> JobExtraction:
    """Attach a JobExtraction row if the job has none yet."""
    repo = JobExtractionRepository(session)
    if job.extraction_id:
        extraction = await repo.get_by_id(job.extraction_id)
        if extraction:
            return extraction

    source_url = (job.source_url or "").strip()
    if not source_url:
        raise ValueError("Job has no source URL to attach an extraction")

    is_valid, error = URLManager.validate_url(source_url)
    if not is_valid:
        raise ValueError(error or "Invalid source URL")

    domain = URLManager.extract_domain(source_url)
    normalized = (job.normalized_url or source_url).strip()
    extraction = await repo.create(
        source_url=source_url,
        normalized_url=normalized,
        domain=domain,
    )
    job.extraction_id = extraction.id
    await session.flush()
    return extraction


async def apply_manual_job_description(
    session,
    *,
    job: Job,
    plain_text: str,
    saved_by_user_id: str | None = None,
) -> JobExtraction:
    """
    Persist pasted JD as shared ``raw_plain_text``, mark extraction COMPLETED,
    restore the job to active inventory, and clear per-user extraction_failed hides.
    """
    cleaned = sanitize_for_postgres_text((plain_text or "").strip()) or ""
    if len(cleaned) < MIN_MANUAL_JD_LENGTH:
        raise ValueError(f"Job description must be at least {MIN_MANUAL_JD_LENGTH} characters")
    if len(cleaned) > MAX_MANUAL_JD_LENGTH:
        raise ValueError(f"Job description must be at most {MAX_MANUAL_JD_LENGTH} characters")

    extraction = await ensure_job_extraction(session, job)
    now = _utcnow()

    metadata = dict(extraction.raw_metadata or {})
    metadata.pop("ai_structured_source", None)
    metadata.pop("ai_structured_updated_at", None)
    metadata["manual_jd"] = True
    metadata["manual_jd_saved_at"] = now.isoformat()
    if saved_by_user_id:
        metadata["manual_jd_saved_by"] = saved_by_user_id

    repo = JobExtractionRepository(session)
    await repo.save_manual_raw_jd(extraction.id, cleaned, metadata=metadata)

    job.status = "active"
    job.scraped_at = now
    job.updated_at = now

    # Keep listing/snippet in sync when empty or shorter than the pasted JD.
    result = await session.execute(
        select(Job).options(undefer(Job.description)).where(Job.id == job.id)
    )
    job_row = result.scalar_one_or_none() or job
    old_desc = (getattr(job_row, "description", None) or "").strip()
    if not old_desc or len(cleaned) >= len(old_desc) or len(old_desc) < 300:
        job_row.description = cleaned

    await session.execute(
        delete(UserJobStatus).where(
            UserJobStatus.job_id == job.id,
            UserJobStatus.exclusion_type == EXTRACTION_FAILED_EXCLUSION,
        )
    )

    await session.flush()

    refreshed = await repo.get_by_id(extraction.id)
    logger.info(
        "manual_jd_saved",
        job_id=job.id,
        extraction_id=extraction.id,
        length=len(cleaned),
        saved_by=saved_by_user_id,
    )
    return refreshed or extraction
