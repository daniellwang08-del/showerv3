"""Admin/diagnostic probe for one job x user match analysis run.

Returns step timings, stored state, vector explain payload, and recent logs
so a specific job can be inspected without digging through worker output.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from app.core.logging import bind_logging_context, get_logger
from app.models.database import Job, SystemLogEvent
from app.services.security_clearance_detector import (
    requires_security_clearance as detect_security_clearance,
)
from app.services.system_settings_service import get_effective_value_sync
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, JobMatchRepository
from app.storage.user_repository import UserRepository

logger = get_logger(__name__)


class _StepTimer:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self._t0 = time.perf_counter()

    def mark(self, name: str, **detail: Any) -> float:
        now = time.perf_counter()
        prev = self.steps[-1]["t"] if self.steps else self._t0
        duration_ms = round((now - prev) * 1000, 2)
        entry = {"step": name, "duration_ms": duration_ms, "t": now}
        if detail:
            entry["detail"] = {k: v for k, v in detail.items() if v is not None}
        self.steps.append(entry)
        return duration_ms

    def report(self) -> dict[str, Any]:
        total_ms = round((time.perf_counter() - self._t0) * 1000, 2)
        return {
            "total_ms": total_ms,
            "steps": [
                {k: v for k, v in s.items() if k != "t"} for s in self.steps
            ],
        }


async def diagnose_job_match(
    job_id: str,
    user_id: str,
    *,
    encode_if_missing: bool = True,
    include_logs: bool = True,
    log_hours: int = 24,
    persist: bool = False,
) -> dict[str, Any]:
    """Run a timed, explainable match probe for one job x user pair."""
    bind_logging_context(job_id=job_id, user_id=user_id)
    timer = _StepTimer()
    out: dict[str, Any] = {
        "job_id": job_id,
        "user_id": user_id,
        "ok": False,
        "errors": [],
        "warnings": [],
    }

    try:
        engine = str(get_effective_value_sync("match_engine") or "vector")
    except Exception:
        engine = "vector"
    out["match_engine_setting"] = engine
    timer.mark("resolve_settings", engine=engine)

    async with get_session() as session:
        job = (
            await session.execute(select(Job).where(Job.id == job_id))
        ).scalar_one_or_none()
        if not job:
            timer.mark("load_job", found=False)
            out["errors"].append("job_not_found")
            out["timing"] = timer.report()
            return out

        out["job"] = {
            "id": job.id,
            "title": job.title,
            "company": job.company,
            "location": job.location,
            "work_mode": getattr(job, "work_mode", None),
            "salary": getattr(job, "salary", None),
            "url": job.source_url,
            "extraction_id": job.extraction_id,
            "source": getattr(job, "source", None),
        }
        ext_id = job.extraction_id
        extraction = None
        if ext_id:
            extraction = await JobExtractionRepository(session).get_by_id(ext_id)
        out["extraction"] = None
        if extraction:
            raw = getattr(extraction, "raw_plain_text", None) or ""
            out["extraction"] = {
                "id": extraction.id,
                "status": str(getattr(extraction.status, "value", extraction.status)),
                "method": str(
                    getattr(extraction.extraction_method, "value", extraction.extraction_method)
                    if getattr(extraction, "extraction_method", None) is not None
                    else None
                ),
                "is_job_posting": extraction.is_job_posting,
                "title": extraction.title,
                "company": extraction.company,
                "location": extraction.location,
                "raw_plain_text_len": len(raw),
                "has_description": bool((extraction.description or "").strip()),
            }

        stored = await JobMatchRepository(session).get(job_id, user_id)
        out["stored_match"] = None
        if stored:
            out["stored_match"] = {
                "overall_score": stored.overall_score,
                "dimension_scores": stored.dimension_scores,
                "summary": stored.summary,
                "strengths": stored.strengths,
                "gaps": stored.gaps,
                "recommendation": stored.recommendation,
                "created_at": stored.created_at.isoformat() if stored.created_at else None,
            }

        profile_text = await UserRepository(session).get_profile_openai_text(user_id)
        has_profile = bool((profile_text or "").strip())
        out["profile"] = {
            "has_profile": has_profile,
            "profile_chars": len(profile_text or ""),
        }

    timer.mark(
        "load_job_and_profile",
        has_extraction=bool(ext_id),
        has_profile=has_profile,
        has_stored_match=bool(out.get("stored_match")),
    )

    job_text = ""
    if ext_id:
        from app.services.job_match_orchestrator import _get_job_text_from_cache_or_db

        async with get_session() as session:
            job_text = (
                await _get_job_text_from_cache_or_db(
                    ext_id, JobExtractionRepository(session)
                )
            ) or ""
    out["job_text_chars"] = len(job_text)
    timer.mark("load_job_text", chars=len(job_text))

    if not job_text.strip():
        out["errors"].append("no_job_text")
        out["timing"] = timer.report()
        return out
    if not has_profile:
        out["errors"].append("no_profile")
        out["timing"] = timer.report()
        return out

    clearance_required, clearance_phrase = detect_security_clearance(job_text)
    out["clearance_gate"] = {
        "hit": clearance_required,
        "phrase": clearance_phrase,
    }
    timer.mark("clearance_gate", hit=clearance_required, phrase=clearance_phrase)

    from app.services.vector_match_service import compute_vector_match, load_encodings

    job_enc, user_enc = await load_encodings(job_id, user_id)
    out["encodings"] = {
        "have_job": job_enc is not None,
        "have_user": user_enc is not None,
        "job_model": getattr(job_enc, "model_version", None),
        "user_model": getattr(user_enc, "model_version", None),
        "model_match": (
            job_enc is not None
            and user_enc is not None
            and job_enc.model_version == user_enc.model_version
        ),
        "job_skill_count": len(dict(job_enc.skills or {})) if job_enc else 0,
        "user_skill_count": len(dict(user_enc.skills or {})) if user_enc else 0,
    }
    timer.mark("load_encodings", **out["encodings"])

    encoded_now = False
    if (
        encode_if_missing
        and (
            job_enc is None
            or user_enc is None
            or (
                job_enc is not None
                and user_enc is not None
                and job_enc.model_version != user_enc.model_version
            )
        )
    ):
        from app.services.encoding_service import encode_job, encode_user

        job_ok = await encode_job(job_id)
        user_ok = await encode_user(user_id)
        encoded_now = bool(job_ok and user_ok)
        out["inline_encode"] = {"job_ok": job_ok, "user_ok": user_ok}
        timer.mark("inline_encode", job_ok=job_ok, user_ok=user_ok)
        if encoded_now:
            job_enc, user_enc = await load_encodings(job_id, user_id)
            out["encodings"] = {
                "have_job": job_enc is not None,
                "have_user": user_enc is not None,
                "job_model": getattr(job_enc, "model_version", None),
                "user_model": getattr(user_enc, "model_version", None),
                "model_match": (
                    job_enc is not None
                    and user_enc is not None
                    and job_enc.model_version == user_enc.model_version
                ),
                "job_skill_count": len(dict(job_enc.skills or {})) if job_enc else 0,
                "user_skill_count": len(dict(user_enc.skills or {})) if user_enc else 0,
            }
            timer.mark("reload_encodings_after_encode", **out["encodings"])
    else:
        timer.mark("inline_encode_skipped", encode_if_missing=encode_if_missing)

    vector_result = await compute_vector_match(job_id, user_id, explain=True)
    out["vector_result"] = vector_result
    if vector_result is None:
        out["errors"].append("vector_score_unavailable")
        out["warnings"].append("Encodings missing or model versions mismatched")
    else:
        out["ok"] = True
        explain = vector_result.get("explain") or {}
        logger.info(
            "job_match_diagnose_complete",
            job_id=job_id,
            user_id=user_id,
            score=vector_result.get("overall_score"),
            recommendation=vector_result.get("recommendation"),
            duration_ms=None,
            cosines=explain.get("cosines"),
            dimension_scores=vector_result.get("dimension_scores"),
            encoded_now=encoded_now,
        )
    timer.mark(
        "vector_score",
        score=(vector_result or {}).get("overall_score"),
        available=vector_result is not None,
    )

    if persist:
        from app.services.job_match_orchestrator import run_job_match_analysis

        persisted = await run_job_match_analysis(
            job_id, user_id, skip_phase_b=True
        )
        out["persisted_analysis"] = {
            "ok": persisted is not None,
            "overall_score": (persisted or {}).get("overall_score"),
            "match_engine": (persisted or {}).get("match_engine"),
            "should_run_phase_b": (persisted or {}).get("should_run_phase_b"),
        }
        timer.mark(
            "persist_analysis",
            ok=persisted is not None,
            score=(persisted or {}).get("overall_score"),
        )
        if persisted is not None:
            async with get_session() as session:
                stored = await JobMatchRepository(session).get(job_id, user_id)
                if stored:
                    out["stored_match"] = {
                        "overall_score": stored.overall_score,
                        "dimension_scores": stored.dimension_scores,
                        "summary": stored.summary,
                        "strengths": stored.strengths,
                        "gaps": stored.gaps,
                        "recommendation": stored.recommendation,
                        "created_at": (
                            stored.created_at.isoformat() if stored.created_at else None
                        ),
                    }
    else:
        timer.mark("persist_analysis_skipped")

    if include_logs:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            hours=max(1, min(log_hours, 168))
        )
        async with get_session() as session:
            rows = (
                (
                    await session.execute(
                        select(SystemLogEvent)
                        .where(
                            SystemLogEvent.job_id == job_id,
                            SystemLogEvent.created_at >= cutoff,
                        )
                        .order_by(SystemLogEvent.created_at.desc())
                        .limit(100)
                    )
                )
                .scalars()
                .all()
            )
            out["recent_logs"] = [
                {
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                    "level": r.level,
                    "event": r.event,
                    "service": r.service,
                    "duration_ms": r.duration_ms,
                    "message": r.message,
                    "user_id": r.user_id,
                    "payload": r.payload if isinstance(r.payload, dict) else None,
                }
                for r in rows
            ]
        timer.mark("fetch_recent_logs", count=len(out["recent_logs"]))
    else:
        out["recent_logs"] = []
        timer.mark("fetch_recent_logs_skipped")

    timing = timer.report()
    out["timing"] = timing
    logger.info(
        "job_match_analysis_timing",
        job_id=job_id,
        user_id=user_id,
        duration_ms=timing["total_ms"],
        steps=timing["steps"],
        score=(out.get("vector_result") or {}).get("overall_score"),
        ok=out["ok"],
        source="diagnose",
    )
    return out
