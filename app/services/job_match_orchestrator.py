"""
Orchestrates job match analysis: fetches job + profile, calls AI, stores result.
Shared by worker task and sync fallback.
"""

import asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database import ValidJob
from app.storage.database import get_session
from app.storage.repository import (
    JobExtractionRepository,
    JobMatchRepository,
    JobMatchInProgressRepository,
    ValidJobRepository,
    _truncate_for_db,
)
from app.storage.user_repository import UserRepository
from app.services.job_match_service import analyze_job_match, _build_job_text
from app.services.company_policy import enforce_company_priority_after_match
from app.core.logging import bind_logging_context, get_logger

logger = get_logger(__name__)


async def clear_job_match_progress(valid_job_id: str, user_id: str) -> None:
    """Remove match in-progress marker (idempotent). Used on early exit, cancel, or worker cleanup."""
    try:
        async with get_session() as session:
            repo = JobMatchInProgressRepository(session)
            await repo.remove(valid_job_id, user_id)
    except Exception as e:
        logger.warning(
            "job_match_progress_clear_failed",
            valid_job_id=valid_job_id,
            user_id=user_id,
            error=str(e),
        )


async def _remove_match_progress(session: AsyncSession, valid_job_id: str, user_id: str) -> None:
    repo = JobMatchInProgressRepository(session)
    await repo.remove(valid_job_id, user_id)


async def run_job_match_analysis(valid_job_id: str, user_id: str) -> dict | None:
    """
    Run full job match pipeline and store result.
    Returns match result dict or None on failure.
    """
    bind_logging_context(valid_job_id=valid_job_id, user_id=user_id)
    try:
        async with get_session() as session:
            extraction_repo = JobExtractionRepository(session)
            user_repo = UserRepository(session)
            match_repo = JobMatchRepository(session)

            r = await session.execute(select(ValidJob).where(ValidJob.id == valid_job_id))
            valid_job = r.scalar_one_or_none()
            if not valid_job or not valid_job.extraction_id:
                logger.warning("job_match_no_valid_job_or_extraction", valid_job_id=valid_job_id)
                await _remove_match_progress(session, valid_job_id, user_id)
                return None

            extraction = await extraction_repo.get_by_id(valid_job.extraction_id)
            if not extraction or not extraction.description:
                logger.warning(
                    "job_match_no_extraction_or_description",
                    extraction_id=valid_job.extraction_id,
                )
                await _remove_match_progress(session, valid_job_id, user_id)
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
                result, structured_job = await analyze_job_match(job_text, profile_text)
            except Exception as e:
                logger.error(
                    "job_match_analysis_failed",
                    valid_job_id=valid_job_id,
                    user_id=user_id,
                    error=str(e),
                )
                await _remove_match_progress(session, valid_job_id, user_id)
                return None

            try:
                structured_company: str | None = None
                if structured_job:
                    try:
                        # Match LLM may return huge garbage in `company`; DB + policy need capped strings.
                        structured_company = _truncate_for_db(structured_job.company, 500)
                        await extraction_repo.update_ai_structured_content(
                            extraction.id,
                            structured_job,
                            source="job_match_analysis",
                        )
                        valid_repo = ValidJobRepository(session)
                        await valid_repo.update_from_structured_extraction(valid_job_id, structured_job)
                        logger.info(
                            "job_match_structured_content_updated",
                            valid_job_id=valid_job_id,
                            extraction_id=extraction.id,
                        )
                    except Exception as struct_err:
                        logger.warning(
                            "job_match_structured_content_update_failed",
                            valid_job_id=valid_job_id,
                            extraction_id=extraction.id,
                            error=str(struct_err),
                        )
                else:
                    logger.warning("job_match_no_structured_job_returned", valid_job_id=valid_job_id)

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
                try:
                    await enforce_company_priority_after_match(
                        session,
                        valid_job_id,
                        user_id=user_id,
                        new_match_score=int(result["overall_score"]),
                        company_name=structured_company,
                    )
                except Exception as dup_err:
                    logger.warning(
                        "company_priority_policy_check_failed",
                        valid_job_id=valid_job_id,
                        user_id=user_id,
                        error=str(dup_err),
                    )
                await _remove_match_progress(session, valid_job_id, user_id)
                # Surface VARCHAR/constraint errors here so commit does not fail in get_session.__aexit__
                await session.flush()
                logger.info(
                    "job_match_stored",
                    valid_job_id=valid_job_id,
                    user_id=user_id,
                    score=result["overall_score"],
                )
                return result
            except Exception as e:
                logger.error(
                    "job_match_persist_failed",
                    valid_job_id=valid_job_id,
                    user_id=user_id,
                    error=str(e),
                )
                await _remove_match_progress(session, valid_job_id, user_id)
                return None
    except asyncio.CancelledError:
        await clear_job_match_progress(valid_job_id, user_id)
        raise
