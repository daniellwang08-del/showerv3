"""LLM quality check of free (vector-engine) match scores.

The free engine scores every visible job for every user. The quality check is
a paid second opinion from a stronger LLM (``match_quality_check_model``,
gpt-5.6-luna by default) that rewrites the score and explanation and fills job
fields the free structuring left empty. It runs when:

  - the user re-runs a job that already has a score (mode ``rescore``, the
    default), or
  - the free engine scores a new job at or above the user's threshold (mode
    ``auto``).

The result goes through the normal per-user save drain, so dedup and
visibility stay consistent, but never chains tailoring or auto-posts: those
already ran (or were skipped) on the free result.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.core.logging import get_logger
from app.models.database import Job, JobExtraction, JobMatchResult, MatchEngineComparison, User
from app.models.schemas import JobDescriptionSchema
from app.services.job_field_utils import clean_optional_job_field, normalize_work_mode_display
from app.storage.database import get_session

logger = get_logger(__name__)

QUALITY_CHECK_MODES = ("off", "rescore", "auto")
DEFAULT_MODE = "rescore"
DEFAULT_MIN_SCORE = 70
ENGINE = "llm_check"
JOB_TYPE = "match_quality_check"
_DAILY_TTL_SECONDS = 60 * 60 * 36


def normalize_mode(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    return value if value in QUALITY_CHECK_MODES else DEFAULT_MODE


def normalize_min_score(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MIN_SCORE
    return max(0, min(100, value))


async def user_quality_check_prefs(user_id: str) -> tuple[str, int]:
    async with get_session() as session:
        row = (
            await session.execute(
                select(User.match_quality_check, User.match_quality_check_min_score).where(User.id == user_id)
            )
        ).one_or_none()
    if row is None:
        return DEFAULT_MODE, DEFAULT_MIN_SCORE
    return normalize_mode(row[0]), normalize_min_score(row[1])


async def resolve_rescore_request(user_id: str, *, requested: bool | None, rescore: bool) -> bool:
    """Whether a user-triggered run should get the LLM check after the free score.

    ``requested`` True/False is an explicit choice from the client; None follows
    the user's setting, where only a re-run of an already-scored job counts.
    """
    if requested is not None:
        return bool(requested)
    if not rescore:
        return False
    mode, _ = await user_quality_check_prefs(user_id)
    return mode in ("rescore", "auto")


async def wants_auto_check(user_id: str, result: dict) -> bool:
    """Auto mode: a new free score at or above the user's threshold."""
    if not eligible_free_result(result):
        return False
    mode, min_score = await user_quality_check_prefs(user_id)
    if mode != "auto":
        return False
    return int(result.get("overall_score") or 0) >= min_score


def eligible_free_result(result: dict | None) -> bool:
    """Only vector-engine results get a second opinion; clearance gates stay final."""
    if not result:
        return False
    if result.get("match_engine") != "vector":
        return False
    return not result.get("requires_security_clearance")


def _daily_key(user_id: str) -> str:
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    return f"match_quality_check:daily:{user_id}:{day}"


async def _daily_cap() -> int:
    try:
        from app.services.system_settings_service import get_effective_value

        return max(0, int(await get_effective_value("match_quality_check_daily_cap_per_user")))
    except Exception:
        from app.core.config import get_settings

        return max(0, int(get_settings().match_quality_check_daily_cap_per_user))


async def take_daily_slot(user_id: str) -> bool:
    """Reserve one check against the user's UTC-day cap. Fails open when Redis is down."""
    cap = await _daily_cap()
    if cap <= 0:
        return True
    try:
        from app.core.redis_support import get_broker_redis

        r = get_broker_redis()
        key = _daily_key(user_id)
        count = int(await r.incr(key) or 0)
        if count == 1:
            await r.expire(key, _DAILY_TTL_SECONDS)
        if count > cap:
            logger.info("match_quality_check_daily_cap_hit", user_id=user_id, cap=cap, count=count)
            return False
        return True
    except Exception as err:
        logger.warning("match_quality_check_daily_cap_failed", user_id=user_id, error=str(err))
        return True


async def _resolved_model(user_id: str) -> str:
    from app.core.config import get_settings
    from app.services.llm_provider_keys_service import resolve_job_llm_credentials

    try:
        async with get_session() as session:
            creds = await resolve_job_llm_credentials(session, job_type=JOB_TYPE, user_id=user_id)
        return str(creds.get("bound_model") or get_settings().openai_model)
    except Exception:
        return get_settings().openai_model


# ── Missing job fields, evidence-checked ──────────────────────────────────


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower())


def _numbers(text: str) -> set[str]:
    return {m.replace(",", "").replace(".", "") for m in re.findall(r"\d[\d,.]*\d|\d", text or "")}


def _salary_supported(value: str, body: str) -> bool:
    nums = {n for n in _numbers(value) if len(n) >= 2}
    if not nums:
        return False
    body_nums = _numbers(body)
    # "$150K" may appear in text as "$150,000" or "150k".
    def seen(n: str) -> bool:
        return n in body_nums or (n.endswith("000") and n[:-3] in body_nums) or f"{n}000" in body_nums
    return all(seen(n) for n in nums)


def _phrase_supported(value: str, body: str) -> bool:
    words = [w for w in re.findall(r"[a-z0-9]+", _norm(value)) if len(w) > 2]
    if not words:
        return False
    lowered = _norm(body)
    return sum(1 for w in words if w in lowered) >= max(1, (len(words) + 1) // 2)


_MODE_EVIDENCE = {
    "remote": re.compile(r"(?i)\bremote|work from (?:home|anywhere)|\bwfh\b|telecommut"),
    "hybrid": re.compile(r"(?i)\bhybrid\b|days? (?:a|per) week (?:in|at)"),
    "onsite": re.compile(r"(?i)on-?\s?site|in[- ]office|in[- ]person|not (?:a )?remote"),
}


def supported_fields(structured: JobDescriptionSchema | None, body: str) -> dict[str, str]:
    """Structured fields from the LLM that the posting text actually backs up."""
    if structured is None or not (body or "").strip():
        return {}
    from app.services.job_text_rules import normalize_employment_type

    out: dict[str, str] = {}
    title = clean_optional_job_field(structured.title)
    if title and title.lower() != "untitled" and _phrase_supported(title, body):
        out["title"] = title
    company = clean_optional_job_field(structured.company)
    if company and _phrase_supported(company, body):
        out["company"] = company
    location = clean_optional_job_field(structured.location)
    if location and _phrase_supported(location.split(",")[0], body):
        out["location"] = location
    salary = clean_optional_job_field(structured.salary_range)
    if salary and _salary_supported(salary, body):
        out["salary_range"] = salary
    employment = normalize_employment_type(clean_optional_job_field(structured.employment_type))
    if employment and _phrase_supported(employment.replace("-", " "), body.replace("-", " ")):
        out["employment_type"] = employment
    mode = normalize_work_mode_display(structured.work_mode)
    if mode and _MODE_EVIDENCE[mode].search(body):
        out["work_mode"] = mode
    return out


async def fill_missing_job_fields(job_id: str, ext_id: str, fields: dict[str, str]) -> list[str]:
    """Write only into empty columns; ATS and rule values are never replaced."""
    if not fields:
        return []
    filled: list[str] = []
    async with get_session() as session:
        extraction = await session.get(JobExtraction, ext_id)
        job = await session.get(Job, job_id)
        for key, value in fields.items():
            for row in (extraction, job):
                if row is None or not hasattr(row, key):
                    continue
                current = clean_optional_job_field(getattr(row, key))
                if key == "title" and (current or "").lower() == "untitled":
                    current = None
                if current:
                    continue
                limit = 20 if key == "work_mode" else (200 if key == "salary_range" else 500)
                setattr(row, key, value[:limit])
                if key not in filled:
                    filled.append(key)
        if extraction is not None and filled:
            meta = dict(extraction.raw_metadata or {})
            meta["llm_check_filled_fields"] = sorted(set(meta.get("llm_check_filled_fields") or []) | set(filled))
            extraction.raw_metadata = meta
    return filled


# ── The check ─────────────────────────────────────────────────────────────


async def run_match_quality_check(job_id: str, user_id: str) -> dict | None:
    """LLM score + explanation for one pair, shaped like an orchestrator result."""
    from app.services.job_match_orchestrator import _load_job_and_profile
    from app.services.job_match_service import analyze_job_match_phase_a

    loaded = await _load_job_and_profile(job_id, user_id, None)
    if not loaded:
        return None
    ext_id, job_text, profile_text = loaded
    if not (profile_text or "").strip():
        return None

    async with get_session() as session:
        prior = (
            await session.execute(
                select(JobMatchResult).where(JobMatchResult.job_id == job_id, JobMatchResult.user_id == user_id)
            )
        ).scalar_one_or_none()
        prior_score = int(prior.overall_score or 0) if prior else None
        prior_dims = dict(prior.dimension_scores or {}) if prior else {}
        prior_engine = prior.match_engine if prior else None

    if not await take_daily_slot(user_id):
        return {"status": "capped"}

    model = await _resolved_model(user_id)
    result, structured_job, is_job_posting = await analyze_job_match_phase_a(
        job_text, profile_text, user_id=user_id, job_type=JOB_TYPE
    )

    filled: list[str] = []
    try:
        filled = await fill_missing_job_fields(job_id, ext_id, supported_fields(structured_job, job_text))
    except Exception as err:
        logger.warning("match_quality_check_fill_failed", job_id=job_id, error=str(err))

    if prior_score is not None and prior_engine == "vector" and is_job_posting:
        try:
            async with get_session() as session:
                session.add(
                    MatchEngineComparison(
                        job_id=job_id,
                        user_id=user_id,
                        llm_overall=int(result.get("overall_score") or 0),
                        vector_overall=prior_score,
                        llm_dimensions=dict(result.get("dimension_scores") or {}),
                        vector_dimensions=prior_dims,
                    )
                )
        except Exception as err:
            logger.warning("match_quality_check_compare_failed", job_id=job_id, error=str(err))

    result.update(
        {
            "is_job_posting": bool(is_job_posting),
            "extraction_id": ext_id,
            "structured_company": clean_optional_job_field(structured_job.company) if structured_job else None,
            "should_run_phase_b": False,
            "skip_phase_b": True,
            "match_engine": ENGINE,
            "scorer_version": None,
            "model_version": model[:200],
            "inputs_fingerprint": None,
            "quality_check_result": True,
            "free_score": prior_score,
            "filled_fields": filled,
        }
    )
    logger.info(
        "match_quality_check_complete",
        job_id=job_id,
        user_id=user_id,
        model=model,
        free_score=prior_score,
        llm_score=result.get("overall_score"),
        is_job_posting=is_job_posting,
        filled_fields=filled,
    )
    return result
