import asyncio
import traceback
from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from app.core.config import get_settings
from app.core.logging import bind_logging_context, clear_logging_context, get_logger, new_request_id, set_request_id
from app.models.schemas import ExtractionStatus
from app.models.database import ValidJob, InvalidJob
from app.services.extraction_service import ExtractionService
from app.services.job_match_orchestrator import clear_job_match_progress
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, ValidJobRepository, JobMatchInProgressRepository
from app.api.websocket import publish_ws_event

logger = get_logger(__name__)

EXTRACTION_QUEUE = "job_extraction"
ANALYSIS_QUEUE = "job_analysis"
RESUME_BUILD_QUEUE = "resume_build"


async def _move_valid_job_to_invalid(extraction_id: str, reason: str, user_id: str | None) -> str | None:
    """Move the valid job linked to this extraction to invalid_jobs. Returns invalid_job.id or None."""
    try:
        async with get_session() as session:
            valid_repo = ValidJobRepository(session)
            valid_job = await valid_repo.get_by_extraction_id(extraction_id)
            if not valid_job or not valid_job.is_active:
                return None

            invalid_job = InvalidJob(
                source_url=valid_job.source_url,
                normalized_url=valid_job.normalized_url,
                domain=valid_job.domain,
                title=valid_job.title,
                company=valid_job.company,
                location=valid_job.location,
                description=valid_job.description,
                posted_date=valid_job.posted_date,
                experience_level=valid_job.experience_level,
                industry=valid_job.industry,
                duplicate_of_job_id=None,
                duplication_reason=reason,
                similarity_score=None,
                similarity_hash=valid_job.similarity_hash,
                raw_metadata=valid_job.raw_metadata or {},
                is_active=True,
            )
            valid_job.is_active = False
            session.add(invalid_job)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return None

            logger.info(
                "extraction_site_unreachable_moved_to_invalid",
                extraction_id=extraction_id,
                valid_job_id=valid_job.id,
                invalid_job_id=invalid_job.id,
                reason=reason,
            )
            if user_id:
                await publish_ws_event({
                    "type": "extraction_failed",
                    "user_id": user_id,
                    "job_id": extraction_id,
                    "url": valid_job.source_url,
                    "error": reason,
                })
            return invalid_job.id
    except Exception as e:
        logger.warning("move_to_invalid_failed", extraction_id=extraction_id, error=str(e))
        return None


async def _mark_extraction_failed_cancelled(job_id: str) -> None:
    try:
        async with get_session() as session:
            repo = JobExtractionRepository(session)
            row = await repo.get_by_id(job_id)
            if not row or row.status not in (
                ExtractionStatus.PENDING,
                ExtractionStatus.PROCESSING,
            ):
                return
            await repo.update_status(
                job_id,
                ExtractionStatus.FAILED,
                "Worker cancelled or timed out (exceeded job time limit)",
            )
    except Exception as e:
        logger.warning("extraction_cancel_cleanup_failed", job_id=job_id, error=str(e))


async def extract_job(ctx: dict, job_id: str, url: str, user_id: str | None = None) -> dict:
    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="extract_job", extraction_id=job_id, target_url=url, user_id=user_id)
    logger.info("worker_extract_job_started", job_id=job_id, url=url)

    if user_id:
        await publish_ws_event({
            "type": "extraction_started",
            "user_id": user_id,
            "job_id": job_id,
            "url": url,
        })

    pending_match_progress: tuple[str, str] | None = None
    try:
        service = ExtractionService()
        result = await service.process_job(job_id, url)

        if result.get("status") == "extracted":
            method = result.get("method")
            content_length = result.get("content_length", 0)
            logger.info(
                "worker_extract_job_extracted",
                job_id=job_id,
                method=method,
                content_length=content_length,
            )
            if user_id:
                await publish_ws_event({
                    "type": "extraction_completed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "url": url,
                    "method": method,
                })

            if user_id:
                async with get_session() as session:
                    valid_repo = ValidJobRepository(session)
                    valid_job = await valid_repo.get_by_extraction_id(job_id)
                    if valid_job:
                        try:
                            progress_repo = JobMatchInProgressRepository(session)
                            await progress_repo.add(valid_job.id, user_id)
                            await session.commit()
                            pending_match_progress = (valid_job.id, user_id)
                            pool = await get_analysis_pool()
                            await pool.enqueue_job(
                                "analyze_job_match",
                                valid_job.id,
                                user_id,
                                job_id,
                            )
                            await pool.close()
                            logger.info("job_match_enqueued", valid_job_id=valid_job.id, user_id=user_id, queue=ANALYSIS_QUEUE)
                            pending_match_progress = None
                        except Exception as enq_err:
                            await progress_repo.remove(valid_job.id, user_id)
                            await session.commit()
                            pending_match_progress = None
                            logger.warning("job_match_enqueue_failed", valid_job_id=valid_job.id, error=str(enq_err))

        elif result.get("status") == "failed":
            error_msg = result.get("error", "Unknown error")
            logger.error("extract_job_failed", job_id=job_id, url=url, error=error_msg)

            if result.get("site_unreachable"):
                await _move_valid_job_to_invalid(
                    job_id,
                    reason=f"Site unreachable — {error_msg[:200]}",
                    user_id=user_id,
                )
            elif user_id:
                await publish_ws_event({
                    "type": "extraction_failed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "url": url,
                    "error": error_msg,
                })
        return result
    except asyncio.CancelledError:
        await _mark_extraction_failed_cancelled(job_id)
        if pending_match_progress:
            await clear_job_match_progress(pending_match_progress[0], pending_match_progress[1])
        if user_id:
            await publish_ws_event({
                "type": "extraction_failed",
                "user_id": user_id,
                "job_id": job_id,
                "url": url,
                "error": "Cancelled or timed out",
            })
        raise
    except Exception as e:
        tb = traceback.format_exc()
        logger.exception(
            "extract_job_exception",
            job_id=job_id,
            url=url,
            error=str(e),
            traceback=tb,
        )
        if user_id:
            await publish_ws_event({
                "type": "extraction_failed",
                "user_id": user_id,
                "job_id": job_id,
                "url": url,
                "error": str(e),
            })
        return {"job_id": job_id, "status": "failed", "error": str(e)}
    finally:
        clear_logging_context()


async def analyze_job_match(ctx: dict, valid_job_id: str, user_id: str, extraction_id: str | None = None) -> dict | None:
    from app.services.job_match_orchestrator import run_job_match_analysis

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="analyze_job_match", valid_job_id=valid_job_id, user_id=user_id)
    logger.info("worker_analyze_job_match_started", valid_job_id=valid_job_id, user_id=user_id)

    await publish_ws_event({
        "type": "match_started",
        "user_id": user_id,
        "valid_job_id": valid_job_id,
    })

    try:
        result = await run_job_match_analysis(valid_job_id, user_id, extraction_id=extraction_id)
        if result:
            logger.info("worker_analyze_job_match_completed", valid_job_id=valid_job_id, score=result.get("overall_score"))
            await publish_ws_event({
                "type": "match_completed",
                "user_id": user_id,
                "valid_job_id": valid_job_id,
                "overall_score": result.get("overall_score"),
                "recommendation": result.get("recommendation"),
            })
        return result
    except asyncio.CancelledError:
        await clear_job_match_progress(valid_job_id, user_id)
        await publish_ws_event({
            "type": "match_failed",
            "user_id": user_id,
            "valid_job_id": valid_job_id,
            "error": "Cancelled or timed out",
        })
        raise
    except Exception as e:
        logger.exception("worker_analyze_job_match_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
        await clear_job_match_progress(valid_job_id, user_id)
        await publish_ws_event({
            "type": "match_failed",
            "user_id": user_id,
            "valid_job_id": valid_job_id,
            "error": str(e),
        })
        return None
    finally:
        clear_logging_context()


async def build_resume_task(ctx: dict, valid_job_id: str, user_id: str) -> dict | None:
    from app.services.resume_build_orchestrator import run_resume_build

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="build_resume", valid_job_id=valid_job_id, user_id=user_id)
    logger.info("worker_build_resume_started", valid_job_id=valid_job_id, user_id=user_id)

    await publish_ws_event({
        "type": "resume_build_started",
        "user_id": user_id,
        "valid_job_id": valid_job_id,
    })

    try:
        result = await run_resume_build(valid_job_id, user_id)
        if result:
            logger.info("worker_build_resume_completed", valid_job_id=valid_job_id, files=list(result.keys()))
            await publish_ws_event({
                "type": "resume_build_completed",
                "user_id": user_id,
                "valid_job_id": valid_job_id,
            })
        return result
    except asyncio.CancelledError:
        await publish_ws_event({
            "type": "resume_build_failed",
            "user_id": user_id,
            "valid_job_id": valid_job_id,
            "error": "Cancelled or timed out",
        })
        raise
    except Exception as e:
        logger.exception("worker_build_resume_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
        await publish_ws_event({
            "type": "resume_build_failed",
            "user_id": user_id,
            "valid_job_id": valid_job_id,
            "error": str(e),
        })
        return None
    finally:
        clear_logging_context()


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class ExtractionWorkerSettings:
    """arq settings for the extraction pipeline (I/O-heavy: HTTP + Playwright)."""
    functions = [extract_job]
    redis_settings = _redis_settings
    queue_name = EXTRACTION_QUEUE
    job_timeout = 300
    max_tries = 1


class AnalysisWorkerSettings:
    """arq settings for the AI match analysis pipeline (API-heavy: OpenAI)."""
    functions = [analyze_job_match]
    redis_settings = _redis_settings
    queue_name = ANALYSIS_QUEUE
    job_timeout = 120
    max_tries = 1


class ResumeBuildWorkerSettings:
    """arq settings for the resume/cover letter document builder."""
    functions = [build_resume_task]
    redis_settings = _redis_settings
    queue_name = RESUME_BUILD_QUEUE
    job_timeout = 180
    max_tries = 1


async def get_extraction_pool() -> ArqRedis:
    return await create_pool(
        _redis_settings(),
        default_queue_name=EXTRACTION_QUEUE,
    )


async def get_analysis_pool() -> ArqRedis:
    return await create_pool(
        _redis_settings(),
        default_queue_name=ANALYSIS_QUEUE,
    )


async def get_resume_build_pool() -> ArqRedis:
    return await create_pool(
        _redis_settings(),
        default_queue_name=RESUME_BUILD_QUEUE,
    )
