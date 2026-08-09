import asyncio
import traceback
from arq import create_pool, cron, func
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
TAILORING_QUEUE = "job_tailoring"
RESUME_BUILD_QUEUE = "resume_build"
SCRAPER_QUEUE = "job_scraper_crawl"
SAVE_QUEUE = "job_save"
AUTOPOST_QUEUE = "job_autopost"

# Per-user save lock: defer instead of sleeping so waiters do not occupy max_jobs.
# Never abandon a completed analysis — keep deferring until the lock is free.
SAVE_LOCK_POLL_SECONDS = 1.5
# Soft log threshold only (not a hard give-up). Kept for metrics/tests.
SAVE_LOCK_MAX_WAIT_SECONDS = 90
SAVE_LOCK_MAX_ATTEMPTS = int(SAVE_LOCK_MAX_WAIT_SECONDS / SAVE_LOCK_POLL_SECONDS)
# Lock must outlive a slow dedup; refresh is not needed if TTL is generous.
SAVE_LOCK_TTL_SECONDS = 300


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


async def _skip_linkedin_extraction(
    extraction_id: str,
    url: str,
    user_id: str | None,
) -> dict:
    from app.models.schemas import ExtractionStatus
    from app.services.linkedin_job_filter import (
        LINKEDIN_JOB_BLOCK_REASON,
        mark_linkedin_job_excluded_for_user,
    )

    async with get_session() as session:
        repo = JobExtractionRepository(session)
        await repo.update_status(
            extraction_id,
            ExtractionStatus.FAILED,
            LINKEDIN_JOB_BLOCK_REASON,
        )
        if user_id:
            job_repo = JobRepository(session)
            job = await job_repo.get_by_extraction_id(extraction_id)
            if job:
                await mark_linkedin_job_excluded_for_user(
                    session,
                    job_id=job.id,
                    user_id=user_id,
                )
        await session.commit()

    if user_id:
        await publish_ws_event({
            "type": "extraction_failed",
            "user_id": user_id,
            "job_id": extraction_id,
            "url": url,
            "error": LINKEDIN_JOB_BLOCK_REASON,
        })

    logger.info(
        "extract_job_linkedin_skipped",
        extraction_id=extraction_id,
        url=url,
        user_id=user_id,
    )
    return {
        "status": "skipped",
        "reason": "linkedin_job",
        "error": LINKEDIN_JOB_BLOCK_REASON,
    }


async def extract_job(
    ctx: dict,
    job_id: str,
    url: str,
    user_id: str | None = None,
    skip_phase_b: bool = False,
    chain_analysis: bool = True,
) -> dict:
    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="extract_job", extraction_id=job_id, target_url=url, user_id=user_id)
    logger.info(
        "worker_extract_job_started",
        job_id=job_id,
        url=url,
        skip_phase_b=bool(skip_phase_b),
        chain_analysis=bool(chain_analysis),
    )

    from app.services.linkedin_job_filter import is_linkedin_job_url

    if is_linkedin_job_url(url):
        return await _skip_linkedin_extraction(job_id, url, user_id)

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
            # Platform / admin extract-only leaves status at EXTRACTED (shared raw JD
            # ready). COMPLETED is reserved for Phase A structuring — never promote
            # scrape-only rows here or the Jobs dots treat structuring as done.
            if user_id:
                await publish_ws_event({
                    "type": "extraction_completed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "url": url,
                    "method": method,
                })

                if chain_analysis:
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
                                from app.core.redis_support import pipeline_job_id

                                await pool.enqueue_job(
                                    "analyze_job_match",
                                    job.id,
                                    user_id,
                                    job_id,
                                    bool(skip_phase_b),
                                    _job_id=pipeline_job_id("analyze", job.id, user_id),
                                )
                                logger.info(
                                    "job_match_enqueued",
                                    valid_job_id=job.id,
                                    user_id=user_id,
                                    queue=ANALYSIS_QUEUE,
                                    skip_phase_b=bool(skip_phase_b),
                                )
                                pending_match_progress = None
                            except Exception as enq_err:
                                await progress_repo.remove(job.id, user_id)
                                await session.commit()
                                pending_match_progress = None
                                logger.warning("job_match_enqueue_failed", valid_job_id=job.id, error=str(enq_err))
            else:
                # Shared inventory extract finished — fan-out auto-prepare for opted-in users.
                try:
                    async with get_session() as session:
                        job_repo = JobRepository(session)
                        job = await job_repo.get_by_extraction_id(job_id)
                        valid_job_id = job.id if job else None
                    if valid_job_id:
                        from app.services.auto_prepare_service import fanout_auto_prepare_for_job

                        fanout = await fanout_auto_prepare_for_job(
                            valid_job_id,
                            extraction_id=job_id,
                        )
                        logger.info(
                            "auto_prepare_fanout_after_extract",
                            extraction_id=job_id,
                            **{k: fanout.get(k) for k in ("job_id", "enqueued", "skipped", "users")},
                        )
                except Exception as fanout_err:
                    logger.warning(
                        "auto_prepare_fanout_failed",
                        extraction_id=job_id,
                        error=str(fanout_err),
                    )

        elif result.get("status") == "failed":
            error_msg = result.get("error", "Unknown error")
            logger.error("extract_job_failed", job_id=job_id, url=url, error=error_msg)

            reason = error_msg
            if result.get("site_unreachable"):
                reason = f"Site unreachable - {error_msg[:200]}"

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


async def analyze_job_match(
    ctx: dict,
    valid_job_id: str,
    user_id: str,
    extraction_id: str | None = None,
    skip_phase_b: bool = False,
) -> dict | None:
    from app.services.job_match_orchestrator import run_job_match_analysis

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="analyze_job_match", valid_job_id=valid_job_id, user_id=user_id)
    logger.info(
        "worker_analyze_job_match_started",
        valid_job_id=valid_job_id,
        user_id=user_id,
        skip_phase_b=bool(skip_phase_b),
    )

    await publish_ws_event({
        "type": "match_started",
        "user_id": user_id,
        "valid_job_id": valid_job_id,
    })

    try:
        result = await run_job_match_analysis(
            valid_job_id,
            user_id,
            extraction_id=extraction_id,
            skip_phase_b=bool(skip_phase_b),
        )
        if result:
            logger.info("worker_analyze_job_match_completed", valid_job_id=valid_job_id, score=result.get("overall_score"))
            pool = await get_save_pool()
            from app.core.redis_support import pipeline_job_id
            import uuid

            # Prefer stable id; on collision (prior save still queued) use a unique
            # id so completed match_data is never silently dropped.
            arq_id = pipeline_job_id("save", valid_job_id, user_id)
            job = await pool.enqueue_job(
                "save_analyzed_job",
                valid_job_id,
                user_id,
                extraction_id,
                result,
                _job_id=arq_id,
            )
            if job is None:
                retry_id = pipeline_job_id(
                    "save", valid_job_id, user_id, f"r{uuid.uuid4().hex[:10]}"
                )
                job = await pool.enqueue_job(
                    "save_analyzed_job",
                    valid_job_id,
                    user_id,
                    extraction_id,
                    result,
                    _job_id=retry_id,
                )
                logger.info(
                    "worker_save_enqueued_unique_retry",
                    valid_job_id=valid_job_id,
                    user_id=user_id,
                    arq_job_id=retry_id,
                    already_queued=job is None,
                )
            if job is None:
                # Last resort: persist in-process so LLM output is never dropped.
                logger.warning(
                    "worker_save_enqueue_collision_fallback_in_process",
                    valid_job_id=valid_job_id,
                    user_id=user_id,
                )
                await save_analyzed_job(
                    {"redis": ctx.get("redis")},
                    valid_job_id,
                    user_id,
                    extraction_id,
                    result,
                )
        else:
            # run_job_match_analysis already cleared progress on failure paths.
            logger.warning("worker_analyze_job_match_empty_result", valid_job_id=valid_job_id, user_id=user_id)
            await publish_ws_event({
                "type": "match_failed",
                "user_id": user_id,
                "valid_job_id": valid_job_id,
                "error": "Match analysis returned no result",
            })
        return result
    except asyncio.CancelledError:
        await clear_job_match_progress(valid_job_id, user_id)
        raise
    except Exception as e:
        logger.exception("worker_analyze_job_match_failed", valid_job_id=valid_job_id, user_id=user_id, error=str(e))
        await clear_job_match_progress(valid_job_id, user_id)
        await publish_ws_event({
            "type": "match_failed",
            "user_id": user_id,
            "valid_job_id": valid_job_id,
            "error": str(e)[:300],
        })
        return None
    finally:
        clear_logging_context()


async def save_analyzed_job(
    ctx: dict,
    job_id: str,
    user_id: str,
    extraction_id: str | None,
    match_data: dict,
    lock_attempt: int = 0,
) -> dict | None:
    """Save analyzed job match result with per-user dedup lock.

    Lock contention re-enqueues with ``_defer_by`` instead of sleeping so waiters
    do not occupy a save ``max_jobs`` slot. Dedup runs under the lock; Phase B
    enqueue, WS events, and auto-post run after the lock is released.

    Critical: a completed Phase A result must never be discarded because the
    per-user lock is busy — keep deferring until the save succeeds.
    """
    from app.core.redis_support import pipeline_job_id
    from app.services.post_analysis_dedup import run_post_analysis_dedup

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="save_analyzed_job", job_id=job_id, user_id=user_id)
    logger.info(
        "worker_save_analyzed_job_started",
        job_id=job_id,
        user_id=user_id,
        lock_attempt=lock_attempt,
    )

    redis = ctx.get("redis")
    lock_key = f"job_save_lock:{user_id}"
    lock_ttl = SAVE_LOCK_TTL_SECONDS
    lock_held = False
    dedup_result: dict | None = None
    action: str | None = None

    if redis:
        acquired = await redis.set(lock_key, "1", nx=True, ex=lock_ttl)
        if not acquired:
            attempt = max(0, int(lock_attempt or 0))
            next_attempt = attempt + 1
            if next_attempt == SAVE_LOCK_MAX_ATTEMPTS or (
                next_attempt > SAVE_LOCK_MAX_ATTEMPTS and next_attempt % SAVE_LOCK_MAX_ATTEMPTS == 0
            ):
                # Soft warning only — still keep waiting; never drop match_data.
                logger.warning(
                    "save_lock_still_busy",
                    job_id=job_id,
                    user_id=user_id,
                    lock_attempt=next_attempt,
                    waited_approx_seconds=round(next_attempt * SAVE_LOCK_POLL_SECONDS),
                )
            try:
                pool = await get_save_pool()
                # Unique id per attempt so a running waiter can schedule the next poll
                # after it returns (stable ids would collide with the in-flight job).
                await pool.enqueue_job(
                    "save_analyzed_job",
                    job_id,
                    user_id,
                    extraction_id,
                    match_data,
                    next_attempt,
                    _job_id=pipeline_job_id("save", job_id, user_id, f"lock{next_attempt}"),
                    _defer_by=SAVE_LOCK_POLL_SECONDS,
                )
                logger.info(
                    "save_lock_deferred",
                    job_id=job_id,
                    user_id=user_id,
                    lock_attempt=next_attempt,
                    defer_by=SAVE_LOCK_POLL_SECONDS,
                )
            except Exception as e:
                logger.error(
                    "save_lock_defer_enqueue_failed",
                    job_id=job_id,
                    user_id=user_id,
                    error=str(e),
                )
                # Last resort: try once more with a unique suffix before failing.
                try:
                    pool = await get_save_pool()
                    await pool.enqueue_job(
                        "save_analyzed_job",
                        job_id,
                        user_id,
                        extraction_id,
                        match_data,
                        next_attempt,
                        _job_id=pipeline_job_id(
                            "save", job_id, user_id, f"lockretry{next_attempt}"
                        ),
                        _defer_by=SAVE_LOCK_POLL_SECONDS * 2,
                    )
                    clear_logging_context()
                    return {"deferred": "lock_busy_retry", "lock_attempt": next_attempt}
                except Exception as e2:
                    logger.error(
                        "save_lock_defer_retry_failed",
                        job_id=job_id,
                        user_id=user_id,
                        error=str(e2),
                    )
                    await clear_job_match_progress(job_id, user_id)
                    await publish_ws_event({
                        "type": "match_failed",
                        "user_id": user_id,
                        "valid_job_id": job_id,
                        "error": "Failed to requeue while waiting for save lock",
                    })
                    clear_logging_context()
                    return None
            clear_logging_context()
            return {"deferred": "lock_busy", "lock_attempt": next_attempt}
        lock_held = True

    try:
        dedup_result = await run_post_analysis_dedup(
            job_id, user_id, match_data, extraction_id,
        )
        action = dedup_result.get("action", "saved_active")
        logger.info("worker_save_analyzed_job_completed", job_id=job_id, action=action)
    except Exception as e:
        logger.exception("worker_save_analyzed_job_failed", job_id=job_id, error=str(e))
        await clear_job_match_progress(job_id, user_id)
        await publish_ws_event({
            "type": "match_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": str(e),
        })
        dedup_result = None
        action = None
    finally:
        if redis and lock_held:
            await redis.delete(lock_key)

    # Outside the per-user lock: WS + Phase B + auto-post (do not serialize peers).
    if action is not None:
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
                "exclusion_type": (dedup_result or {}).get("exclusion_type"),
                "reason": (dedup_result or {}).get("reason"),
            })

        if action == "saved_active" and match_data.get("should_run_phase_b"):
            try:
                pool = await get_tailoring_pool()
                await pool.enqueue_job(
                    "generate_tailored_content",
                    job_id,
                    user_id,
                    extraction_id,
                    _job_id=pipeline_job_id("tailor", job_id, user_id),
                )
            except Exception as e:
                logger.warning(
                    "tailored_content_enqueue_from_save_failed",
                    job_id=job_id,
                    error=str(e),
                )

        if action == "saved_active":
            await _enqueue_or_run_auto_posts(
                user_id, job_id, match_data.get("overall_score"),
            )

    clear_logging_context()
    return dedup_result


async def _enqueue_or_run_auto_posts(
    user_id: str,
    job_id: str,
    overall_score,
) -> None:
    """Enqueue Sheets/Pumble on the autopost queue; inline fallback if enqueue fails."""
    from app.core.redis_support import pipeline_job_id
    from app.services.job_match_orchestrator import run_match_auto_posts

    try:
        pool = await get_autopost_pool()
        await pool.enqueue_job(
            "run_match_auto_posts_task",
            user_id,
            job_id,
            overall_score,
            _job_id=pipeline_job_id("autopost", job_id, user_id),
        )
        return
    except Exception as e:
        logger.warning(
            "autopost_enqueue_failed_falling_back_inline",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
    await run_match_auto_posts(user_id, job_id, overall_score)


async def run_match_auto_posts_task(
    ctx: dict,
    user_id: str,
    job_id: str,
    overall_score,
) -> dict | None:
    """Dedicated worker entry for Sheets/Pumble auto-post (off the save queue)."""
    from app.services.job_match_orchestrator import run_match_auto_posts

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="run_match_auto_posts_task", job_id=job_id, user_id=user_id)
    try:
        await run_match_auto_posts(user_id, job_id, overall_score)
        return {"ok": True}
    except Exception as e:
        logger.exception(
            "worker_run_match_auto_posts_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
        return None
    finally:
        clear_logging_context()


async def _forward_phase_b_to_tailoring_queue(
    ctx: dict,
    job_id: str,
    user_id: str,
    extraction_id: str | None = None,
) -> dict | None:
    """Compat shim: old Phase B jobs still on job_analysis are re-queued."""
    from app.core.redis_support import pipeline_job_id

    pool = await get_tailoring_pool()
    await pool.enqueue_job(
        "generate_tailored_content",
        job_id,
        user_id,
        extraction_id,
        _job_id=pipeline_job_id("tailor", job_id, user_id),
    )
    logger.info(
        "phase_b_redirected_to_tailoring_queue",
        valid_job_id=job_id,
        user_id=user_id,
        queue=TAILORING_QUEUE,
    )
    return {"redirected": True, "queue": TAILORING_QUEUE}


async def generate_tailored_content(
    ctx: dict,
    job_id: str,
    user_id: str,
    extraction_id: str | None = None,
) -> dict | None:
    from app.services.job_match_orchestrator import run_tailored_content_generation
    from app.storage.repository import ResumeBuildRepository

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
        try:
            async with get_session() as session:
                await ResumeBuildRepository(session).fail_content_generation(
                    job_id, user_id, "Cancelled or timed out",
                )
        except Exception as cleanup_err:
            logger.warning(
                "worker_generate_tailored_content_cancel_cleanup_failed",
                valid_job_id=job_id,
                error=str(cleanup_err),
            )
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
        # Platform sync always prepares shared JD only (no analyze/tailor for the
        # syncing admin). Applicants start analysis separately via /prepare.
        stats = await promote_scrape_run(scrape_run_id, user_id=None)
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


_PROMOTION_SUM_KEYS = (
    "total",
    "new",
    "exact_duplicate_dropped",
    "linked_existing",
    "blocked",
    "skipped_invalid_url",
    "linkedin_skipped",
    "failed",
    "enqueued",
    "linkedin_purged",
)


def _aggregate_promotion_stats(results: list[dict]) -> dict | None:
    """Sum scrape→extract promotion counters across platforms for the sync banner."""
    found = False
    totals = {key: 0 for key in _PROMOTION_SUM_KEYS}
    for row in results:
        if not isinstance(row, dict):
            continue
        promo = row.get("promotion")
        if not isinstance(promo, dict):
            continue
        found = True
        for key in _PROMOTION_SUM_KEYS:
            totals[key] += int(promo.get(key) or 0)
    if not found:
        return None
    # Prefer the explicit drop counter; fall back to legacy linked_existing.
    dropped = totals["exact_duplicate_dropped"] or totals["linked_existing"]
    totals["exact_duplicate_dropped"] = dropped
    totals["linked_existing"] = dropped
    return totals


def _build_sync_summary(
    *,
    spider_name: str,
    sync_mode: str,
    posted_since: str | None,
    posted_until: str | None,
    platforms: list[str],
    results: list[dict],
) -> dict:
    """Normalize per-spider scrape results into a dashboard-friendly summary."""
    items_scraped = 0
    items_new = 0
    items_updated = 0
    succeeded = 0
    failed = 0
    first_error: str | None = None
    first_message: str | None = None
    platform_rows: list[dict] = []

    for row in results:
        if not isinstance(row, dict):
            continue
        scraped = int(row.get("items_scraped") or 0)
        new = int(row.get("items_new") or 0)
        updated = int(row.get("items_updated") or 0)
        items_scraped += scraped
        items_new += new
        items_updated += updated
        ok = bool(row.get("success"))
        if ok:
            succeeded += 1
        else:
            failed += 1
            if first_error is None:
                err = row.get("error")
                if err:
                    first_error = str(err)
            if first_message is None and row.get("message"):
                first_message = str(row["message"])
        platform_row = {
            "spider": row.get("spider"),
            "success": ok,
            "items_scraped": scraped,
            "items_new": new,
            "items_updated": updated,
            "error": row.get("error"),
            "message": row.get("message"),
        }
        promo = row.get("promotion")
        if isinstance(promo, dict):
            platform_row["promotion"] = promo
        platform_rows.append(platform_row)

    summary = {
        "spider": spider_name,
        "sync_mode": sync_mode,
        "posted_since": posted_since,
        "posted_until": posted_until,
        "platforms": platforms,
        "items_scraped": items_scraped,
        "items_new": items_new,
        "items_updated": items_updated,
        "total": len(platform_rows),
        "succeeded": succeeded,
        "failed": failed,
        "error": first_error,
        "message": first_message,
        "results": platform_rows,
    }
    promotion = _aggregate_promotion_stats(results)
    if promotion is not None:
        summary["promotion"] = promotion
    return summary


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
    ``scrape_promoter.promote_scrape_run`` - they become ``JobExtraction``
    (PENDING) + ``Job`` rows and ``extract_job`` is enqueued on the
    extraction queue.  From that point on, scraped jobs flow through the
    same pipeline as manually submitted URLs.
    """
    from datetime import date, datetime, timezone

    from app.scraper.runner import check_spider_auth, run_spiders_from_plan
    from app.services.scraper_sync_service import build_run_plan

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="run_scraper", spider_name=spider_name, user_id=user_id)

    from app.services.scraper_stop_service import is_stop_requested

    if await is_stop_requested():
        logger.info("worker_scraper_aborted_stop_flag", spider_name=spider_name)
        await publish_ws_event({
            "type": "sync_failed",
            "user_id": user_id,
            "spider_name": spider_name,
            "error": "stopped",
            "message": "Job fetching was stopped.",
        })
        return {
            "spider": spider_name,
            "success": False,
            "error": "stopped",
            "message": "Job fetching was stopped.",
        }

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
        "posted_since": posted_since,
        "posted_until": posted_until,
        "total": len(plan),
        "platforms": [name for name, _ in plan],
    })

    task_started_at = datetime.now(timezone.utc)

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
        platform_names = [name for name, _ in plan]
        results_for_summary: list[dict] = []
        for row in results:
            if not isinstance(row, dict):
                continue
            enriched = dict(row)
            spider = enriched.get("spider") or enriched.get("spider_name")
            if spider and spider in promotions and "promotion" not in enriched:
                enriched["promotion"] = promotions.get(spider)
            # Single-spider plans may omit spider on the result row.
            if len(plan) == 1 and plan[0][0] in promotions and "promotion" not in enriched:
                enriched["promotion"] = promotions.get(plan[0][0])
            results_for_summary.append(enriched)
        overall_ok = bool(results_for_summary) and all(
            bool(r.get("success")) for r in results_for_summary
        )

        summary = _build_sync_summary(
            spider_name=spider_name,
            sync_mode=sync_mode,
            posted_since=posted_since,
            posted_until=posted_until,
            platforms=platform_names,
            results=results_for_summary,
        )

        if overall_ok:
            await publish_ws_event({
                "type": "sync_completed",
                "user_id": user_id,
                "spider_name": spider_name,
                "sync_mode": sync_mode,
                "posted_since": posted_since,
                "posted_until": posted_until,
                "platforms": platform_names,
                "items_scraped": summary.get("items_scraped", 0),
                "items_new": summary.get("items_new", 0),
                "items_updated": summary.get("items_updated", 0),
                "promotion": summary.get("promotion"),
                "summary": summary,
            })
            logger.info(
                "worker_scraper_completed",
                spider_name=spider_name,
                items_scraped=summary.get("items_scraped", 0),
                items_new=summary.get("items_new", 0),
                promotion_enqueued=(summary.get("promotion") or {}).get("enqueued"),
            )
        else:
            stopped = any(
                isinstance(r, dict) and r.get("error") == "stopped"
                for r in results_for_summary
            )
            error = "stopped" if stopped else (
                summary.get("error") or summary.get("message") or "scrape_failed"
            )
            await publish_ws_event({
                "type": "sync_failed",
                "user_id": user_id,
                "spider_name": spider_name,
                "error": error,
                "message": (
                    "Job fetching was stopped."
                    if stopped
                    else summary.get("message")
                ),
                "sync_mode": sync_mode,
                "posted_since": posted_since,
                "posted_until": posted_until,
                "platforms": platform_names,
                "items_scraped": summary.get("items_scraped", 0),
                "items_new": summary.get("items_new", 0),
                "items_updated": summary.get("items_updated", 0),
                "promotion": summary.get("promotion"),
                "summary": summary,
            })
            logger.error(
                "worker_scraper_failed",
                spider_name=spider_name,
                error=error,
            )
        return summary

    except asyncio.CancelledError:
        # Deploy / systemd restart cancels the arq task (SIGTERM). The Scrapy
        # subprocess may already have flushed jobs + finalized scrape_runs.
        # Never tell the UI "Cancelled or timed out" when the DB shows a
        # completed scrape — that was the false-red RemoteRocketship banner.
        from app.scraper.runner import _latest_scrape_run

        platform_names = [name for name, _ in plan]
        recovered: list[dict] = []
        for name, _ in plan:
            row = await asyncio.to_thread(
                _latest_scrape_run,
                name,
                task_started_at,
            )
            if not row:
                continue
            status = (row.get("status") or "").lower()
            scraped = int(row.get("items_scraped") or 0)
            if status == "success" and scraped > 0:
                recovered.append({
                    "spider": name,
                    "success": True,
                    "items_scraped": scraped,
                    "items_new": int(row.get("items_new") or 0),
                    "items_updated": int(row.get("items_updated") or 0),
                    "scrape_run_id": row.get("id"),
                    "message": "Scrape finished before worker restart",
                })
            elif scraped > 0 and status in {"interrupted", "shutdown", "running", "error"}:
                recovered.append({
                    "spider": name,
                    "success": False,
                    "items_scraped": scraped,
                    "items_new": int(row.get("items_new") or 0),
                    "items_updated": int(row.get("items_updated") or 0),
                    "scrape_run_id": row.get("id"),
                    "error": "service_restarted",
                    "message": (
                        "Service restarted mid-sync. "
                        f"{scraped} jobs already saved — run Sync again to finish."
                    ),
                })

        if recovered and all(r.get("success") for r in recovered):
            for row in recovered:
                if row.get("scrape_run_id") and row.get("spider"):
                    promotions_map = await _promote_and_publish(
                        spider_name=row["spider"],
                        scrape_run_id=row.get("scrape_run_id"),
                        user_id=user_id,
                    )
                    if promotions_map is not None:
                        row["promotion"] = promotions_map
            summary = _build_sync_summary(
                spider_name=spider_name,
                sync_mode=sync_mode,
                posted_since=posted_since,
                posted_until=posted_until,
                platforms=platform_names,
                results=recovered,
            )
            await publish_ws_event({
                "type": "sync_completed",
                "user_id": user_id,
                "spider_name": spider_name,
                "sync_mode": sync_mode,
                "posted_since": posted_since,
                "posted_until": posted_until,
                "platforms": platform_names,
                "items_scraped": summary.get("items_scraped", 0),
                "items_new": summary.get("items_new", 0),
                "items_updated": summary.get("items_updated", 0),
                "promotion": summary.get("promotion"),
                "summary": summary,
                "message": "Scrape completed; worker restarted after finalize",
            })
            logger.info(
                "worker_scraper_completed_after_cancel",
                spider_name=spider_name,
                items_scraped=summary.get("items_scraped", 0),
            )
            # Return (do not re-raise) so arq does not retry / max-retries-fail
            # a sync that already persisted successfully.
            return summary

        # Partial progress: still promote whatever was flushed so jobs are not stuck.
        for row in recovered:
            if row.get("scrape_run_id") and row.get("spider") and int(row.get("items_scraped") or 0) > 0:
                try:
                    promotions_map = await _promote_and_publish(
                        spider_name=row["spider"],
                        scrape_run_id=row.get("scrape_run_id"),
                        user_id=user_id,
                    )
                    if promotions_map is not None:
                        row["promotion"] = promotions_map
                except Exception:
                    logger.exception(
                        "worker_scraper_promote_after_cancel_failed",
                        spider_name=row.get("spider"),
                    )

        error_msg = (
            recovered[0].get("message")
            if recovered
            else "Service restarted mid-sync. Run Sync again."
        )
        await publish_ws_event({
            "type": "sync_failed",
            "user_id": user_id,
            "spider_name": spider_name,
            "error": "service_restarted",
            "message": error_msg,
            "items_scraped": sum(int(r.get("items_scraped") or 0) for r in recovered),
            "items_new": sum(int(r.get("items_new") or 0) for r in recovered),
            "items_updated": sum(int(r.get("items_updated") or 0) for r in recovered),
        })
        logger.warning(
            "worker_scraper_cancelled_by_restart",
            spider_name=spider_name,
            recovered=len(recovered),
        )
        # Return failure instead of re-raising CancelledError so arq does not
        # immediately retry into "max retries exceeded" during rolling deploys.
        return {
            "spider": spider_name,
            "success": False,
            "error": "service_restarted",
            "message": error_msg,
            "results": recovered,
        }
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


async def check_job_sync_schedule_task(ctx: dict) -> dict:
    """Cron tick: enqueue incremental/date sync when the admin schedule is due."""
    from datetime import date as date_cls
    import uuid

    from app.core.redis_support import pipeline_job_id
    from app.scraper.runner import check_spider_auth
    from app.services.job_sync_schedule_service import (
        build_sync_args,
        get_schedule,
        is_schedule_due,
        is_scrape_running,
        mark_schedule_run,
        schedule_public_view,
    )
    from app.services.scraper_sync_service import build_run_plan

    set_request_id(new_request_id())
    bind_logging_context(worker_job_type="job_sync_schedule_tick")

    try:
        async with get_session() as session:
            schedule = await get_schedule(session)
            if not schedule.get("enabled"):
                return {"status": "disabled"}
            from app.services.scraper_stop_service import is_stop_requested

            if await is_stop_requested():
                logger.info("job_sync_schedule_skipped_stop_flag")
                return {"status": "skipped", "reason": "stop_requested"}
            if not is_schedule_due(schedule):
                return {
                    "status": "not_due",
                    "next_run_at": schedule_public_view(schedule).get("next_run_at"),
                }
            if await is_scrape_running(session):
                logger.info("job_sync_schedule_skipped_busy")
                return {"status": "skipped", "reason": "scrape_running"}

            # Claim the slot before enqueue so overlapping ticks do not double-fire.
            await mark_schedule_run(
                session,
                status="queued",
                message="Scheduled sync claimed; enqueueing…",
            )

        args = build_sync_args(schedule)
        spider_names = args.get("spider_names")
        try:
            plan = build_run_plan(
                spider_name=args["spider_name"],
                spider_names=spider_names,
                sync_mode=args["sync_mode"],
                posted_since=(
                    date_cls.fromisoformat(args["posted_since"])
                    if args.get("posted_since")
                    else None
                ),
                posted_until=(
                    date_cls.fromisoformat(args["posted_until"])
                    if args.get("posted_until")
                    else None
                ),
            )
        except ValueError as e:
            async with get_session() as session:
                await mark_schedule_run(session, status="failed", message=str(e))
            return {"status": "failed", "error": str(e)}

        for name, _kwargs in plan:
            auth_check = check_spider_auth(name)
            if auth_check["requires_auth"] and not auth_check["ok"]:
                msg = (
                    f"Spider '{name}' requires authentication. "
                    f"Run: {auth_check['auth_setup_command']}"
                )
                async with get_session() as session:
                    await mark_schedule_run(session, status="failed", message=msg)
                logger.error("job_sync_schedule_auth_required", spider_name=name)
                return {"status": "failed", "error": "auth_required", "message": msg}

        pool = await get_scraper_pool()
        await pool.enqueue_job(
            "run_scraper_task",
            args["spider_name"],
            args["user_id"],
            sync_mode=args["sync_mode"],
            posted_since=args.get("posted_since"),
            posted_until=args.get("posted_until"),
            spider_names=spider_names,
            _job_id=pipeline_job_id(
                "scrape",
                f"sched-{args['spider_name']}",
                args["user_id"],
                uuid.uuid4().hex[:10],
            ),
        )

        mode_label = (
            "date-range" if args["sync_mode"] == "date_backfill" else "incremental"
        )
        message = (
            f"Scheduled {mode_label} sync queued for "
            f"{len(plan)} platform{'s' if len(plan) != 1 else ''}."
        )
        async with get_session() as session:
            await mark_schedule_run(session, status="queued", message=message)

        logger.info(
            "job_sync_schedule_enqueued",
            sync_mode=args["sync_mode"],
            platform_count=len(plan),
            cadence=schedule.get("cadence"),
        )
        return {"status": "queued", "message": message, "platform_count": len(plan)}
    except Exception as e:
        logger.exception("job_sync_schedule_tick_failed", error=str(e))
        try:
            async with get_session() as session:
                await mark_schedule_run(
                    session, status="failed", message=str(e)[:500]
                )
        except Exception:
            pass
        return {"status": "failed", "error": str(e)}
    finally:
        clear_logging_context()


def _redis_settings() -> RedisSettings:
    from app.core.redis_support import arq_redis_settings

    return arq_redis_settings()


def _keep_result() -> int:
    return int(get_settings().arq_keep_result_seconds)


async def _extraction_worker_startup(ctx: dict) -> None:
    """Pre-create a singleton ExtractionService for reuse across jobs."""
    ctx["extraction_service"] = ExtractionService()
    from app.services.extraction_cache import init_redis_pool
    from app.core.redis_support import init_pubsub_redis_pool

    await init_redis_pool()
    await init_pubsub_redis_pool()


class ExtractionWorkerSettings:
    """arq settings for the extraction pipeline (I/O-heavy: HTTP + Playwright)."""
    functions = [extract_job]
    redis_settings = _redis_settings
    queue_name = EXTRACTION_QUEUE
    job_timeout = 300
    max_jobs = get_settings().extraction_worker_max_jobs
    max_tries = get_settings().extraction_worker_max_tries
    keep_result = _keep_result()
    on_startup = _extraction_worker_startup


async def _analysis_worker_startup(ctx: dict) -> None:
    from app.services.extraction_cache import init_redis_pool
    from app.core.redis_support import init_pubsub_redis_pool
    from app.services.pipeline_health import heal_stale_pipeline_state

    await init_redis_pool()
    await init_pubsub_redis_pool()
    await heal_stale_pipeline_state()


class AnalysisWorkerSettings:
    """arq settings for Phase A match scoring (LLM). Phase B has its own queue."""
    functions = [
        analyze_job_match,
        # Drain any Phase B jobs still sitting on the old shared analysis queue.
        func(_forward_phase_b_to_tailoring_queue, name="generate_tailored_content"),
    ]
    redis_settings = _redis_settings
    queue_name = ANALYSIS_QUEUE
    job_timeout = 360
    max_jobs = get_settings().analysis_worker_max_jobs
    max_tries = get_settings().analysis_worker_max_tries
    keep_result = _keep_result()
    on_startup = _analysis_worker_startup


async def _tailoring_worker_startup(ctx: dict) -> None:
    from app.services.extraction_cache import init_redis_pool
    from app.core.redis_support import init_pubsub_redis_pool
    from app.services.pipeline_health import heal_stale_pipeline_state

    await init_redis_pool()
    await init_pubsub_redis_pool()
    await heal_stale_pipeline_state()


class TailoringWorkerSettings:
    """arq settings for Phase B resume tailoring (dedicated concurrency)."""
    functions = [generate_tailored_content]
    redis_settings = _redis_settings
    queue_name = TAILORING_QUEUE
    job_timeout = 480
    max_jobs = get_settings().tailoring_worker_max_jobs
    # Transient LLM/network failures — retryable (unlike save/resume file I/O).
    max_tries = get_settings().tailoring_worker_max_tries
    keep_result = _keep_result()
    on_startup = _tailoring_worker_startup


class SaveWorkerSettings:
    """arq settings for the sequential job save pipeline (per-user lock)."""
    functions = [save_analyzed_job]
    redis_settings = _redis_settings
    queue_name = SAVE_QUEUE
    job_timeout = 180
    max_jobs = get_settings().save_worker_max_jobs
    max_tries = 1
    keep_result = _keep_result()


async def _autopost_worker_startup(ctx: dict) -> None:
    from app.core.redis_support import init_pubsub_redis_pool

    await init_pubsub_redis_pool()


class AutoPostWorkerSettings:
    """arq settings for Sheets/Pumble auto-post (off the save critical path)."""
    functions = [run_match_auto_posts_task]
    redis_settings = _redis_settings
    queue_name = AUTOPOST_QUEUE
    job_timeout = 180
    max_jobs = get_settings().autopost_worker_max_jobs
    max_tries = 3
    keep_result = _keep_result()
    on_startup = _autopost_worker_startup


class ResumeBuildWorkerSettings:
    """arq settings for the resume/cover letter document builder."""
    functions = [build_resume_task]
    redis_settings = _redis_settings
    queue_name = RESUME_BUILD_QUEUE
    job_timeout = 180
    max_jobs = get_settings().resume_worker_max_jobs
    max_tries = 1
    keep_result = _keep_result()


# ── Shared long-lived arq pools (one per queue, lazily created) ──────────────
_shared_pools: dict[str, ArqRedis] = {}


async def _get_shared_pool(queue: str) -> ArqRedis:
    """Return a long-lived ArqRedis pool for *queue*, creating it on first use.

    Callers must NOT close the returned pool - it is shared across the process.
    Hot-path enqueue must not ping Redis on every call; recreate only when
    the cached pool is missing.
    """
    pool = _shared_pools.get(queue)
    if pool is not None:
        return pool
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


async def get_tailoring_pool() -> ArqRedis:
    return await _get_shared_pool(TAILORING_QUEUE)


async def get_save_pool() -> ArqRedis:
    return await _get_shared_pool(SAVE_QUEUE)


async def get_autopost_pool() -> ArqRedis:
    return await _get_shared_pool(AUTOPOST_QUEUE)


async def get_resume_build_pool() -> ArqRedis:
    return await _get_shared_pool(RESUME_BUILD_QUEUE)


async def get_scraper_pool() -> ArqRedis:
    return await _get_shared_pool(SCRAPER_QUEUE)


class ScraperWorkerSettings:
    """arq settings for the scraper crawl pipeline (subprocess-based Scrapy)."""
    functions = [run_scraper_task]
    cron_jobs = [
        # Dynamic schedules (interval hours / daily HH:MM + timezone) are evaluated here.
        cron(check_job_sync_schedule_task, minute=set(range(60)), unique=True),
    ]
    redis_settings = _redis_settings
    queue_name = SCRAPER_QUEUE
    job_timeout = 3600
    max_jobs = get_settings().scraper_worker_max_jobs
    max_tries = 1
    keep_result = _keep_result()
