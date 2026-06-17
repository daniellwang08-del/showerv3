import uuid

from sqlalchemy import select, update, and_, delete, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database import (
    JobExtraction,
    APIPatternRegistry,
    Job,
    JobMatchResult,
    JobMatchInProgress,
    ValidJobUserApplication,
    ResumeBuildResult,
    UserJobStatus,
)
from app.models.schemas import ExtractionStatus, ExtractionMethod, JobDescriptionSchema
from app.services.job_field_utils import (
    clean_optional_job_field,
    infer_title_from_description,
)
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


def _truncate_job_title_for_db(value: str | None, max_len: int = 500) -> str | None:
    cleaned = clean_optional_job_field(value)
    return _truncate_for_db(cleaned, max_len)


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
            "raw_plain_text": None,
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
        """
        limits = _JOB_EXTRACTION_LIMITS
        now = _utcnow()

        existing = await self.get_by_id(job_id)
        metadata = dict((existing.raw_metadata if existing else None) or {})
        metadata["ai_structured_source"] = "job_match_analysis"
        metadata["ai_structured_updated_at"] = now.isoformat()
        if job_data.raw_metadata:
            metadata.update(job_data.raw_metadata)

        resolved_title = _truncate_job_title_for_db(job_data.title, limits["title"])
        if not resolved_title:
            recovered = infer_title_from_description(job_data.description)
            resolved_title = _truncate_for_db(recovered, limits["title"]) if recovered else None

        values: dict = {
            "status": ExtractionStatus.COMPLETED,
            "title": resolved_title,
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
        await self._session.execute(
            update(JobExtraction)
            .where(JobExtraction.id == job_id)
            .values(is_job_posting=is_job_posting, updated_at=_utcnow())
        )

    async def save_raw_plain_text(self, job_id: str, plain_text: str) -> None:
        await self._session.execute(
            update(JobExtraction)
            .where(JobExtraction.id == job_id, JobExtraction.raw_plain_text.is_(None))
            .values(raw_plain_text=plain_text, updated_at=_utcnow())
        )
        logger.debug("repository_save_raw_plain_text", job_id=job_id, length=len(plain_text))

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
        extraction = await self.get_by_id(job_id)
        if not extraction:
            return

        limits = _JOB_EXTRACTION_LIMITS
        clean_title = _truncate_job_title_for_db(job_data.title, limits["title"])
        if clean_title:
            extraction.title = clean_title
        else:
            recovered = infer_title_from_description(job_data.description)
            if recovered:
                extraction.title = _truncate_for_db(recovered, limits["title"]) or extraction.title
        extraction.company = _truncate_for_db(job_data.company, limits["company"]) or extraction.company
        extraction.location = _truncate_for_db(job_data.location, limits["location"]) or extraction.location
        extraction.employment_type = _truncate_for_db(job_data.employment_type, limits["employment_type"])
        extraction.salary_range = _truncate_for_db(job_data.salary_range, limits["salary_range"])
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


class JobRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def mark_scraped_by_extraction_id(self, extraction_id: str) -> None:
        await self._session.execute(
            update(Job)
            .where(Job.extraction_id == extraction_id)
            .values(scraped_at=_utcnow())
        )

    async def get_by_extraction_id(self, extraction_id: str) -> Job | None:
        result = await self._session.execute(
            select(Job).where(Job.extraction_id == extraction_id).limit(1)
        )
        return result.scalar_one_or_none()

    async def get_by_id(self, job_id: str) -> Job | None:
        result = await self._session.execute(
            select(Job).where(Job.id == job_id)
        )
        return result.scalar_one_or_none()

    async def get_by_normalized_url(self, normalized_url: str) -> Job | None:
        result = await self._session.execute(
            select(Job)
            .where(Job.normalized_url == normalized_url, Job.status == "active")
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def update_from_structured_extraction(
        self,
        job_id: str,
        job_data: JobDescriptionSchema,
    ) -> None:
        result = await self._session.execute(select(Job).where(Job.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            return

        clean_title = _truncate_job_title_for_db(job_data.title, 500)
        if clean_title:
            job.title = clean_title
        else:
            recovered = infer_title_from_description(job_data.description)
            if recovered:
                job.title = _truncate_for_db(recovered, 500) or job.title
        job.company = _truncate_for_db(job_data.company, 500) or job.company
        job.location = _truncate_for_db(job_data.location, 500) or job.location
        old_vj = (job.description or "").strip()
        new_vj = (job_data.description or "").strip()
        if new_vj and (len(new_vj) >= len(old_vj) or len(old_vj) < 300):
            job.description = sanitize_for_postgres_text(job_data.description)
        job.posted_date = job_data.posted_date or job.posted_date
        job.experience_level = _truncate_for_db(job_data.experience_level, 100) or job.experience_level
        job.industry = _truncate_for_db(job_data.industry, 200) or job.industry
        job.updated_at = _utcnow()
        await self._session.flush()


class JobMatchRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get(self, job_id: str, user_id: str) -> JobMatchResult | None:
        result = await self._session.execute(
            select(JobMatchResult).where(
                JobMatchResult.job_id == job_id,
                JobMatchResult.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def delete(self, job_id: str, user_id: str) -> None:
        from sqlalchemy import delete

        await self._session.execute(
            delete(JobMatchResult).where(
                JobMatchResult.job_id == job_id,
                JobMatchResult.user_id == user_id,
            )
        )

    async def upsert(
        self,
        job_id: str,
        user_id: str,
        overall_score: int,
        dimension_scores: dict,
        summary: str,
        strengths: list,
        gaps: list,
        recommendation: str,
    ) -> JobMatchResult:
        existing = await self.get(job_id, user_id)
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
            job_id=job_id,
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

    async def add(self, job_id: str, user_id: str) -> JobMatchInProgress:
        stmt = (
            pg_insert(JobMatchInProgress)
            .values(id=str(uuid.uuid4()), job_id=job_id, user_id=user_id)
            .on_conflict_do_nothing(
                index_elements=[JobMatchInProgress.job_id, JobMatchInProgress.user_id]
            )
        )
        await self._session.execute(stmt)
        existing = await self._session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        return existing.scalar_one()

    async def remove(self, job_id: str, user_id: str) -> None:
        from sqlalchemy import delete
        await self._session.execute(
            delete(JobMatchInProgress).where(
                JobMatchInProgress.job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )


class ValidJobUserApplicationRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def upsert_batch(
        self,
        user_id: str,
        job_ids: Sequence[str],
        applied_by_name: str,
    ) -> int:
        label = (applied_by_name or "Unknown")[:300]
        now = _utcnow()

        valid_result = await self._session.execute(
            select(Job.id).where(Job.id.in_(list(job_ids)), Job.status == "active")
        )
        valid_ids = {row[0] for row in valid_result.all()}
        if not valid_ids:
            return 0

        for jid in valid_ids:
            stmt = (
                pg_insert(ValidJobUserApplication)
                .values(
                    id=str(uuid.uuid4()),
                    user_id=user_id,
                    job_id=jid,
                    applied_at=now,
                    applied_by_name=label,
                )
                .on_conflict_do_update(
                    index_elements=[ValidJobUserApplication.user_id, ValidJobUserApplication.job_id],
                    set_={"applied_at": now, "applied_by_name": label},
                )
            )
            await self._session.execute(stmt)
        return len(valid_ids)

    async def delete_batch(self, user_id: str, job_ids: Sequence[str]) -> int:
        r = await self._session.execute(
            delete(ValidJobUserApplication).where(
                ValidJobUserApplication.user_id == user_id,
                ValidJobUserApplication.job_id.in_(list(job_ids)),
            )
        )
        return int(r.rowcount or 0)


class ResumeBuildRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get(self, job_id: str, user_id: str) -> ResumeBuildResult | None:
        result = await self._session.execute(
            select(ResumeBuildResult).where(
                ResumeBuildResult.job_id == job_id,
                ResumeBuildResult.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        job_id: str,
        user_id: str,
        tailored_resume_data: dict | None = None,
        cover_letter_data: dict | None = None,
        *,
        content_generation_status: str | None = None,
    ) -> ResumeBuildResult:
        existing = await self.get(job_id, user_id)
        if existing:
            if tailored_resume_data is not None:
                existing.tailored_resume_data = tailored_resume_data
            if cover_letter_data is not None:
                existing.cover_letter_data = cover_letter_data
            if content_generation_status is not None:
                existing.content_generation_status = content_generation_status
                if content_generation_status != "failed":
                    existing.content_generation_error = None
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
            job_id=job_id,
            user_id=user_id,
            tailored_resume_data=tailored_resume_data,
            cover_letter_data=cover_letter_data,
            content_generation_status=content_generation_status or "pending",
        )
        self._session.add(row)
        await self._session.flush()
        return row

    async def ensure_content_placeholder(
        self,
        job_id: str,
        user_id: str,
        *,
        status: str = "pending",
    ) -> ResumeBuildResult:
        existing = await self.get(job_id, user_id)
        if existing:
            existing.content_generation_status = status
            existing.content_generation_error = None
            existing.updated_at = _utcnow()
            await self._session.flush()
            return existing
        row = ResumeBuildResult(
            job_id=job_id,
            user_id=user_id,
            content_generation_status=status,
        )
        self._session.add(row)
        await self._session.flush()
        return row

    async def mark_content_generating(self, job_id: str, user_id: str) -> None:
        row = await self.get(job_id, user_id)
        if not row:
            row = await self.ensure_content_placeholder(job_id, user_id, status="processing")
        row.content_generation_status = "processing"
        row.content_generation_error = None
        row.updated_at = _utcnow()
        await self._session.flush()

    async def complete_content_generation(
        self,
        job_id: str,
        user_id: str,
        *,
        tailored_resume_data: dict,
        cover_letter_data: dict | None,
    ) -> ResumeBuildResult:
        row = await self.upsert(
            job_id,
            user_id,
            tailored_resume_data=tailored_resume_data,
            cover_letter_data=cover_letter_data,
            content_generation_status="completed",
        )
        return row

    async def fail_content_generation(
        self,
        job_id: str,
        user_id: str,
        error: str,
    ) -> None:
        row = await self.get(job_id, user_id)
        if not row:
            row = await self.ensure_content_placeholder(job_id, user_id, status="failed")
        row.content_generation_status = "failed"
        row.content_generation_error = _truncate_for_db(error, 1500)
        row.updated_at = _utcnow()
        await self._session.flush()

    async def mark_content_skipped(self, job_id: str, user_id: str) -> None:
        await self.ensure_content_placeholder(job_id, user_id, status="skipped")

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


class UserJobStatusRepository:
    """Manages per-user job status (active, duplicated, manual_hidden)."""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def get(self, user_id: str, job_id: str) -> UserJobStatus | None:
        result = await self._session.execute(
            select(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == job_id,
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        *,
        user_id: str,
        job_id: str,
        status: str,
        exclusion_type: str | None = None,
        duplicated_because_id: str | None = None,
        reason: str | None = None,
        match_score_at_decision: float | None = None,
    ) -> UserJobStatus:
        existing = await self.get(user_id, job_id)
        if existing:
            existing.status = status
            existing.exclusion_type = exclusion_type
            existing.duplicated_because_id = duplicated_because_id
            existing.reason = _truncate_for_db(reason, 1500) if reason else reason
            existing.match_score_at_decision = match_score_at_decision
            existing.updated_at = _utcnow()
            await self._session.flush()
            return existing
        row = UserJobStatus(
            id=str(uuid.uuid4()),
            user_id=user_id,
            job_id=job_id,
            status=status,
            exclusion_type=exclusion_type,
            duplicated_because_id=duplicated_because_id,
            reason=_truncate_for_db(reason, 1500) if reason else reason,
            match_score_at_decision=match_score_at_decision,
        )
        self._session.add(row)
        await self._session.flush()
        return row

    async def delete(self, user_id: str, job_id: str) -> bool:
        result = await self._session.execute(
            delete(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == job_id,
            )
        )
        return bool(result.rowcount)

    async def list_for_user(
        self,
        user_id: str,
        *,
        statuses: list[str] | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[UserJobStatus]:
        stmt = select(UserJobStatus).where(UserJobStatus.user_id == user_id)
        if statuses:
            stmt = stmt.where(UserJobStatus.status.in_(statuses))
        stmt = stmt.order_by(UserJobStatus.created_at.desc()).limit(limit).offset(offset)
        result = await self._session.execute(stmt)
        return list(result.scalars().all())

    async def get_excluded_job_ids(self, user_id: str) -> set[str]:
        result = await self._session.execute(
            select(UserJobStatus.job_id).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status.in_(["duplicated", "manual_hidden"]),
            )
        )
        return {row[0] for row in result.all()}

    async def is_excluded(self, user_id: str, job_id: str) -> bool:
        result = await self._session.execute(
            select(UserJobStatus.id).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == job_id,
                UserJobStatus.status.in_(["duplicated", "manual_hidden"]),
            ).limit(1)
        )
        return result.scalar_one_or_none() is not None


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
