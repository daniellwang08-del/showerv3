from sqlalchemy import select, update, and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database import JobExtraction, APIPatternRegistry, ValidJob, JobMatchResult, JobMatchInProgress
from app.models.schemas import ExtractionStatus, ExtractionMethod, JobDescriptionSchema
from app.core.logging import get_logger
from app.utils.text_sanitizer import sanitize_for_postgres_text
from datetime import datetime, timedelta
from typing import Sequence

logger = get_logger(__name__)

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

    async def get_or_create(
        self,
        source_url: str,
        normalized_url: str,
        domain: str,
    ) -> tuple[JobExtraction, bool]:
        extraction = JobExtraction(
            source_url=source_url,
            normalized_url=normalized_url,
            domain=domain,
            status=ExtractionStatus.PENDING,
        )

        try:
            async with self._session.begin_nested():
                self._session.add(extraction)
                await self._session.flush()
            logger.debug("repository_get_or_create_created", extraction_id=extraction.id, normalized_url=normalized_url)
            return extraction, True
        except IntegrityError:
            result = await self._session.execute(
                select(JobExtraction).where(JobExtraction.normalized_url == normalized_url)
            )
            existing = result.scalar_one_or_none()
            if existing:
                logger.debug("repository_get_or_create_existing", extraction_id=existing.id, normalized_url=normalized_url)
                return existing, False
            raise

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
            "confidence_score": None,
            "error_message": None,
            "retry_count": 0,
            "completed_at": None,
            "updated_at": datetime.utcnow(),
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

    async def get_by_normalized_url(self, normalized_url: str) -> JobExtraction | None:
        result = await self._session.execute(
            select(JobExtraction).where(JobExtraction.normalized_url == normalized_url)
        )
        return result.scalar_one_or_none()

    async def find_recent_by_normalized_url(
        self,
        normalized_url: str,
        within_hours: int = 24,
    ) -> JobExtraction | None:
        cutoff = datetime.utcnow() - timedelta(hours=within_hours)
        result = await self._session.execute(
            select(JobExtraction).where(
                and_(
                    JobExtraction.normalized_url == normalized_url,
                    JobExtraction.created_at >= cutoff,
                    JobExtraction.status == ExtractionStatus.COMPLETED,
                )
            )
        )
        return result.scalar_one_or_none()

    async def update_status(
        self,
        job_id: str,
        status: ExtractionStatus,
        error_message: str | None = None,
    ) -> None:
        values = {"status": status, "updated_at": datetime.utcnow()}
        if error_message:
            values["error_message"] = sanitize_for_postgres_text(error_message)
        if status == ExtractionStatus.COMPLETED:
            values["completed_at"] = datetime.utcnow()

        await self._session.execute(
            update(JobExtraction).where(JobExtraction.id == job_id).values(**values)
        )
        logger.debug("repository_update_status", job_id=job_id, status=status.value)

    async def update_extraction_result(
        self,
        job_id: str,
        job_data: JobDescriptionSchema,
        method: ExtractionMethod,
        confidence_score: float,
        raw_html: str | None = None,
    ) -> None:
        limits = _JOB_EXTRACTION_LIMITS
        values = {
            "status": ExtractionStatus.COMPLETED,
            "extraction_method": method,
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
            "raw_metadata": job_data.raw_metadata,
            "confidence_score": confidence_score,
            "completed_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
        if raw_html:
            values["raw_html"] = sanitize_for_postgres_text(raw_html)

        await self._session.execute(
            update(JobExtraction).where(JobExtraction.id == job_id).values(**values)
        )

    async def get_pending_jobs(self, limit: int = 100) -> Sequence[JobExtraction]:
        result = await self._session.execute(
            select(JobExtraction)
            .where(JobExtraction.status == ExtractionStatus.PENDING)
            .order_by(JobExtraction.created_at)
            .limit(limit)
        )
        return result.scalars().all()

    async def increment_retry(self, job_id: str) -> None:
        await self._session.execute(
            update(JobExtraction)
            .where(JobExtraction.id == job_id)
            .values(retry_count=JobExtraction.retry_count + 1)
        )

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
        extraction.description = sanitize_for_postgres_text(job_data.description)
        extraction.responsibilities = list(job_data.responsibilities or [])
        extraction.requirements = list(job_data.requirements or [])
        extraction.benefits = list(job_data.benefits or [])
        extraction.remote_policy = _truncate_for_db(job_data.remote_policy, limits["remote_policy"])
        extraction.experience_level = _truncate_for_db(job_data.experience_level, limits["experience_level"])
        extraction.industry = _truncate_for_db(job_data.industry, limits["industry"])
        extraction.raw_html = None
        extraction.updated_at = datetime.utcnow()

        metadata = dict(extraction.raw_metadata or {})
        metadata["ai_structured_source"] = source
        metadata["ai_structured_updated_at"] = datetime.utcnow().isoformat()
        extraction.raw_metadata = metadata
        await self._session.flush()


class ValidJobRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def mark_scraped_by_extraction_id(self, extraction_id: str) -> None:
        await self._session.execute(
            update(ValidJob)
            .where(ValidJob.extraction_id == extraction_id)
            .values(scraped_at=datetime.utcnow())
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
        valid_job.description = sanitize_for_postgres_text(job_data.description)
        valid_job.posted_date = job_data.posted_date or valid_job.posted_date
        valid_job.experience_level = _truncate_for_db(job_data.experience_level, 100) or valid_job.experience_level
        valid_job.industry = _truncate_for_db(job_data.industry, 200) or valid_job.industry
        valid_job.updated_at = datetime.utcnow()
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
            existing.recommendation = recommendation
            await self._session.flush()
            return existing
        row = JobMatchResult(
            valid_job_id=valid_job_id,
            user_id=user_id,
            overall_score=overall_score,
            dimension_scores=dimension_scores,
            summary=summary,
            strengths=strengths,
            gaps=gaps,
            recommendation=recommendation,
        )
        self._session.add(row)
        await self._session.flush()
        return row


class JobMatchInProgressRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def add(self, valid_job_id: str, user_id: str) -> JobMatchInProgress:
        """Mark job match as in progress. Idempotent (no-op if exists)."""
        existing = await self._session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.valid_job_id == valid_job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        row = existing.scalar_one_or_none()
        if row:
            return row
        prog = JobMatchInProgress(valid_job_id=valid_job_id, user_id=user_id)
        self._session.add(prog)
        await self._session.flush()
        return prog

    async def remove(self, valid_job_id: str, user_id: str) -> None:
        """Remove in-progress marker when analysis completes."""
        from sqlalchemy import delete
        await self._session.execute(
            delete(JobMatchInProgress).where(
                JobMatchInProgress.valid_job_id == valid_job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )



class APIPatternRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_pattern_for_domain(self, domain: str) -> APIPatternRegistry | None:
        result = await self._session.execute(
            select(APIPatternRegistry)
            .where(
                and_(
                    APIPatternRegistry.domain_pattern == domain,
                    APIPatternRegistry.is_active == 1,
                )
            )
            .order_by(APIPatternRegistry.priority.desc())
        )
        return result.scalar_one_or_none()

    async def get_all_active_patterns(self) -> Sequence[APIPatternRegistry]:
        result = await self._session.execute(
            select(APIPatternRegistry)
            .where(APIPatternRegistry.is_active == 1)
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
                pattern.last_success_at = datetime.utcnow()
            else:
                pattern.success_rate = max(0.0, pattern.success_rate - 0.05)
            await self._session.flush()
