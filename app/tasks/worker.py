import asyncio
import traceback
from arq import create_pool
from arq.connections import RedisSettings, ArqRedis
from app.core.config import get_settings
from app.core.logging import bind_logging_context, clear_logging_context, get_logger, new_request_id, set_request_id
from app.models.schemas import ExtractionStatus
from app.models.database import Job
from app.services.extraction_service import ExtractionService
from app.services.job_match_orchestrator import clear_job_match_progress
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, JobRepository, JobMatchInProgressRepository
from app.api.websocket import publish_ws_event

logger = get_logger(__name__)

EXTRACTION_QUEUE = "job_extraction"
ANALYSIS_QUEUE = "job_analysis"
RESUME_BUILD_QUEUE = "resume_build"
SCRAPER_QUEUE = "job_scraper_crawl"
SAVE_QUEUE = "job_save"


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


async def _hide_extraction_failure_for_user(
    extraction_id: str,
    user_id: str | None,
    error: str,
) -> None:
    if not user_id:
        return
    async with get_session() as session:
        from app.services.extraction_failure_handler import mark_extraction_failed_for_user

        job_repo = JobRepository(session)
        job = await job_repo.get_by_extraction_id(extraction_id)
        if job:
            await mark_extraction_failed_for_user(
                session,
                job_id=job.id,
                user_id=user_id,
                error=error,
            )
            await session.commit()


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
        service: ExtractionService = ctx.get("extraction_service") or ExtractionService()
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
                    job_repo = JobRepository(session)
                    job = await job_repo.get_by_extraction_id(job_id)
                    if job:
                        try:
                            progress_repo = JobMatchInProgressRepository(session)
                            await progress_repo.add(job.id, user_id)
                            await session.commit()
                            pending_match_progress = (job.id, user_id)
                            pool = await get_analysis_pool()
                            await pool.enqueue_job(
                                "analyze_job_match",
                                job.id,
                                user_id,
                                job_id,
                            )
                            logger.info("job_match_enqueued", valid_job_id=job.id, user_id=user_id, queue=ANALYSIS_QUEUE)
                            pending_match_progress = None
                        except Exception as enq_err:
                            await progress_repo.remove(job.id, user_id)
                            await session.commit()
                            pending_match_progress = None
                            logger.warning("job_match_enqueue_failed", valid_job_id=job.id, error=str(enq_err))

        elif result.get("status") == "failed":
            error_msg = result.get("error", "Unknown error")
            logger.error("extract_job_failed", job_id=job_id, url=url, error=error_msg)

            reason = error_msg
            if result.get("site_unreachable"):
                reason = f"Site unreachable — {error_msg[:200]}"

            if user_id:
                await _hide_extraction_failure_for_user(job_id, user_id, reason)

                await publish_ws_event({
                    "type": "extraction_failed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "url": url,
                    "error": reason,
                })
        return result
    except asyncio.CancelledError:
        await _mark_extraction_failed_cancelled(job_id)
        if pending_match_progress:
            await clear_job_match_progress(pending_match_progress[0], pending_match_progress[1])
        if user_id:
            await _hide_extraction_failure_for_user(job_id, user_id, "Cancelled or timed out")
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
            await _hide_extraction_failure_for_user(job_id, user_id, str(e))
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
            pool = await get_save_pool()
            await pool.enqueue_job("save_analyzed_job", valid_job_id, user_id, extraction_id, result)
        return result
    except asyncio.CancelledError:
        await clear_job_match_progress(valid_job_id, user_id)
        raise
    except Exception as e:
        logger.exception("worker_analyze_job_match_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
        await clear_job_match_progress(valid_job_id, user_id)
        return None
    finally:
        clear_logging_context()


async def save_analyzed_job(ctx: dict, job_id: str, user_id: str,
                            extraction_id: str | None, match_data: dict) -> dict | None:
    """Save analyzed job match result with per-user dedup lock.

    Uses an in-task wait loop for the Redis lock instead of arq Retry so that
    lock-contention does NOT consume max_tries (which would permanently drop
    jobs after 10 lock-busy retries).
    """
    from app.services.post_analysis_dedup import run_post_analysis_dedup

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="save_analyzed_job", job_id=job_id, user_id=user_id)
    logger.info("worker_save_analyzed_job_started", job_id=job_id, user_id=user_id)

    redis = ctx.get("redis")
    lock_key = f"job_save_lock:{user_id}"
    lock_ttl = 120

    if redis:
        max_wait = 90
        poll_interval = 1.5
        waited = 0.0
        while waited < max_wait:
            acquired = await redis.set(lock_key, "1", nx=True, ex=lock_ttl)
            if acquired:
                break
            logger.debug("save_lock_waiting", job_id=job_id, user_id=user_id, waited=round(waited, 1))
            await asyncio.sleep(poll_interval)
            waited += poll_interval
        else:
            logger.error("save_lock_timeout", job_id=job_id, user_id=user_id, waited=max_wait)
            await clear_job_match_progress(job_id, user_id)
            await publish_ws_event({
                "type": "match_failed",
                "user_id": user_id,
                "valid_job_id": job_id,
                "error": "Timed out waiting for save lock",
            })
            return None

    try:
        dedup_result = await run_post_analysis_dedup(
            job_id, user_id, match_data, extraction_id,
        )

        action = dedup_result.get("action", "saved_active")

        await clear_job_match_progress(job_id, user_id)

        await publish_ws_event({
            "type": "match_completed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "overall_score": match_data.get("overall_score"),
            "recommendation": match_data.get("recommendation"),
        })

        if action == "saved_duplicated":
            await publish_ws_event({
                "type": "job_excluded_for_user",
                "user_id": user_id,
                "valid_job_id": job_id,
                "exclusion_type": dedup_result.get("exclusion_type"),
                "reason": dedup_result.get("reason"),
            })

        if action == "saved_active" and match_data.get("should_run_phase_b"):
            try:
                pool = await get_analysis_pool()
                await pool.enqueue_job("generate_tailored_content", job_id, user_id, extraction_id)
            except Exception as e:
                logger.warning("tailored_content_enqueue_from_save_failed", job_id=job_id, error=str(e))

        logger.info("worker_save_analyzed_job_completed", job_id=job_id, action=action)
        return dedup_result
    except Exception as e:
        logger.exception("worker_save_analyzed_job_failed", job_id=job_id, error=str(e))
        await clear_job_match_progress(job_id, user_id)
        await publish_ws_event({
            "type": "match_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": str(e),
        })
        return None
    finally:
        if redis:
            await redis.delete(lock_key)
        clear_logging_context()


async def analyze_resume_template(ctx: dict, user_id: str, reason: str = "upload") -> None:
    from app.services.resume_template_service import run_template_analysis

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="analyze_resume_template", user_id=user_id)
    logger.info("worker_analyze_resume_template_started", user_id=user_id, reason=reason)
    try:
        await run_template_analysis(user_id, reason)
        logger.info("worker_analyze_resume_template_completed", user_id=user_id)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("worker_analyze_resume_template_failed", user_id=user_id, error=str(e))
    finally:
        clear_logging_context()


async def generate_tailored_content(
    ctx: dict,
    job_id: str,
    user_id: str,
    extraction_id: str | None = None,
) -> dict | None:
    from app.services.job_match_orchestrator import run_tailored_content_generation

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="generate_tailored_content", valid_job_id=job_id, user_id=user_id)
    logger.info("worker_generate_tailored_content_started", valid_job_id=job_id, user_id=user_id)

    await publish_ws_event({
        "type": "tailored_content_started",
        "user_id": user_id,
        "valid_job_id": job_id,
    })

    try:
        result = await run_tailored_content_generation(
            job_id, user_id, extraction_id=extraction_id
        )
        if result:
            logger.info("worker_generate_tailored_content_completed", valid_job_id=job_id)
        return result
    except asyncio.CancelledError:
        await publish_ws_event({
            "type": "tailored_content_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": "Cancelled or timed out",
        })
        raise
    except Exception as e:
        logger.exception(
            "worker_generate_tailored_content_failed",
            valid_job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
        await publish_ws_event({
            "type": "tailored_content_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": str(e),
        })
        return None
    finally:
        clear_logging_context()


async def build_resume_task(ctx: dict, job_id: str, user_id: str) -> dict | None:
    from app.services.resume_build_orchestrator import run_resume_build

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="build_resume", valid_job_id=job_id, user_id=user_id)
    logger.info("worker_build_resume_started", valid_job_id=job_id, user_id=user_id)

    await publish_ws_event({
        "type": "resume_build_started",
        "user_id": user_id,
        "valid_job_id": job_id,
    })

    try:
        result = await run_resume_build(job_id, user_id)
        if result:
            logger.info("worker_build_resume_completed", valid_job_id=job_id, files=list(result.keys()))
            await publish_ws_event({
                "type": "resume_build_completed",
                "user_id": user_id,
                "valid_job_id": job_id,
            })
        return result
    except asyncio.CancelledError:
        await publish_ws_event({
            "type": "resume_build_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": "Cancelled or timed out",
        })
        raise
    except Exception as e:
        logger.exception("worker_build_resume_failed", valid_job_id=job_id, user_id=user_id, error=str(e))
        await publish_ws_event({
            "type": "resume_build_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": str(e),
        })
        return None
    finally:
        clear_logging_context()


async def _promote_and_publish(
    spider_name: str,
    scrape_run_id: str | None,
    user_id: str | None,
) -> dict | None:
    """Bridge scraped_jobs -> JobExtraction + Job and enqueue extraction.
    Publishes a single `scrape_promoted` WS event with the stats.  Returns
    the stats dict, or None when there's nothing to promote.
    """
    if not scrape_run_id:
        logger.warning(
            "scrape_promote_skipped_no_run_id",
            spider_name=spider_name,
        )
        return None
    try:
        from app.services.scrape_promoter import promote_scrape_run
        stats = await promote_scrape_run(scrape_run_id, user_id=user_id)
    except Exception as e:
        logger.exception(
            "scrape_promote_failed",
            spider_name=spider_name,
            scrape_run_id=scrape_run_id,
            error=str(e),
        )
        return None

    if user_id:
        await publish_ws_event({
            "type": "scrape_promoted",
            "user_id": user_id,
            "spider_name": spider_name,
            "stats": stats,
        })
    return stats


async def run_scraper_task(
    ctx: dict,
    spider_name: str,
    user_id: str,
    sync_mode: str = "incremental",
    posted_since: str | None = None,
    posted_until: str | None = None,
    spider_names: list[str] | None = None,
) -> dict:
    """arq task: run a spider (or all) and publish progress via WebSocket.

    After each spider finishes its scrape_runs row, the freshly written
    ``scraped_jobs`` rows are bridged into the extraction lifecycle via
    ``scrape_promoter.promote_scrape_run`` — they become ``JobExtraction``
    (PENDING) + ``Job`` rows and ``extract_job`` is enqueued on the
    extraction queue.  From that point on, scraped jobs flow through the
    same pipeline as manually submitted URLs.
    """
    from datetime import date

    from app.scraper.runner import check_spider_auth, run_spiders_from_plan
    from app.services.scraper_sync_service import build_run_plan

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="run_scraper", spider_name=spider_name, user_id=user_id)

    since = date.fromisoformat(posted_since) if posted_since else None
    until = date.fromisoformat(posted_until) if posted_until else None
    try:
        plan = build_run_plan(
            spider_name=spider_name,
            spider_names=spider_names,
            sync_mode=sync_mode,  # type: ignore[arg-type]
            posted_since=since,
            posted_until=until,
        )
    except ValueError as e:
        logger.error("worker_scraper_invalid_plan", error=str(e))
        return {"spider": spider_name, "success": False, "error": str(e)}

    for name, _kwargs in plan:
        auth_check = check_spider_auth(name)
        if auth_check["requires_auth"] and not auth_check["ok"]:
            cmd = auth_check["auth_setup_command"]
            message = f"Spider '{name}' requires authentication. Run: {cmd}"
            logger.error("worker_scraper_auth_required", spider_name=name)
            return {
                "spider": spider_name,
                "success": False,
                "error": "auth_required",
                "message": message,
            }

    logger.info(
        "worker_scraper_started",
        spider_name=spider_name,
        sync_mode=sync_mode,
        platform_count=len(plan),
        platforms=[name for name, _ in plan],
    )

    await publish_ws_event({
        "type": "sync_started",
        "user_id": user_id,
        "spider_name": spider_name,
        "sync_mode": sync_mode,
        "total": len(plan),
        "platforms": [name for name, _ in plan],
    })

    try:
        promotions: dict[str, dict | None] = {}

        async def publish_spider_activity(stats: dict) -> None:
            await publish_ws_event({
                "type": "sync_activity",
                "user_id": user_id,
                "spider_name": stats.get("spider_name"),
                "items_scraped": stats.get("items_scraped", 0),
                "items_new": stats.get("items_new", 0),
                "items_updated": stats.get("items_updated", 0),
                "elapsed_seconds": stats.get("elapsed_seconds", 0),
            })

        async def on_spider_start(name: str, index: int, total: int) -> None:
            logger.info(
                "worker_scraper_spider_start",
                spider_name=name,
                current=index,
                total=total,
            )
            await publish_ws_event({
                "type": "sync_spider_started",
                "user_id": user_id,
                "spider_name": name,
                "current": index,
                "total": total,
            })

        async def on_progress(name, index, total, result):
            await publish_ws_event({
                "type": "sync_progress",
                "user_id": user_id,
                "spider_name": name,
                "current": index,
                "total": total,
                "success": result.get("success", False),
            })
            if result.get("success"):
                promotions[name] = await _promote_and_publish(
                    spider_name=name,
                    scrape_run_id=result.get("scrape_run_id"),
                    user_id=user_id,
                )

        results = await run_spiders_from_plan(
            plan,
            on_progress=on_progress,
            on_spider_start=on_spider_start,
            spider_progress_callback=publish_spider_activity,
        )
        if len(plan) == 1:
            summary = dict(results[0])
            summary["promotion"] = promotions.get(plan[0][0])
        else:
            summary = {
                "spider": spider_name,
                "sync_mode": sync_mode,
                "total": len(results),
                "succeeded": sum(1 for r in results if r.get("success")),
                "failed": sum(1 for r in results if not r.get("success")),
                "results": results,
            }

        await publish_ws_event({
            "type": "sync_completed",
            "user_id": user_id,
            "spider_name": spider_name,
            "summary": summary,
        })

        logger.info("worker_scraper_completed", spider_name=spider_name)
        return summary

    except asyncio.CancelledError:
        await publish_ws_event({
            "type": "sync_failed",
            "user_id": user_id,
            "spider_name": spider_name,
            "error": "Cancelled or timed out",
        })
        raise
    except Exception as e:
        logger.exception("worker_scraper_failed", spider_name=spider_name, error=str(e))
        await publish_ws_event({
            "type": "sync_failed",
            "user_id": user_id,
            "spider_name": spider_name,
            "error": str(e),
        })
        return {"spider": spider_name, "success": False, "error": str(e)}
    finally:
        clear_logging_context()


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


async def _flush_langfuse(ctx: dict) -> None:
    """Flush pending Langfuse traces before the worker shuts down."""
    try:
        from langfuse import get_client
        get_client().flush()
    except Exception:
        pass


async def _extraction_worker_startup(ctx: dict) -> None:
    """Pre-create a singleton ExtractionService for reuse across jobs."""
    ctx["extraction_service"] = ExtractionService()
    from app.services.extraction_cache import init_redis_pool
    await init_redis_pool()


class ExtractionWorkerSettings:
    """arq settings for the extraction pipeline (I/O-heavy: HTTP + Playwright)."""
    functions = [extract_job]
    redis_settings = _redis_settings
    queue_name = EXTRACTION_QUEUE
    job_timeout = 300
    max_tries = 1
    on_startup = _extraction_worker_startup
    on_shutdown = _flush_langfuse


async def _analysis_worker_startup(ctx: dict) -> None:
    from app.services.extraction_cache import init_redis_pool
    await init_redis_pool()


class AnalysisWorkerSettings:
    """arq settings for the AI match analysis pipeline (API-heavy: OpenAI)."""
    functions = [analyze_job_match, generate_tailored_content, analyze_resume_template]
    redis_settings = _redis_settings
    queue_name = ANALYSIS_QUEUE
    job_timeout = 360
    max_jobs = get_settings().analysis_worker_max_jobs
    max_tries = 1
    on_startup = _analysis_worker_startup
    on_shutdown = _flush_langfuse


class SaveWorkerSettings:
    """arq settings for the sequential job save pipeline (per-user lock)."""
    functions = [save_analyzed_job]
    redis_settings = _redis_settings
    queue_name = SAVE_QUEUE
    job_timeout = 120
    max_tries = 1
    on_shutdown = _flush_langfuse


class ResumeBuildWorkerSettings:
    """arq settings for the resume/cover letter document builder."""
    functions = [build_resume_task]
    redis_settings = _redis_settings
    queue_name = RESUME_BUILD_QUEUE
    job_timeout = 180
    max_tries = 1
    on_shutdown = _flush_langfuse


# ── Shared long-lived arq pools (one per queue, lazily created) ──────────────
_shared_pools: dict[str, ArqRedis] = {}


async def _get_shared_pool(queue: str) -> ArqRedis:
    """Return a long-lived ArqRedis pool for *queue*, creating it on first use.

    Callers must NOT close the returned pool — it is shared across the process.
    """
    pool = _shared_pools.get(queue)
    if pool is not None:
        try:
            await pool.ping()
            return pool
        except Exception:
            _shared_pools.pop(queue, None)
    pool = await create_pool(_redis_settings(), default_queue_name=queue)
    _shared_pools[queue] = pool
    return pool


async def close_shared_pools() -> None:
    """Gracefully close all shared arq pools (call at shutdown)."""
    for q, pool in list(_shared_pools.items()):
        try:
            await pool.close()
        except Exception:
            pass
    _shared_pools.clear()


async def get_extraction_pool() -> ArqRedis:
    return await _get_shared_pool(EXTRACTION_QUEUE)


async def get_analysis_pool() -> ArqRedis:
    return await _get_shared_pool(ANALYSIS_QUEUE)


async def get_save_pool() -> ArqRedis:
    return await _get_shared_pool(SAVE_QUEUE)


async def get_resume_build_pool() -> ArqRedis:
    return await _get_shared_pool(RESUME_BUILD_QUEUE)


async def get_scraper_pool() -> ArqRedis:
    return await _get_shared_pool(SCRAPER_QUEUE)


class ScraperWorkerSettings:
    """arq settings for the scraper crawl pipeline (subprocess-based Scrapy)."""
    functions = [run_scraper_task]
    redis_settings = _redis_settings
    queue_name = SCRAPER_QUEUE
    job_timeout = 3600
    max_tries = 1
