"""
Orchestrates job match analysis: reads extracted text from cache (or DB fallback),
calls AI for match scoring + structured job extraction, stores results.

Shared by worker task and sync fallback.
"""

import asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database import ValidJob
from app.models.schemas import ExtractionStatus
from app.storage.database import get_session
from app.storage.repository import (
    JobExtractionRepository,
    JobMatchRepository,
    JobMatchInProgressRepository,
    ValidJobRepository,
    ResumeBuildRepository,
    _truncate_for_db,
)
from app.storage.user_repository import UserRepository
from app.services.job_match_service import analyze_job_match, _build_job_text
from app.services.extraction_cache import ExtractionCache
from app.services.company_policy import enforce_company_priority_after_match
from app.core.logging import bind_logging_context, get_logger

logger = get_logger(__name__)


async def clear_job_match_progress(valid_job_id: str, user_id: str) -> None:
    """Remove match in-progress marker (idempotent)."""
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


async def _get_job_text_from_cache_or_db(
    extraction_id: str,
    extraction_repo: JobExtractionRepository,
) -> str | None:
    """
    Try reading plain text from Redis cache first (new flow).
    Fall back to building text from DB fields (legacy/re-analysis).
    """
    cache = ExtractionCache()
    cached = await cache.get(extraction_id)
    if cached and cached.plain_text:
        logger.info("job_text_from_cache", extraction_id=extraction_id, length=cached.content_length)
        return cached.plain_text

    extraction = await extraction_repo.get_by_id(extraction_id)
    if not extraction:
        return None

    if extraction.description:
        job_text = _build_job_text(
            title=extraction.title,
            company=extraction.company,
            description=extraction.description,
            requirements=extraction.requirements,
            responsibilities=extraction.responsibilities,
        )
        logger.info("job_text_from_db_fallback", extraction_id=extraction_id)
        return job_text

    return None


async def run_job_match_analysis(
    valid_job_id: str,
    user_id: str,
    *,
    extraction_id: str | None = None,
) -> dict | None:
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
            if not valid_job:
                logger.warning("job_match_no_valid_job", valid_job_id=valid_job_id)
                await _remove_match_progress(session, valid_job_id, user_id)
                return None

            ext_id = extraction_id or valid_job.extraction_id
            if not ext_id:
                logger.warning("job_match_no_extraction_id", valid_job_id=valid_job_id)
                await _remove_match_progress(session, valid_job_id, user_id)
                return None

            job_text = await _get_job_text_from_cache_or_db(ext_id, extraction_repo)
            if not job_text:
                logger.warning(
                    "job_match_no_text_available",
                    extraction_id=ext_id,
                )
                await _remove_match_progress(session, valid_job_id, user_id)
                return None

            profile_text = await user_repo.get_profile_openai_text(user_id)

            try:
                result, structured_job, is_job_posting, tailored_resume, cover_letter = await analyze_job_match(job_text, profile_text)
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
                        structured_company = _truncate_for_db(structured_job.company, 500)
                        await extraction_repo.update_extraction_result(
                            ext_id,
                            structured_job,
                            extraction_repo_method=None,
                            is_job_posting=is_job_posting,
                        )
                        valid_repo = ValidJobRepository(session)
                        await valid_repo.update_from_structured_extraction(valid_job_id, structured_job)
                        logger.info(
                            "job_match_structured_content_updated",
                            valid_job_id=valid_job_id,
                            extraction_id=ext_id,
                        )
                    except Exception as struct_err:
                        logger.warning(
                            "job_match_structured_content_update_failed",
                            valid_job_id=valid_job_id,
                            extraction_id=ext_id,
                            error=str(struct_err),
                        )
                else:
                    logger.warning("job_match_no_structured_job_returned", valid_job_id=valid_job_id)
                    await extraction_repo.update_is_job_posting(ext_id, is_job_posting)

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
                await session.flush()

                # Store tailored resume/cover letter data for async document build
                if tailored_resume or cover_letter:
                    try:
                        resume_repo = ResumeBuildRepository(session)
                        await resume_repo.upsert(
                            valid_job_id=valid_job_id,
                            user_id=user_id,
                            tailored_resume_data=tailored_resume,
                            cover_letter_data=cover_letter,
                        )
                        await session.flush()
                        logger.info("tailored_resume_data_stored", valid_job_id=valid_job_id)
                    except Exception as resume_err:
                        logger.warning(
                            "tailored_resume_data_store_failed",
                            valid_job_id=valid_job_id,
                            error=str(resume_err),
                        )

                # Clean up cache after successful analysis
                try:
                    cache = ExtractionCache()
                    await cache.delete(ext_id)
                except Exception:
                    pass

                logger.info(
                    "job_match_stored",
                    valid_job_id=valid_job_id,
                    user_id=user_id,
                    score=result["overall_score"],
                )

                # Enqueue resume build (fire-and-forget, never blocks match result)
                if tailored_resume:
                    try:
                        from app.tasks.worker import get_resume_build_pool
                        pool = await get_resume_build_pool()
                        await pool.enqueue_job("build_resume_task", valid_job_id, user_id)
                        await pool.close()
                        logger.info("resume_build_enqueued", valid_job_id=valid_job_id)
                    except Exception as enq_err:
                        logger.warning("resume_build_enqueue_failed", valid_job_id=valid_job_id, error=str(enq_err))

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
