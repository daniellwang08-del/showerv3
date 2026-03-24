"""
Orchestrates job match analysis: fetches job + profile, calls AI, stores result.
Shared by worker task and sync fallback.
"""

from sqlalchemy import select
from app.models.database import ValidJob
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, JobMatchRepository, JobMatchInProgressRepository
from app.storage.user_repository import UserRepository
from app.services.job_match_service import analyze_job_match, _build_job_text
from app.core.logging import get_logger

logger = get_logger(__name__)


async def run_job_match_analysis(valid_job_id: str, user_id: str) -> dict | None:
    """
    Run full job match pipeline and store result.
    Returns match result dict or None on failure.
    """
    async with get_session() as session:
        extraction_repo = JobExtractionRepository(session)
        user_repo = UserRepository(session)
        match_repo = JobMatchRepository(session)

        # Resolve valid_job -> extraction
        r = await session.execute(select(ValidJob).where(ValidJob.id == valid_job_id))
        valid_job = r.scalar_one_or_none()
        if not valid_job or not valid_job.extraction_id:
            logger.warning("job_match_no_valid_job_or_extraction", valid_job_id=valid_job_id)
            return None

        extraction = await extraction_repo.get_by_id(valid_job.extraction_id)
        if not extraction or not extraction.description:
            logger.warning("job_match_no_extraction_or_description", extraction_id=valid_job.extraction_id)
            return None

        profile_text = await user_repo.get_profile_openai_text(user_id)
        job_text = _build_job_text(
            title=extraction.title,
            company=extraction.company,
            description=extraction.description,
            requirements=extraction.requirements,
            responsibilities=extraction.responsibilities,
        )

        try:
            result = await analyze_job_match(job_text, profile_text)
        except Exception as e:
            logger.error("job_match_analysis_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
            progress_repo = JobMatchInProgressRepository(session)
            await progress_repo.remove(valid_job_id, user_id)
            return None

        await match_repo.upsert(
            valid_job_id=valid_job_id,
            user_id=user_id,
            overall_score=result["overall_score"],
            dimension_scores=result["dimension_scores"],
            summary=result["summary"],
            strengths=result["strengths"],
            gaps=result["gaps"],
            recommendation=result["recommendation"],
        )
        progress_repo = JobMatchInProgressRepository(session)
        await progress_repo.remove(valid_job_id, user_id)
        logger.info("job_match_stored", valid_job_id=valid_job_id, user_id=user_id, score=result["overall_score"])
        return result
