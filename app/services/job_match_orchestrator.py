"""
Orchestrates two-phase job match analysis:

Phase A (analyze_job_match on job_analysis): validation + structured job + match score.
Phase B (generate_tailored_content on job_tailoring): tailored resume JSON + cover letter.
"""

import asyncio
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import bind_logging_context, get_logger
from app.models.database import Job, UserJobStatus, ValidJobUserApplication
from app.models.schemas import ExtractionStatus, JobDescriptionSchema
from app.services.system_settings_service import (
    get_effective_value,
    get_effective_value_sync,
)
from app.services.job_match_service import (
    analyze_job_match_phase_a,
    generate_tailored_content_phase_b,
    _build_job_text,
    _zero_match_result,
    build_structured_context,
)
from app.services.security_clearance_detector import (
    requires_security_clearance as detect_security_clearance,
)
from app.services.extraction_cache import ExtractionCache
from app.services.job_field_utils import parse_job_title
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
from app.storage.profile_source_document_repository import ProfileSourceDocumentRepository
from app.services.profile_evidence_service import extract_job_evidence_pack
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
    *,
    manual: bool = False,
) -> bool:
    try:
        from app.tasks.worker import get_tailoring_pool, TAILORING_QUEUE
        from app.core.redis_support import pipeline_job_id

        pool = await get_tailoring_pool()
        await pool.enqueue_job(
            "generate_tailored_content",
            job_id,
            user_id,
            extraction_id,
            manual=manual,
            _job_id=pipeline_job_id("tailor", job_id, user_id),
        )
        logger.info(
            "tailored_content_enqueued",
            job_id=job_id,
            user_id=user_id,
            queue=TAILORING_QUEUE,
        )
        return True
    except Exception as e:
        logger.warning(
            "tailored_content_enqueue_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
        return False


async def run_match_auto_posts(
    user_id: str,
    job_id: str,
    overall_score: Any,
) -> None:
    """Pumble/Sheets auto-post (runs on autopost worker, not save slots)."""
    try:
        from app.services.pumble_service import auto_post_if_eligible

        await auto_post_if_eligible(user_id, job_id, overall_score)
    except Exception as auto_post_err:
        logger.warning(
            "pumble_auto_post_hook_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(auto_post_err),
        )

    try:
        from app.services.google_sheets_service import (
            auto_post_if_eligible as sheets_auto_post_if_eligible,
        )

        await sheets_auto_post_if_eligible(user_id, job_id, overall_score)
    except Exception as sheets_auto_post_err:
        logger.warning(
            "sheets_auto_post_hook_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(sheets_auto_post_err),
        )


async def _enqueue_resume_doc_build(job_id: str, user_id: str) -> None:
    try:
        from app.tasks.worker import get_resume_build_pool
        from app.core.redis_support import pipeline_job_id

        pool = await get_resume_build_pool()
        await pool.enqueue_job(
            "build_resume_task",
            job_id,
            user_id,
            _job_id=pipeline_job_id("resume", job_id, user_id),
        )
        logger.info("resume_build_enqueued", job_id=job_id)
    except Exception as enq_err:
        logger.warning("resume_build_enqueue_failed", job_id=job_id, error=str(enq_err))


async def _enqueue_missing_encodings(job_id: str, user_id: str) -> None:
    """Best-effort: queue encoding work so the vector engine can serve next time."""
    try:
        from app.tasks.worker import enqueue_encode_job, enqueue_encode_user

        await enqueue_encode_job(job_id)
        await enqueue_encode_user(user_id)
    except Exception as e:
        logger.warning(
            "encoding_enqueue_from_match_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )


async def _mark_extraction_ready_without_llm(ext_id: str, job_id: str | None = None) -> None:
    """Advance extraction past Analyzing without an LLM structuring pass.

    Hydrates title/company/location/etc. from raw text / ATS signals, then marks
    COMPLETED so the Jobs UI leaves Analyzing.
    """
    from app.services.job_metadata_hydrator import hydrate_job_metadata

    job_pk = job_id
    if not job_pk:
        async with get_session() as session:
            job = await JobRepository(session).get_by_extraction_id(ext_id)
            job_pk = job.id if job else None
    if job_pk:
        try:
            await hydrate_job_metadata(
                job_id=job_pk,
                extraction_id=ext_id,
                mark_completed=True,
            )
            try:
                await ExtractionCache().delete(ext_id)
            except Exception:
                pass
            return
        except Exception as e:
            logger.warning(
                "vector_metadata_hydrate_failed",
                job_id=job_pk,
                extraction_id=ext_id,
                error=str(e),
            )
    async with get_session() as session:
        extraction_repo = JobExtractionRepository(session)
        await extraction_repo.update_is_job_posting(ext_id, True)
        await extraction_repo.update_status(ext_id, ExtractionStatus.COMPLETED)
    try:
        await ExtractionCache().delete(ext_id)
    except Exception:
        pass


_ENCODING_WAIT_SECONDS = 30.0
# How often arq checks for the encode task's result; batched encodes take tens of ms.
_ENCODING_RESULT_POLL_SECONDS = 0.05


async def _encodings_present(job_id: str, user_id: str) -> bool:
    from app.models.database import JobEncoding, UserEncoding
    from app.services.encoding_service import model_version

    current_model = model_version()
    async with get_session() as session:
        job_row = (
            await session.execute(
                select(JobEncoding.job_id).where(
                    JobEncoding.job_id == job_id,
                    JobEncoding.model_version == current_model,
                )
            )
        ).first()
        if job_row is None:
            return False
        user_row = (
            await session.execute(
                select(UserEncoding.user_id).where(
                    UserEncoding.user_id == user_id,
                    UserEncoding.model_version == current_model,
                )
            )
        ).first()
        return user_row is not None


async def _wait_for_worker_encodings(job_id: str, user_id: str) -> bool:
    """Have the encoding worker encode the job and profile, wait for it once, check once.

    Each encode has a stable arq id, so this waits on the task that is already
    queued or running instead of re-polling the tables.
    """
    from arq.jobs import Job as ArqJob

    from app.core.redis_support import pipeline_job_id
    from app.tasks.worker import get_encoding_pool

    started = time.monotonic()
    try:
        pool = await get_encoding_pool()
        waits = []
        for task, arg, arq_id in (
            ("encode_job_task", job_id, pipeline_job_id("encjob", job_id, "job")),
            ("encode_user_task", user_id, pipeline_job_id("encuser", user_id, "user")),
        ):
            await pool.enqueue_job(task, arg, _job_id=arq_id)
            waits.append(
                ArqJob(arq_id, pool).result(
                    timeout=_ENCODING_WAIT_SECONDS, poll_delay=_ENCODING_RESULT_POLL_SECONDS
                )
            )
        await asyncio.gather(*waits)
    except asyncio.TimeoutError:
        logger.warning(
            "vector_encoding_wait_timeout",
            job_id=job_id,
            user_id=user_id,
            waited_seconds=_ENCODING_WAIT_SECONDS,
        )
        return False
    except Exception as e:
        # A failed or expired encode task still leaves the final table check.
        logger.warning(
            "vector_encoding_wait_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
    present = await _encodings_present(job_id, user_id)
    logger.info(
        "vector_encoding_waited",
        job_id=job_id,
        user_id=user_id,
        present=present,
        waited_ms=int((time.monotonic() - started) * 1000),
    )
    return present


async def _ensure_encodings_for_vector(job_id: str, user_id: str) -> bool:
    """Encode job+user inline when missing so vector scoring can finish now.

    Falls back to enqueueing the encoding worker if inline encode fails. With
    EMBEDDING_INLINE off, enqueues and waits briefly for the encoding worker.
    """
    from app.services.encoding_service import embedding_inline_enabled

    if not embedding_inline_enabled():
        return await _wait_for_worker_encodings(job_id, user_id)
    try:
        from app.services.encoding_service import encode_job, encode_user

        job_ok = await encode_job(job_id)
        user_ok = await encode_user(user_id)
        if job_ok and user_ok:
            return True
        logger.warning(
            "vector_inline_encode_incomplete",
            job_id=job_id,
            user_id=user_id,
            job_ok=job_ok,
            user_ok=user_ok,
        )
    except Exception as e:
        logger.warning(
            "vector_inline_encode_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
    await _enqueue_missing_encodings(job_id, user_id)
    return False


async def _try_vector_authoritative(
    job_id: str,
    user_id: str,
    ext_id: str,
) -> tuple[dict, bool] | None:
    """Score with the vector engine from raw/extraction text + encodings.

    Never requires LLM structuring. Returns (match_result, is_job_posting) or
    None when text/encodings are unavailable (caller must not fall back to LLM
    in vector mode).
    """
    async with get_session() as session:
        extraction = await JobExtractionRepository(session).get_by_id(ext_id)
    if extraction is None:
        return None

    has_text = bool(
        (extraction.description or "").strip()
        or (getattr(extraction, "raw_plain_text", None) or "").strip()
        or (extraction.title or "").strip()
    )
    if not has_text:
        logger.warning("vector_match_no_extraction_text", job_id=job_id, extraction_id=ext_id)
        return None

    if extraction.is_job_posting is False:
        return _zero_match_result("Not a job posting"), False

    if extraction.is_job_posting is None:
        await _mark_extraction_ready_without_llm(ext_id, job_id)

    from app.services.vector_match_service import ProfileTooThinError, compute_vector_match

    try:
        vector_result = await compute_vector_match(job_id, user_id)
    except ProfileTooThinError:
        return None
    if vector_result is None:
        if not await _ensure_encodings_for_vector(job_id, user_id):
            return None
        try:
            vector_result = await compute_vector_match(job_id, user_id)
        except ProfileTooThinError:
            return None
        if vector_result is None:
            logger.warning(
                "vector_match_unavailable_after_encode",
                job_id=job_id,
                user_id=user_id,
            )
            return None
    if vector_result.get("is_job_posting") is False:
        if vector_result.get("not_posting_source") != "learned":
            async with get_session() as session:
                await JobExtractionRepository(session).update_is_job_posting(ext_id, False)
        return vector_result, False
    return vector_result, True


async def _record_shadow_comparison(job_id: str, user_id: str, llm_result: dict) -> None:
    """Shadow mode: score the same pair with the vector engine and store both."""
    if llm_result.get("requires_security_clearance") or not llm_result.get(
        "is_job_posting", True
    ):
        return
    try:
        from app.services.vector_match_service import ProfileTooThinError, compute_vector_match

        try:
            vector_result = await compute_vector_match(job_id, user_id)
        except ProfileTooThinError:
            return
        if vector_result is None:
            await _enqueue_missing_encodings(job_id, user_id)
            return

        from app.models.database import MatchEngineComparison

        llm_overall = int(llm_result.get("overall_score") or 0)
        vector_overall = int(vector_result.get("overall_score") or 0)
        async with get_session() as session:
            session.add(
                MatchEngineComparison(
                    job_id=job_id,
                    user_id=user_id,
                    llm_overall=llm_overall,
                    vector_overall=vector_overall,
                    llm_dimensions=dict(llm_result.get("dimension_scores") or {}),
                    vector_dimensions=dict(vector_result.get("dimension_scores") or {}),
                )
            )
        logger.info(
            "match_engine_shadow_compared",
            job_id=job_id,
            user_id=user_id,
            llm_overall=llm_overall,
            vector_overall=vector_overall,
            delta=vector_overall - llm_overall,
        )
    except Exception as e:
        logger.warning(
            "match_engine_shadow_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )


def _attach_result_metadata(
    result: dict,
    *,
    ext_id: str,
    is_job_posting: bool,
    has_profile: bool,
    skip_phase_b: bool,
    structured_company: str | None,
    engine: str,
) -> dict:
    overall_score = int(result.get("overall_score") or 0)
    result["is_job_posting"] = is_job_posting
    result["should_run_phase_b"] = (
        (not skip_phase_b)
        and bool(get_effective_value_sync("auto_generate_tailored_content"))
        and has_profile
        and is_job_posting
        and not result.get("requires_security_clearance")
        and overall_score > 0
    )
    result["extraction_id"] = ext_id
    result["structured_company"] = structured_company
    result["skip_phase_b"] = bool(skip_phase_b)
    result["match_engine"] = engine
    return result


async def run_job_match_analysis(
    job_id: str,
    user_id: str,
    *,
    extraction_id: str | None = None,
    skip_phase_b: bool = False,
) -> dict | None:
    """Phase A: match scoring + structured job extraction.

    Returns the match result dict enriched with metadata the save task needs
    (should_run_phase_b, extraction_id, structured_company).  Match persistence,
    company policy, sheets posting, and tailored-content enqueue are handled
    downstream by the save_analyzed_job worker task.

    ``skip_phase_b`` is used by auto-prepare match-only so Phase B is not chained.
    Manual Prepare/Run always passes False (Phase B still gated by system setting).
    For users who apply with their original résumé, Phase B writes only the
    cover letter.
    """
    bind_logging_context(job_id=job_id, user_id=user_id)
    ext_id: str | None = None
    is_job_posting = False
    has_profile = False
    t0 = time.perf_counter()
    timing_steps: list[dict[str, Any]] = []

    def _mark(step: str, **detail: Any) -> None:
        now = time.perf_counter()
        prev = timing_steps[-1]["_t"] if timing_steps else t0
        entry: dict[str, Any] = {
            "step": step,
            "duration_ms": round((now - prev) * 1000, 2),
            "_t": now,
        }
        if detail:
            entry["detail"] = {k: v for k, v in detail.items() if v is not None}
        timing_steps.append(entry)

    def _emit_timing(*, engine: str, score: Any = None, ok: bool = True) -> None:
        total_ms = round((time.perf_counter() - t0) * 1000, 2)
        steps = [{k: v for k, v in s.items() if k != "_t"} for s in timing_steps]
        logger.info(
            "job_match_analysis_timing",
            job_id=job_id,
            user_id=user_id,
            duration_ms=total_ms,
            match_engine=engine,
            score=score,
            ok=ok,
            steps=steps,
            source="orchestrator",
        )

    try:
        loaded = await _load_job_and_profile(job_id, user_id, extraction_id)
        if not loaded:
            _mark("load_job_and_profile", found=False)
            _emit_timing(engine="none", ok=False)
            await clear_job_match_progress(job_id, user_id)
            return None
        ext_id, job_text, profile_text = loaded
        has_profile = bool((profile_text or "").strip())
        _mark(
            "load_job_and_profile",
            found=True,
            job_text_chars=len(job_text or ""),
            has_profile=has_profile,
        )

        try:
            # Deliberately the async read, not get_effective_value_sync. The
            # sync accessor serves an in-process cache that only a warm-up call
            # populates, and in a worker the only warm-up is the one llm_client
            # does before an LLM call. Under match_engine=vector Phase A makes
            # no LLM call, so the cache stays cold, the sync read falls back to
            # the .env default of "vector", and the engine can never be moved
            # off vector from the database -- which is why no shadow comparison
            # was ever recorded.
            engine = str(await get_effective_value("match_engine") or "vector")
        except Exception:
            engine = "vector"
        _mark("resolve_engine", engine=engine)

        # ── Phase 0 deterministic gate: security clearance (no LLM call) ──
        clearance_required, clearance_phrase = detect_security_clearance(job_text)
        _mark("clearance_gate", hit=clearance_required, phrase=clearance_phrase)
        if clearance_required:
            logger.info(
                "job_match_clearance_gate_hit",
                job_id=job_id,
                user_id=user_id,
                phrase=clearance_phrase,
            )
            async with get_session() as session:
                extraction_repo = JobExtractionRepository(session)
                # Clearance phrasing only appears in genuine postings; advance
                # the extraction so the UI stops showing "Analyzing". The raw
                # extractor fields remain (no LLM re-structuring for a job
                # that is excluded anyway).
                await extraction_repo.update_is_job_posting(ext_id, True)
                await extraction_repo.update_status(ext_id, ExtractionStatus.COMPLETED)
            try:
                await ExtractionCache().delete(ext_id)
            except Exception:
                pass
            result = _zero_match_result(
                "Requires security clearance - not scored",
                requires_security_clearance=True,
            )
            _mark("clearance_gate_persist")
            _emit_timing(engine="gate", score=0, ok=True)
            return _attach_result_metadata(
                result,
                ext_id=ext_id,
                is_job_posting=True,
                has_profile=has_profile,
                skip_phase_b=skip_phase_b,
                structured_company=None,
                engine="gate",
            )

        # ── Vector engine: never falls through to LLM Phase A ──
        if engine == "vector":
            if not has_profile:
                logger.warning(
                    "job_match_vector_no_profile",
                    job_id=job_id,
                    user_id=user_id,
                )
                _emit_timing(engine="vector", ok=False)
                await clear_job_match_progress(job_id, user_id)
                return None
            vector_outcome = await _try_vector_authoritative(job_id, user_id, ext_id)
            if vector_outcome is None:
                logger.warning(
                    "job_match_vector_engine_failed",
                    job_id=job_id,
                    user_id=user_id,
                )
                _mark("vector_score", available=False)
                _emit_timing(engine="vector", ok=False)
                await clear_job_match_progress(job_id, user_id)
                return None
            result, is_job_posting = vector_outcome
            _mark(
                "vector_score",
                available=True,
                score=result.get("overall_score"),
                recommendation=result.get("recommendation"),
            )
            logger.info(
                "job_match_vector_engine_complete",
                job_id=job_id,
                user_id=user_id,
                scorer_version=result.get("scorer_version"),
                scorer_stage=result.get("scorer_stage"),
                score=result.get("overall_score"),
                is_job_posting=is_job_posting,
                dimension_scores=result.get("dimension_scores"),
                summary=(result.get("summary") or "")[:240],
                strengths=result.get("strengths"),
                gaps=result.get("gaps"),
            )
            _emit_timing(
                engine="vector",
                score=result.get("overall_score"),
                ok=True,
            )
            return _attach_result_metadata(
                result,
                ext_id=ext_id,
                is_job_posting=is_job_posting,
                has_profile=has_profile,
                skip_phase_b=skip_phase_b,
                structured_company=None,
                engine="vector",
            )

        try:
            result, structured_job, is_job_posting = await analyze_job_match_phase_a(
                job_text, profile_text, user_id=user_id,
            )
            _mark(
                "llm_phase_a",
                score=result.get("overall_score"),
                is_job_posting=is_job_posting,
            )
        except Exception as e:
            logger.error(
                "job_match_phase_a_failed",
                job_id=job_id,
                user_id=user_id,
                error=str(e),
            )
            _mark("llm_phase_a", failed=True)
            _emit_timing(engine="llm", ok=False)
            await clear_job_match_progress(job_id, user_id)
            return None

        async with get_session() as session:
            extraction_repo = JobExtractionRepository(session)

            try:
                structured_company: str | None = None
                structured_persisted = False
                if structured_job:
                    try:
                        structured_company = _truncate_for_db(structured_job.company, 500)
                        await extraction_repo.update_extraction_result(
                            ext_id,
                            structured_job,
                            extraction_repo_method=None,
                            is_job_posting=is_job_posting,
                        )
                        structured_persisted = True
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

                # Always advance past EXTRACTED after Phase A. Otherwise the Jobs UI
                # keeps showing "Analyzing" even when a match score (incl. 0 Weak)
                # was already produced and saved.
                if not structured_persisted:
                    await extraction_repo.update_is_job_posting(ext_id, is_job_posting)
                    await extraction_repo.update_status(ext_id, ExtractionStatus.COMPLETED)

                try:
                    cache = ExtractionCache()
                    await cache.delete(ext_id)
                except Exception:
                    pass

                _attach_result_metadata(
                    result,
                    ext_id=ext_id,
                    is_job_posting=is_job_posting,
                    has_profile=has_profile,
                    skip_phase_b=skip_phase_b,
                    structured_company=structured_company,
                    engine="llm",
                )
                _mark("persist_structured", structured_persisted=structured_persisted)

                logger.info(
                    "job_match_phase_a_complete",
                    job_id=job_id,
                    user_id=user_id,
                    score=result["overall_score"],
                    phase_b=result["should_run_phase_b"],
                    dimension_scores=result.get("dimension_scores"),
                    summary=(result.get("summary") or "")[:240],
                )
            except Exception as e:
                logger.error(
                    "job_match_phase_a_persist_failed",
                    job_id=job_id,
                    user_id=user_id,
                    error=str(e),
                )
                _emit_timing(engine="llm", ok=False)
                await clear_job_match_progress(job_id, user_id)
                return None

        # Re-encode with the professionally structured text (idempotent upsert)
        # so vector scoring uses clean content instead of raw page text.
        if structured_persisted:
            try:
                from app.tasks.worker import enqueue_encode_job

                await enqueue_encode_job(job_id)
                _mark("encode_enqueue", enqueued=True)
            except Exception as enc_err:
                logger.warning(
                    "encode_enqueue_after_structuring_failed",
                    job_id=job_id,
                    error=str(enc_err),
                )
                _mark("encode_enqueue", enqueued=False)

        # Shadow mode: also score with the vector engine and store the pair for
        # calibration. Never affects the returned (LLM) result.
        if engine == "shadow":
            await _record_shadow_comparison(job_id, user_id, result)
            _mark("shadow_compare")

        _emit_timing(engine=engine, score=result.get("overall_score"), ok=True)
        # Auto-post runs on the save worker after persistence so Phase A does not
        # hold analysis concurrency slots on Pumble/Sheets network I/O.
        return result
    except asyncio.CancelledError:
        await clear_job_match_progress(job_id, user_id)
        raise


async def _tailoring_skip_reason(job_id: str, user_id: str, *, manual: bool) -> str | None:
    """Why automatic tailoring is wasted on this job, or None to proceed.

    Hidden jobs never need documents. Applied jobs only do when the user asks.
    """
    async with get_session() as session:
        hidden = await session.scalar(
            select(UserJobStatus.id).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == job_id,
                UserJobStatus.status.in_(("duplicated", "manual_hidden")),
            ).limit(1)
        )
        if hidden:
            return "hidden"
        if manual:
            return None
        applied = await session.scalar(
            select(ValidJobUserApplication.id).where(
                ValidJobUserApplication.user_id == user_id,
                ValidJobUserApplication.job_id == job_id,
            ).limit(1)
        )
        return "applied" if applied else None


async def run_tailored_content_generation(
    job_id: str,
    user_id: str,
    *,
    extraction_id: str | None = None,
    manual: bool = False,
) -> dict | None:
    """Phase B: tailored resume JSON + cover letter, then enqueue DOCX/PDF build.

    Users who apply with their original résumé get the cover letter only; their
    uploaded résumé file goes to applications unchanged.
    """
    bind_logging_context(job_id=job_id, user_id=user_id)

    try:
        skip_reason = await _tailoring_skip_reason(job_id, user_id, manual=manual)
        if skip_reason:
            logger.info("tailored_content_skipped", reason=skip_reason, manual=manual)
            async with get_session() as session:
                repo = ResumeBuildRepository(session)
                existing = await repo.get(job_id, user_id)
                if not (existing and (existing.tailored_resume_data or existing.cover_letter_data)):
                    await repo.mark_content_skipped(job_id, user_id)
            return None

        from app.services.job_pipeline_mode import user_uses_original_resume

        cover_only = await user_uses_original_resume(user_id)

        loaded = await _load_job_and_profile(job_id, user_id, extraction_id)
        if not loaded:
            return None
        ext_id, job_text, profile_text = loaded

        async with get_session() as session:
            resume_repo = ResumeBuildRepository(session)
            ext_repo = JobExtractionRepository(session)
            match_repo = JobMatchRepository(session)

            if not (profile_text or "").strip():
                await resume_repo.mark_content_skipped(job_id, user_id)
                return None

            extraction = await ext_repo.get_by_id(ext_id)
            if extraction and extraction.is_job_posting is False:
                await resume_repo.mark_content_skipped(job_id, user_id)
                return None

            await resume_repo.mark_content_generating(job_id, user_id)

            structured_job: JobDescriptionSchema | None = None
            if extraction and extraction.description:
                structured_job = JobDescriptionSchema(
                    title=parse_job_title(extraction.title),
                    company=extraction.company,
                    location=extraction.location,
                    employment_type=extraction.employment_type,
                    salary_range=extraction.salary_range,
                    description=extraction.description or "",
                    responsibilities=extraction.responsibilities or [],
                    requirements=extraction.requirements or [],
                    benefits=extraction.benefits or [],
                    remote_policy=extraction.remote_policy,
                    work_mode=extraction.work_mode,
                    experience_level=extraction.experience_level,
                    industry=extraction.industry,
                )

            match_row = await match_repo.get(job_id, user_id)
            match_parts: list[str] = []
            if match_row and (match_row.summary or "").strip():
                match_parts.append(str(match_row.summary).strip())
            strengths = list(getattr(match_row, "strengths", None) or []) if match_row else []
            strength_lines = [
                f"- {str(s).strip()}" for s in strengths if isinstance(s, str) and str(s).strip()
            ][:8]
            if strength_lines:
                match_parts.append("Match strengths to emphasize:\n" + "\n".join(strength_lines))
            gaps = list(getattr(match_row, "gaps", None) or []) if match_row else []
            gap_lines = [
                f"- {str(g).strip()}" for g in gaps if isinstance(g, str) and str(g).strip()
            ][:6]
            if gap_lines:
                match_parts.append(
                    "Gaps to avoid inventing or overstating:\n" + "\n".join(gap_lines)
                )
            match_summary = "\n\n".join(match_parts)

            user = await UserRepository(session).get_by_id(user_id)
            source_docs = await ProfileSourceDocumentRepository(session).list_completed_for_user(user_id)

        structured_context = build_structured_context(structured_job)

        project_evidence_context = "No project source evidence available."
        if cover_only:
            from app.services.original_resume_service import get_original_resume_text

            original_text = await get_original_resume_text(user_id)
            if original_text:
                # First, so the profile length cap trims profile extras rather than the résumé sent.
                profile_text = (
                    f"## Original Resume (sent with this application)\n{original_text}\n\n{profile_text}"
                ).strip()
        from app.services.job_first_tailoring import STRATEGY_JOB_FIRST, normalize_strategy

        job_first = not cover_only and normalize_strategy(
            getattr(user, "resume_tailoring_strategy", None)
        ) == STRATEGY_JOB_FIRST
        # Job-first writes each role from the career facts alone, so per-company evidence is unused.
        if user and source_docs and not job_first:
            try:
                project_evidence_context = await extract_job_evidence_pack(
                    job_text=job_text,
                    structured_job=structured_job,
                    match_summary=match_summary,
                    user=user,
                    docs=source_docs,
                    user_id=user_id,
                )
                logger.info(
                    "phase_b_pre_evidence_ready",
                    job_id=job_id,
                    user_id=user_id,
                    doc_count=len(source_docs),
                    evidence_chars=len(project_evidence_context),
                )
            except Exception as e:
                logger.warning(
                    "phase_b_pre_evidence_failed",
                    job_id=job_id,
                    user_id=user_id,
                    error=str(e),
                )

        try:
            tailored_resume, cover_letter = await generate_tailored_content_phase_b(
                job_text,
                profile_text,
                structured_context=structured_context,
                match_summary=match_summary,
                project_evidence_context=project_evidence_context,
                user_id=user_id,
                include_resume=not cover_only,
                job_id=job_id,
            )
        except Exception as e:
            logger.error(
                "job_match_phase_b_failed",
                job_id=job_id,
                user_id=user_id,
                error=str(e),
            )
            async with get_session() as session:
                await ResumeBuildRepository(session).fail_content_generation(job_id, user_id, str(e))
            await publish_ws_event({
                "type": "tailored_content_failed",
                "user_id": user_id,
                "job_id": job_id,
                "error": str(e),
            })
            return None

        if cover_only and not cover_letter:
            async with get_session() as session:
                await ResumeBuildRepository(session).fail_content_generation(
                    job_id, user_id, "Cover letter could not be written"
                )
            return None

        if not cover_only and not tailored_resume:
            async with get_session() as session:
                await ResumeBuildRepository(session).fail_content_generation(
                    job_id, user_id, "Tailored resume section missing or invalid"
                )
            return None

        async with get_session() as session:
            repo = ResumeBuildRepository(session)
            if cover_only:
                await repo.complete_cover_letter_generation(job_id, user_id, cover_letter_data=cover_letter)
            else:
                await repo.complete_content_generation(
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
        logger.info("job_match_phase_b_stored", job_id=job_id, user_id=user_id, cover_only=cover_only)
        return tailored_resume or cover_letter
    except asyncio.CancelledError:
        try:
            async with get_session() as session:
                await ResumeBuildRepository(session).fail_content_generation(
                    job_id, user_id, "Cancelled or timed out",
                )
        except Exception as cleanup_err:
            logger.warning(
                "phase_b_cancel_cleanup_failed",
                job_id=job_id,
                user_id=user_id,
                error=str(cleanup_err),
            )
        raise
