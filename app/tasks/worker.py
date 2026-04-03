import asyncio
import traceback
from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
from app.core.config import get_settings
from app.core.logging import bind_logging_context, clear_logging_context, get_logger, new_request_id, set_request_id
from app.models.schemas import ExtractionStatus
from app.services.extraction_service import ExtractionService
from app.services.job_match_orchestrator import clear_job_match_progress
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, ValidJobRepository, JobMatchInProgressRepository
from app.api.websocket import publish_ws_event

logger = get_logger(__name__)


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
        if result.get("status") == "completed":
            confidence = result.get("confidence", 1.0)
            logger.info(
                "worker_extract_job_completed",
                job_id=job_id,
                method=result.get("method"),
                confidence=confidence,
            )
            if user_id:
                await publish_ws_event({
                    "type": "extraction_completed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "url": url,
                    "method": result.get("method"),
                    "confidence": confidence,
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
                            pool = await get_redis_pool()
                            await pool.enqueue_job("analyze_job_match", valid_job.id, user_id)
                            await pool.close()
                            logger.info("job_match_enqueued", valid_job_id=valid_job.id, user_id=user_id)
                            pending_match_progress = None
                        except Exception as enq_err:
                            await progress_repo.remove(valid_job.id, user_id)
                            await session.commit()
                            pending_match_progress = None
                            logger.warning("job_match_enqueue_failed", valid_job_id=valid_job.id, error=str(enq_err))
        elif result.get("status") == "failed":
            logger.error(
                "extract_job_failed",
                job_id=job_id,
                url=url,
                error=result.get("error", "Unknown error"),
            )
            if user_id:
                await publish_ws_event({
                    "type": "extraction_failed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "url": url,
                    "error": result.get("error"),
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


async def analyze_job_match(ctx: dict, valid_job_id: str, user_id: str) -> dict | None:
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
        result = await run_job_match_analysis(valid_job_id, user_id)
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


class WorkerSettings:
    functions = [extract_job, analyze_job_match]

    @staticmethod
    def redis_settings() -> RedisSettings:
        settings = get_settings()
        return RedisSettings.from_dsn(settings.redis_url)

    job_timeout = 300
    max_tries = 1
    queue_name = "job_extraction"


async def get_redis_pool() -> ArqRedis:
    settings = get_settings()
    return await create_pool(
        RedisSettings.from_dsn(settings.redis_url),
        default_queue_name=WorkerSettings.queue_name,
    )
