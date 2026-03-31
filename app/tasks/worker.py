import traceback
from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
from app.core.config import get_settings
from app.core.logging import bind_logging_context, clear_logging_context, get_logger, new_request_id, set_request_id
from app.services.extraction_service import ExtractionService
from app.storage.database import get_session
from app.storage.repository import ValidJobRepository, JobMatchInProgressRepository, JobExtractionRepository
from app.models.schemas import ExtractionStatus

logger = get_logger(__name__)


async def extract_job(ctx: dict, job_id: str, url: str, user_id: str | None = None) -> dict:
    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="extract_job", extraction_id=job_id, target_url=url, user_id=user_id)
    logger.info("worker_extract_job_started", job_id=job_id, url=url)
    try:
        service = ExtractionService()
        result = await service.process_job(job_id, url)
        if result.get("status") == "completed":
            confidence = result.get("confidence", 1.0)
            LOW_CONFIDENCE_THRESHOLD = 0.6
            MAX_LOW_CONFIDENCE_RETRIES = 3

            if confidence < LOW_CONFIDENCE_THRESHOLD:
                async with get_session() as session:
                    extraction_repo = JobExtractionRepository(session)
                    extraction = await extraction_repo.get_by_id(job_id)
                    retry_count = extraction.retry_count or 0

                    if retry_count < MAX_LOW_CONFIDENCE_RETRIES:
                        await extraction_repo.increment_retry(job_id)
                        await extraction_repo.update_status(job_id, ExtractionStatus.PENDING)
                        await session.commit()

                        # Re-enqueue extraction to retry
                        pool = await get_redis_pool()
                        await pool.enqueue_job("extract_job", job_id, url, user_id) if user_id else await pool.enqueue_job("extract_job", job_id, url)
                        await pool.close()

                        logger.info(
                            "worker_extract_job_requeued_low_confidence",
                            job_id=job_id,
                            url=url,
                            confidence=confidence,
                            retry_count=retry_count + 1,
                        )
                        return {"job_id": job_id, "status": "requeued", "confidence": confidence}

            logger.info(
                "worker_extract_job_completed",
                job_id=job_id,
                method=result.get("method"),
                confidence=confidence,
            )
            # Enqueue job match analysis for user who triggered extraction
            if user_id:
                async with get_session() as session:
                    valid_repo = ValidJobRepository(session)
                    valid_job = await valid_repo.get_by_extraction_id(job_id)
                    if valid_job:
                        try:
                            progress_repo = JobMatchInProgressRepository(session)
                            await progress_repo.add(valid_job.id, user_id)
                            await session.commit()
                            pool = await get_redis_pool()
                            await pool.enqueue_job("analyze_job_match", valid_job.id, user_id)
                            await pool.close()
                            logger.info("job_match_enqueued", valid_job_id=valid_job.id, user_id=user_id)
                        except Exception as enq_err:
                            await progress_repo.remove(valid_job.id, user_id)
                            await session.commit()
                            logger.warning("job_match_enqueue_failed", valid_job_id=valid_job.id, error=str(enq_err))
        elif result.get("status") == "failed":
            logger.error(
                "extract_job_failed",
                job_id=job_id,
                url=url,
                error=result.get("error", "Unknown error"),
            )
        return result
    except Exception as e:
        tb = traceback.format_exc()
        logger.exception(
            "extract_job_exception",
            job_id=job_id,
            url=url,
            error=str(e),
            traceback=tb,
        )
        raise
    finally:
        clear_logging_context()


async def analyze_job_match(ctx: dict, valid_job_id: str, user_id: str) -> dict | None:
    """AI job–profile match analysis. Runs async after extraction completes."""
    from app.services.job_match_orchestrator import run_job_match_analysis

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="analyze_job_match", valid_job_id=valid_job_id, user_id=user_id)
    logger.info("worker_analyze_job_match_started", valid_job_id=valid_job_id, user_id=user_id)
    try:
        result = await run_job_match_analysis(valid_job_id, user_id)
        if result:
            logger.info("worker_analyze_job_match_completed", valid_job_id=valid_job_id, score=result.get("overall_score"))
        return result
    except Exception as e:
        logger.exception("worker_analyze_job_match_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
        raise
    finally:
        clear_logging_context()


class WorkerSettings:
    functions = [extract_job, analyze_job_match]

    @staticmethod
    def redis_settings() -> RedisSettings:
        settings = get_settings()
        return RedisSettings.from_dsn(settings.redis_url)

    job_timeout = 300
    max_tries = 3
    queue_name = "job_extraction"


async def get_redis_pool() -> ArqRedis:
    """Create Redis pool with queue_name matching WorkerSettings.queue_name."""
    settings = get_settings()
    return await create_pool(
        RedisSettings.from_dsn(settings.redis_url),
        default_queue_name=WorkerSettings.queue_name,
    )
