"""
Orchestrates two-phase job match analysis:

Phase A (analyze_job_match worker): validation + structured job + match score.
Phase B (generate_tailored_content worker): tailored resume JSON + cover letter.
"""

import asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import bind_logging_context, get_logger
from app.models.database import Job
from app.models.schemas import JobDescriptionSchema
from app.services.job_match_service import (
    analyze_job_match_phase_a,
    generate_tailored_content_phase_b,
    _build_job_text,
    build_structured_context,
)
from app.services.extraction_cache import ExtractionCache
from app.storage.database import get_session
from app.storage.repository import (
    JobExtractionRepository,
    JobMatchRepository,
    JobMatchInProgressRepository,
    JobRepository,
    ResumeBuildRepository,
    _truncate_for_db,
)
from app.storage.user_repository import UserRepository
from app.api.websocket import publish_ws_event

logger = get_logger(__name__)


async def clear_job_match_progress(job_id: str, user_id: str) -> None:
    try:
        async with get_session() as session:
            repo = JobMatchInProgressRepository(session)
            await repo.remove(job_id, user_id)
    except Exception as e:
        logger.warning(
            "job_match_progress_clear_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )


async def _remove_match_progress(session: AsyncSession, job_id: str, user_id: str) -> None:
    repo = JobMatchInProgressRepository(session)
    await repo.remove(job_id, user_id)


async def _get_job_text_from_cache_or_db(
    extraction_id: str,
    extraction_repo: JobExtractionRepository,
) -> str | None:
    cache = ExtractionCache()
    cached = await cache.get(extraction_id)
    if cached and cached.plain_text:
        logger.info("job_text_from_cache", extraction_id=extraction_id, length=cached.content_length)
        return cached.plain_text

    extraction = await extraction_repo.get_by_id(extraction_id)
    if not extraction:
        return None

    raw = getattr(extraction, "raw_plain_text", None)
    if raw and str(raw).strip():
        logger.info("job_text_from_raw_plain_text", extraction_id=extraction_id, length=len(raw))
        return str(raw)

    if extraction.description:
        job_text = _build_job_text(
            title=extraction.title,
            company=extraction.company,
            description=extraction.description,
            requirements=extraction.requirements,
            responsibilities=extraction.responsibilities,
        )
        logger.info("job_text_from_db_structured_fallback", extraction_id=extraction_id)
        return job_text

    return None


async def _load_job_and_profile(
    job_id: str,
    user_id: str,
    extraction_id: str | None,
) -> tuple[str, str, str] | None:
    async with get_session() as session:
        extraction_repo = JobExtractionRepository(session)
        user_repo = UserRepository(session)

        r = await session.execute(select(Job).where(Job.id == job_id))
        job = r.scalar_one_or_none()
        if not job:
            logger.warning("job_match_no_job", job_id=job_id)
            return None

        ext_id = extraction_id or job.extraction_id
        if not ext_id:
            logger.warning("job_match_no_extraction_id", job_id=job_id)
            return None

        job_text = await _get_job_text_from_cache_or_db(ext_id, extraction_repo)
        if not job_text:
            logger.warning("job_match_no_text_available", extraction_id=ext_id)
            return None

        profile_text = await user_repo.get_profile_openai_text(user_id)
        return ext_id, job_text, profile_text


async def enqueue_tailored_content_generation(
    job_id: str,
    user_id: str,
    extraction_id: str | None = None,
) -> bool:
    try:
        from app.tasks.worker import get_analysis_pool, ANALYSIS_QUEUE
        pool = await get_analysis_pool()
        try:
            await pool.enqueue_job(
                "generate_tailored_content",
                job_id,
                user_id,
                extraction_id,
            )
            logger.info(
                "tailored_content_enqueued",
                job_id=job_id,
                user_id=user_id,
                queue=ANALYSIS_QUEUE,
            )
            return True
        finally:
            await pool.close()
    except Exception as e:
        logger.warning(
            "tailored_content_enqueue_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
        return False


async def _enqueue_resume_doc_build(job_id: str, user_id: str) -> None:
    try:
        from app.tasks.worker import get_resume_build_pool
        pool = await get_resume_build_pool()
        await pool.enqueue_job("build_resume_task", job_id, user_id)
        await pool.close()
        logger.info("resume_build_enqueued", job_id=job_id)
    except Exception as enq_err:
        logger.warning("resume_build_enqueue_failed", job_id=job_id, error=str(enq_err))


async def run_job_match_analysis(
    job_id: str,
    user_id: str,
    *,
    extraction_id: str | None = None,
) -> dict | None:
    """Phase A: match scoring + structured job extraction.

    Returns the match result dict enriched with metadata the save task needs
    (should_run_phase_b, extraction_id, structured_company).  Match persistence,
    company policy, sheets posting, and tailored-content enqueue are handled
    downstream by the save_analyzed_job worker task.
    """
    bind_logging_context(job_id=job_id, user_id=user_id)
    settings = get_settings()
    ext_id: str | None = None
    is_job_posting = False
    has_profile = False

    try:
        loaded = await _load_job_and_profile(job_id, user_id, extraction_id)
        if not loaded:
            await clear_job_match_progress(job_id, user_id)
            return None
        ext_id, job_text, profile_text = loaded
        has_profile = bool((profile_text or "").strip())

        try:
            result, structured_job, is_job_posting = await analyze_job_match_phase_a(
                job_text, profile_text, user_id=user_id,
            )
        except Exception as e:
            logger.error(
                "job_match_phase_a_failed",
                job_id=job_id,
                user_id=user_id,
                error=str(e),
            )
            await clear_job_match_progress(job_id, user_id)
            return None

        async with get_session() as session:
            extraction_repo = JobExtractionRepository(session)

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
                        job_repo = JobRepository(session)
                        await job_repo.update_from_structured_extraction(job_id, structured_job)
                        logger.info(
                            "job_match_structured_content_updated",
                            job_id=job_id,
                            extraction_id=ext_id,
                        )
                    except Exception as struct_err:
                        logger.warning(
                            "job_match_structured_content_update_failed",
                            job_id=job_id,
                            extraction_id=ext_id,
                            error=str(struct_err),
                        )
                else:
                    logger.warning("job_match_no_structured_job_returned", job_id=job_id)
                    await extraction_repo.update_is_job_posting(ext_id, is_job_posting)

                try:
                    cache = ExtractionCache()
                    await cache.delete(ext_id)
                except Exception:
                    pass

                result["should_run_phase_b"] = (
                    settings.auto_generate_tailored_content
                    and has_profile
                    and is_job_posting
                )
                result["extraction_id"] = ext_id
                result["structured_company"] = structured_company

                logger.info(
                    "job_match_phase_a_complete",
                    job_id=job_id,
                    user_id=user_id,
                    score=result["overall_score"],
                    phase_b=result["should_run_phase_b"],
                )

                return result
            except Exception as e:
                logger.error(
                    "job_match_phase_a_persist_failed",
                    job_id=job_id,
                    user_id=user_id,
                    error=str(e),
                )
                return None
    except asyncio.CancelledError:
        await clear_job_match_progress(job_id, user_id)
        raise


async def run_tailored_content_generation(
    job_id: str,
    user_id: str,
    *,
    extraction_id: str | None = None,
) -> dict | None:
    """Phase B: tailored resume JSON + cover letter, then enqueue DOCX/PDF build."""
    bind_logging_context(job_id=job_id, user_id=user_id)

    try:
        loaded = await _load_job_and_profile(job_id, user_id, extraction_id)
        if not loaded:
            return None
        ext_id, job_text, profile_text = loaded

        if not (profile_text or "").strip():
            async with get_session() as session:
                resume_repo = ResumeBuildRepository(session)
                await resume_repo.mark_content_skipped(job_id, user_id)
            return None

        async with get_session() as session:
            resume_repo = ResumeBuildRepository(session)
            ext_repo = JobExtractionRepository(session)
            match_repo = JobMatchRepository(session)

            row = await resume_repo.get(job_id, user_id)
            if row and row.content_generation_status == "completed" and row.tailored_resume_data:
                logger.info("tailored_content_already_completed", job_id=job_id)
                if row.tailored_resume_data:
                    await _enqueue_resume_doc_build(job_id, user_id)
                return row.tailored_resume_data

            extraction = await ext_repo.get_by_id(ext_id)
            if extraction and extraction.is_job_posting is False:
                await resume_repo.mark_content_skipped(job_id, user_id)
                return None

            await resume_repo.mark_content_generating(job_id, user_id)

            structured_job: JobDescriptionSchema | None = None
            if extraction and extraction.description:
                structured_job = JobDescriptionSchema(
                    title=extraction.title or "Unknown Position",
                    company=extraction.company,
                    location=extraction.location,
                    employment_type=extraction.employment_type,
                    salary_range=extraction.salary_range,
                    description=extraction.description or "",
                    responsibilities=extraction.responsibilities or [],
                    requirements=extraction.requirements or [],
                    benefits=extraction.benefits or [],
                    remote_policy=extraction.remote_policy,
                    experience_level=extraction.experience_level,
                    industry=extraction.industry,
                )

            match_row = await match_repo.get(job_id, user_id)
            match_summary = (match_row.summary if match_row else None) or ""

        structured_context = build_structured_context(structured_job)

        try:
            tailored_resume, cover_letter = await generate_tailored_content_phase_b(
                job_text,
                profile_text,
                structured_context=structured_context,
                match_summary=match_summary,
                user_id=user_id,
            )
        except Exception as e:
            logger.error(
                "job_match_phase_b_failed",
                job_id=job_id,
                user_id=user_id,
                error=str(e),
            )
            async with get_session() as session:
                resume_repo = ResumeBuildRepository(session)
                await resume_repo.fail_content_generation(job_id, user_id, str(e))
            await publish_ws_event({
                "type": "tailored_content_failed",
                "user_id": user_id,
                "job_id": job_id,
                "error": str(e),
            })
            return None

        if not tailored_resume:
            async with get_session() as session:
                resume_repo = ResumeBuildRepository(session)
                await resume_repo.fail_content_generation(
                    job_id, user_id, "Tailored resume section missing or invalid"
                )
            return None

        async with get_session() as session:
            resume_repo = ResumeBuildRepository(session)
            await resume_repo.complete_content_generation(
                job_id,
                user_id,
                tailored_resume_data=tailored_resume,
                cover_letter_data=cover_letter,
            )

        await publish_ws_event({
            "type": "tailored_content_completed",
            "user_id": user_id,
            "job_id": job_id,
        })

        await _enqueue_resume_doc_build(job_id, user_id)
        logger.info("job_match_phase_b_stored", job_id=job_id, user_id=user_id)
        return tailored_resume
    except asyncio.CancelledError:
        raise
