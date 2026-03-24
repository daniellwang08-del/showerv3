import traceback
from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.extraction_service import ExtractionService
from app.storage.database import get_session
from app.storage.repository import ValidJobRepository, JobMatchInProgressRepository

logger = get_logger(__name__)


async def extract_job(ctx: dict, job_id: str, url: str, user_id: str | None = None) -> dict:
    logger.info("worker_extract_job_started", job_id=job_id, url=url)
    try:
        service = ExtractionService()
        result = await service.process_job(job_id, url)
        if result.get("status") == "completed":
            logger.info(
                "worker_extract_job_completed",
                job_id=job_id,
                method=result.get("method"),
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


async def analyze_job_match(ctx: dict, valid_job_id: str, user_id: str) -> dict | None:
    """AI job–profile match analysis. Runs async after extraction completes."""
    from app.services.job_match_orchestrator import run_job_match_analysis

    logger.info("worker_analyze_job_match_started", valid_job_id=valid_job_id, user_id=user_id)
    try:
        result = await run_job_match_analysis(valid_job_id, user_id)
        if result:
            logger.info("worker_analyze_job_match_completed", valid_job_id=valid_job_id, score=result.get("overall_score"))
        return result
    except Exception as e:
        logger.exception("worker_analyze_job_match_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
        raise


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
