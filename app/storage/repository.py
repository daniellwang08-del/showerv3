import uuid

from sqlalchemy import select, update, and_, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database import (
    JobExtraction,
    APIPatternRegistry,
    ValidJob,
    JobMatchResult,
    JobMatchInProgress,
    ValidJobUserApplication,
    ResumeBuildResult,
)
from app.models.schemas import ExtractionStatus, ExtractionMethod, JobDescriptionSchema
from app.core.logging import get_logger
from app.utils.text_sanitizer import sanitize_for_postgres_text
from datetime import datetime, timezone
from typing import Sequence

logger = get_logger(__name__)


def _utcnow() -> datetime:
    """Naive UTC datetime compatible with TIMESTAMP WITHOUT TIME ZONE columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

# Max lengths for job_extractions VARCHAR columns (must match database schema)
_JOB_EXTRACTION_LIMITS = {
    "title": 500,
    "company": 500,
    "location": 500,
    "employment_type": 500,
    "salary_range": 200,
    "remote_policy": 500,
    "experience_level": 500,
    "industry": 200,
}


def _truncate_for_db(value: str | None, max_len: int) -> str | None:
    """Truncate string to fit DB column; return None for empty."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    return s[:max_len] if len(s) > max_len else s


class JobExtractionRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        source_url: str,
        normalized_url: str,
        domain: str,
    ) -> JobExtraction:
        extraction = JobExtraction(
            source_url=source_url,
            normalized_url=normalized_url,
            domain=domain,
            status=ExtractionStatus.PENDING,
        )
        self._session.add(extraction)
        await self._session.flush()
        return extraction

    async def reset_for_refresh(self, job_id: str, source_url: str, domain: str) -> None:
        values = {
            "source_url": source_url,
            "domain": domain,
            "status": ExtractionStatus.PENDING,
            "extraction_method": None,
            "title": None,
            "company": None,
            "location": None,
            "employment_type": None,
            "salary_range": None,
            "description": None,
            "responsibilities": [],
            "requirements": [],
            "benefits": [],
            "posted_date": None,
            "application_deadline": None,
            "remote_policy": None,
            "experience_level": None,
            "industry": None,
            "raw_metadata": {},
            "raw_html": None,
            "is_job_posting": None,
            "error_message": None,
            "completed_at": None,
            "updated_at": _utcnow(),
        }

        await self._session.execute(
            update(JobExtraction).where(JobExtraction.id == job_id).values(**values)
        )
        logger.debug("repository_reset_for_refresh", job_id=job_id)

    async def get_by_id(self, job_id: str) -> JobExtraction | None:
        result = await self._session.execute(
            select(JobExtraction).where(JobExtraction.id == job_id)
        )
        return result.scalar_one_or_none()

    async def update_status(
        self,
        job_id: str,
        status: ExtractionStatus,
        error_message: str | None = None,
    ) -> None:
        values = {"status": status, "updated_at": _utcnow()}
        if error_message:
            values["error_message"] = sanitize_for_postgres_text(error_message)
        if status == ExtractionStatus.COMPLETED:
            values["completed_at"] = _utcnow()

        await self._session.execute(
            update(JobExtraction).where(JobExtraction.id == job_id).values(**values)
        )
        logger.debug("repository_update_status", job_id=job_id, status=status.value)

    async def update_extraction_method(
        self,
        job_id: str,
        method: ExtractionMethod,
    ) -> None:
        await self._session.execute(
            update(JobExtraction)
            .where(JobExtraction.id == job_id)
            .values(extraction_method=method, updated_at=_utcnow())
        )

    async def update_extraction_result(
        self,
        job_id: str,
        job_data: JobDescriptionSchema,
        extraction_repo_method: ExtractionMethod | None = None,
        is_job_posting: bool = True,
    ) -> None:
        """
        Persist LLM-structured job content and mark extraction COMPLETED.

        Called by the analysis orchestrator after the LLM structures the content.
        ``extraction_repo_method`` is optional — when None the previously stored
        method (set during extraction) is preserved.
        """
        limits = _JOB_EXTRACTION_LIMITS
        now = _utcnow()

        existing = await self.get_by_id(job_id)
        metadata = dict((existing.raw_metadata if existing else None) or {})
        metadata["ai_structured_source"] = "job_match_analysis"
        metadata["ai_structured_updated_at"] = now.isoformat()
        if job_data.raw_metadata:
            metadata.update(job_data.raw_metadata)

        values: dict = {
            "status": ExtractionStatus.COMPLETED,
            "title": _truncate_for_db(job_data.title, limits["title"]),
            "company": _truncate_for_db(job_data.company, limits["company"]),
            "location": _truncate_for_db(job_data.location, limits["location"]),
            "employment_type": _truncate_for_db(job_data.employment_type, limits["employment_type"]),
            "salary_range": _truncate_for_db(job_data.salary_range, limits["salary_range"]),
            "description": job_data.description,
            "responsibilities": job_data.responsibilities,
            "requirements": job_data.requirements,
            "benefits": job_data.benefits,
            "posted_date": job_data.posted_date,
            "application_deadline": job_data.application_deadline,
            "remote_policy": _truncate_for_db(job_data.remote_policy, limits["remote_policy"]),
            "experience_level": _truncate_for_db(job_data.experience_level, limits["experience_level"]),
            "industry": _truncate_for_db(job_data.industry, limits["industry"]),
            "raw_metadata": metadata,
            "is_job_posting": is_job_posting,
            "raw_html": None,
            "completed_at": now,
            "updated_at": now,
        }
        if extraction_repo_method is not None:
            values["extraction_method"] = extraction_repo_method

        await self._session.execute(
            update(JobExtraction).where(JobExtraction.id == job_id).values(**values)
        )

    async def update_is_job_posting(self, job_id: str, is_job_posting: bool) -> None:
        """Store the LLM-determined is_job_posting flag without changing other fields."""
        await self._session.execute(
            update(JobExtraction)
            .where(JobExtraction.id == job_id)
            .values(is_job_posting=is_job_posting, updated_at=_utcnow())
        )

    async def get_pending_jobs(self, limit: int = 100) -> Sequence[JobExtraction]:
        result = await self._session.execute(
            select(JobExtraction)
            .where(JobExtraction.status == ExtractionStatus.PENDING)
            .order_by(JobExtraction.created_at)
            .limit(limit)
        )
        return result.scalars().all()

    async def update_ai_structured_content(
        self,
        job_id: str,
        job_data: JobDescriptionSchema,
        *,
        source: str = "job_match_analysis",
    ) -> None:
        """
        Replace posting fields with LLM-structured job content and drop raw page capture.
        """
        extraction = await self.get_by_id(job_id)
        if not extraction:
            return

        limits = _JOB_EXTRACTION_LIMITS
        extraction.title = _truncate_for_db(job_data.title, limits["title"]) or extraction.title
        extraction.company = _truncate_for_db(job_data.company, limits["company"]) or extraction.company
        extraction.location = _truncate_for_db(job_data.location, limits["location"]) or extraction.location
        extraction.employment_type = _truncate_for_db(job_data.employment_type, limits["employment_type"])
        extraction.salary_range = _truncate_for_db(job_data.salary_range, limits["salary_range"])
        # Job-match LLM often sees the same thin text as the user; do not replace a longer extraction.
        old_desc = (extraction.description or "").strip()
        new_desc = (job_data.description or "").strip()
        if len(new_desc) > len(old_desc) or len(old_desc) < 300:
            extraction.description = sanitize_for_postgres_text(job_data.description)
        extraction.responsibilities = list(job_data.responsibilities or [])
        extraction.requirements = list(job_data.requirements or [])
        extraction.benefits = list(job_data.benefits or [])
        extraction.remote_policy = _truncate_for_db(job_data.remote_policy, limits["remote_policy"])
        extraction.experience_level = _truncate_for_db(job_data.experience_level, limits["experience_level"])
        extraction.industry = _truncate_for_db(job_data.industry, limits["industry"])
        extraction.raw_html = None
        extraction.updated_at = _utcnow()

        metadata = dict(extraction.raw_metadata or {})
        metadata["ai_structured_source"] = source
        metadata["ai_structured_updated_at"] = _utcnow().isoformat()
        extraction.raw_metadata = metadata
        await self._session.flush()


class ValidJobRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def mark_scraped_by_extraction_id(self, extraction_id: str) -> None:
        await self._session.execute(
            update(ValidJob)
            .where(ValidJob.extraction_id == extraction_id)
            .values(scraped_at=_utcnow())
        )

    async def get_by_extraction_id(self, extraction_id: str) -> ValidJob | None:
        result = await self._session.execute(
            select(ValidJob).where(ValidJob.extraction_id == extraction_id).limit(1)
        )
        return result.scalar_one_or_none()

    async def update_from_structured_extraction(
        self,
        valid_job_id: str,
        job_data: JobDescriptionSchema,
    ) -> None:
        """
        Keep valid_jobs in sync with enriched structured extraction content.
        """
        result = await self._session.execute(select(ValidJob).where(ValidJob.id == valid_job_id))
        valid_job = result.scalar_one_or_none()
        if not valid_job:
            return

        valid_job.title = _truncate_for_db(job_data.title, 500) or valid_job.title
        valid_job.company = _truncate_for_db(job_data.company, 500) or valid_job.company
        valid_job.location = _truncate_for_db(job_data.location, 500) or valid_job.location
        old_vj = (valid_job.description or "").strip()
        new_vj = (job_data.description or "").strip()
        if len(new_vj) > len(old_vj) or len(old_vj) < 300:
            valid_job.description = sanitize_for_postgres_text(job_data.description)
        valid_job.posted_date = job_data.posted_date or valid_job.posted_date
        valid_job.experience_level = _truncate_for_db(job_data.experience_level, 100) or valid_job.experience_level
        valid_job.industry = _truncate_for_db(job_data.industry, 200) or valid_job.industry
        valid_job.updated_at = _utcnow()
        await self._session.flush()


class JobMatchRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get(self, valid_job_id: str, user_id: str) -> JobMatchResult | None:
        result = await self._session.execute(
            select(JobMatchResult).where(
                JobMatchResult.valid_job_id == valid_job_id,
                JobMatchResult.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def delete(self, valid_job_id: str, user_id: str) -> None:
        """Remove cached match so a rerun can show processing and store a fresh score."""
        from sqlalchemy import delete

        await self._session.execute(
            delete(JobMatchResult).where(
                JobMatchResult.valid_job_id == valid_job_id,
                JobMatchResult.user_id == user_id,
            )
        )

    async def upsert(
        self,
        valid_job_id: str,
        user_id: str,
        overall_score: int,
        dimension_scores: dict,
        summary: str,
        strengths: list,
        gaps: list,
        recommendation: str,
    ) -> JobMatchResult:
        existing = await self.get(valid_job_id, user_id)
        if existing:
            existing.overall_score = overall_score
            existing.dimension_scores = dimension_scores
            existing.summary = summary
            existing.strengths = strengths
            existing.gaps = gaps
            existing.recommendation = (
                recommendation if recommendation is None else str(recommendation)[:50]
            )
            await self._session.flush()
            return existing
        rec = recommendation if recommendation is None else str(recommendation)[:50]
        row = JobMatchResult(
            valid_job_id=valid_job_id,
            user_id=user_id,
            overall_score=overall_score,
            dimension_scores=dimension_scores,
            summary=summary,
            strengths=strengths,
            gaps=gaps,
            recommendation=rec,
        )
        self._session.add(row)
        await self._session.flush()
        return row


class JobMatchInProgressRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def add(self, valid_job_id: str, user_id: str) -> JobMatchInProgress:
        """Mark job match as in progress. Idempotent and race-safe."""
        stmt = (
            pg_insert(JobMatchInProgress)
            .values(id=str(uuid.uuid4()), valid_job_id=valid_job_id, user_id=user_id)
            .on_conflict_do_nothing(
                index_elements=[JobMatchInProgress.valid_job_id, JobMatchInProgress.user_id]
            )
        )
        await self._session.execute(stmt)
        existing = await self._session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.valid_job_id == valid_job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        return existing.scalar_one()

    async def remove(self, valid_job_id: str, user_id: str) -> None:
        """Remove in-progress marker when analysis completes."""
        from sqlalchemy import delete
        await self._session.execute(
            delete(JobMatchInProgress).where(
                JobMatchInProgress.valid_job_id == valid_job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )


class ValidJobUserApplicationRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def upsert_batch(
        self,
        user_id: str,
        valid_job_ids: Sequence[str],
        applied_by_name: str,
    ) -> int:
        label = (applied_by_name or "Unknown")[:300]
        now = _utcnow()
        n = 0
        for jid in valid_job_ids:
            job = await self._session.get(ValidJob, jid)
            if not job or not job.is_active:
                continue
            stmt = (
                pg_insert(ValidJobUserApplication)
                .values(
                    id=str(uuid.uuid4()),
                    user_id=user_id,
                    valid_job_id=jid,
                    applied_at=now,
                    applied_by_name=label,
                )
                .on_conflict_do_update(
                    index_elements=[ValidJobUserApplication.user_id, ValidJobUserApplication.valid_job_id],
                    set_={"applied_at": now, "applied_by_name": label},
                )
            )
            await self._session.execute(stmt)
            n += 1
        return n

    async def delete_batch(self, user_id: str, valid_job_ids: Sequence[str]) -> int:
        r = await self._session.execute(
            delete(ValidJobUserApplication).where(
                ValidJobUserApplication.user_id == user_id,
                ValidJobUserApplication.valid_job_id.in_(list(valid_job_ids)),
            )
        )
        return int(r.rowcount or 0)


class ResumeBuildRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get(self, valid_job_id: str, user_id: str) -> ResumeBuildResult | None:
        result = await self._session.execute(
            select(ResumeBuildResult).where(
                ResumeBuildResult.valid_job_id == valid_job_id,
                ResumeBuildResult.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        valid_job_id: str,
        user_id: str,
        tailored_resume_data: dict | None = None,
        cover_letter_data: dict | None = None,
    ) -> ResumeBuildResult:
        existing = await self.get(valid_job_id, user_id)
        if existing:
            if tailored_resume_data is not None:
                existing.tailored_resume_data = tailored_resume_data
            if cover_letter_data is not None:
                existing.cover_letter_data = cover_letter_data
            existing.resume_docx_status = "pending"
            existing.resume_pdf_status = "pending"
            existing.cover_letter_docx_status = "pending"
            existing.cover_letter_pdf_status = "pending"
            existing.resume_docx_path = None
            existing.resume_pdf_path = None
            existing.cover_letter_docx_path = None
            existing.cover_letter_pdf_path = None
            existing.output_directory = None
            existing.error_message = None
            existing.updated_at = _utcnow()
            await self._session.flush()
            return existing

        row = ResumeBuildResult(
            valid_job_id=valid_job_id,
            user_id=user_id,
            tailored_resume_data=tailored_resume_data,
            cover_letter_data=cover_letter_data,
        )
        self._session.add(row)
        await self._session.flush()
        return row

    async def update_file_status(
        self,
        build_id: str,
        file_type: str,
        status: str,
        path: str | None = None,
        error: str | None = None,
    ) -> None:
        row = await self._session.get(ResumeBuildResult, build_id)
        if not row:
            return
        status_col = f"{file_type}_status"
        path_col = f"{file_type}_path"
        if hasattr(row, status_col):
            setattr(row, status_col, status)
        if path and hasattr(row, path_col):
            setattr(row, path_col, path)
        if error:
            row.error_message = error
        row.updated_at = _utcnow()
        await self._session.flush()

    async def set_output_directory(self, build_id: str, directory: str) -> None:
        row = await self._session.get(ResumeBuildResult, build_id)
        if row:
            row.output_directory = directory
            row.updated_at = _utcnow()
            await self._session.flush()


class APIPatternRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_pattern_for_domain(self, domain: str) -> APIPatternRegistry | None:
        result = await self._session.execute(
            select(APIPatternRegistry)
            .where(
                and_(
                    APIPatternRegistry.domain_pattern == domain,
                    APIPatternRegistry.is_active == True,
                )
            )
            .order_by(APIPatternRegistry.priority.desc())
        )
        return result.scalar_one_or_none()

    async def get_all_active_patterns(self) -> Sequence[APIPatternRegistry]:
        result = await self._session.execute(
            select(APIPatternRegistry)
            .where(APIPatternRegistry.is_active == True)
            .order_by(APIPatternRegistry.priority.desc())
        )
        return result.scalars().all()

    async def update_success_rate(
        self,
        pattern_id: str,
        success: bool,
    ) -> None:
        pattern = await self._session.get(APIPatternRegistry, pattern_id)
        if pattern:
            if success:
                pattern.success_rate = min(1.0, pattern.success_rate + 0.01)
                pattern.last_success_at = _utcnow()
            else:
                pattern.success_rate = max(0.0, pattern.success_rate - 0.05)
            await self._session.flush()
