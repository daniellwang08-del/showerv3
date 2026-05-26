"""Layer 2 post-analysis deduplication engine.

After OpenAI analysis returns a match score for a job, this module decides
whether the job should be saved as active, marked as duplicated, or skipped
entirely based on same-company comparisons within the user's recycle window.

Rules (applied in order):
  0. Minimum match score — score below user's threshold → duplicated (below_min_score).
  1. Same URL — another active job with identical normalized_url → duplicated (same_url).
  2. Strict similarity — same title + same company → duplicated.
  3. Applied at same company — user already applied within recycle window → duplicated.
  4. Score comparison — keep the higher-scoring job active; mark the other duplicated.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta

from sqlalchemy import and_, select

from app.models.database import Job, JobMatchResult, ValidJobUserApplication, UserJobStatus
from app.services.job_exclusion_types import (
    APPLIED_COMPANY_EXCLUSION,
    BELOW_MIN_SCORE_EXCLUSION,
    LOWER_SCORE_EXCLUSION,
    SAME_URL_EXCLUSION,
    STRICT_SIMILARITY_EXCLUSION,
    SUPERSEDED_BY_HIGHER_EXCLUSION,
)
from app.storage.repository import JobMatchRepository, UserJobStatusRepository
from app.storage.database import get_session
from app.api.websocket import publish_ws_event
from app.core.logging import get_logger

logger = get_logger(__name__)

_PLACEHOLDER_COMPANIES = frozenset({
    "unknown", "n/a", "na", "none", "tbd", "not specified",
    "confidential", "company", "employer", "hiring company",
})

_EMPLOYER_SLUG_FROM_URL = re.compile(
    r"welcometothejungle\.com/(?:[a-z]{2}/)?companies/([^/?#]+)/",
    re.IGNORECASE,
)

_TITLE_STRIP_RE = re.compile(r"[^\w\s]")


def normalize_company(company: str | None) -> str:
    if not company:
        return ""
    normalized = " ".join(company.strip().lower().split())
    normalized = re.sub(
        r"\b(inc\.?|llc|corp\.?|ltd\.?|co\.?|corporation|limited)\b",
        "",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(r"[^\w\s]", "", normalized)
    normalized = " ".join(normalized.split())
    if normalized in _PLACEHOLDER_COMPANIES:
        return ""
    return normalized


def employer_slug_from_url(url: str | None) -> str:
    """Stable employer id from job board URL (e.g. ``plus-que-pro`` on WTTJ)."""
    if not url:
        return ""
    match = _EMPLOYER_SLUG_FROM_URL.search(url.strip())
    return match.group(1).lower() if match else ""


def resolve_employer_key(job: Job, *, company_name: str | None = None) -> str:
    """Canonical grouping key for same-employer dedup.

    Prefer URL org slug (stable across LLM rewrites), then normalized company name.
    """
    slug = employer_slug_from_url(job.source_url)
    if slug:
        return f"slug:{slug}"

    meta = job.raw_metadata if isinstance(job.raw_metadata, dict) else {}
    for candidate in (company_name, job.company, meta.get("scraped_company_name")):
        normalized = normalize_company(candidate if isinstance(candidate, str) else None)
        if normalized:
            return f"name:{normalized}"
    return ""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _effective_date(job: Job) -> datetime:
    if job.posted_date:
        d = job.posted_date
        if d.tzinfo is not None:
            d = d.replace(tzinfo=None)
        return d
    return job.created_at.replace(tzinfo=None) if job.created_at.tzinfo else job.created_at


def _within_recycle_window(job: Job, recycle_days: int) -> bool:
    """True when the job falls inside the dedup comparison window."""
    cutoff = _utcnow() - timedelta(days=recycle_days)
    return _effective_date(job) >= cutoff


def _normalize_title(title: str | None) -> str:
    """Lowercase, strip whitespace, remove punctuation for comparison."""
    if not title:
        return ""
    lowered = title.strip().lower()
    if lowered in {"none", "null", "unknown", "unknown position", "n/a", "na", "untitled", "untitled job"}:
        return ""
    return _TITLE_STRIP_RE.sub("", lowered).strip()


async def _find_same_url_active_duplicate(
    session,
    *,
    user_id: str,
    job_id: str,
    normalized_url: str | None,
) -> Job | None:
    url = (normalized_url or "").strip()
    if not url:
        return None
    result = await session.execute(
        select(Job)
        .join(
            UserJobStatus,
            and_(
                UserJobStatus.job_id == Job.id,
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "active",
            ),
        )
        .where(
            Job.status == "active",
            Job.normalized_url == url,
            Job.id != job_id,
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _list_active_peer_jobs(
    session,
    *,
    user_id: str,
    job_id: str,
    employer_key: str,
    recycle_days: int,
) -> list[Job]:
    """Active jobs for this user at the same employer within the recycle window."""
    if not employer_key:
        return []

    result = await session.execute(
        select(Job)
        .join(
            UserJobStatus,
            and_(
                UserJobStatus.job_id == Job.id,
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "active",
            ),
        )
        .where(
            Job.status == "active",
            Job.id != job_id,
        )
    )
    return [
        job
        for job in result.scalars().all()
        if resolve_employer_key(job) == employer_key and _within_recycle_window(job, recycle_days)
    ]


async def run_post_analysis_dedup(
    job_id: str,
    user_id: str,
    match_data: dict,
    extraction_id: str | None,
    recycle_days: int = 60,
    min_match_score: int = 0,
) -> dict:
    """Returns {"action": "saved_active"|"saved_duplicated"|"skipped", ...}"""

    overall_score = match_data.get("overall_score", 0)

    async with get_session() as session:
        row = await session.execute(select(Job).where(Job.id == job_id))
        current_job = row.scalar_one_or_none()
        if not current_job:
            logger.warning("post_analysis_dedup_job_not_found", job_id=job_id)
            return {"action": "skipped", "reason": "job_not_found"}

        if min_match_score > 0 and overall_score < min_match_score:
            logger.info(
                "post_analysis_dedup_below_min_score",
                job_id=job_id,
                user_id=user_id,
                score=overall_score,
                min_score=min_match_score,
            )
            return await _save_duplicated(
                session,
                job_id=job_id,
                user_id=user_id,
                match_data=match_data,
                overall_score=overall_score,
                duplicated_because_id=None,
                exclusion_type=BELOW_MIN_SCORE_EXCLUSION,
                reason=(
                    f"Match score {overall_score}% is below your minimum threshold "
                    f"({min_match_score}%)."
                ),
            )

        url_duplicate = await _find_same_url_active_duplicate(
            session,
            user_id=user_id,
            job_id=job_id,
            normalized_url=current_job.normalized_url,
        )
        if url_duplicate:
            logger.info(
                "post_analysis_dedup_same_url",
                job_id=job_id,
                existing_job_id=url_duplicate.id,
                user_id=user_id,
            )
            return await _save_duplicated(
                session,
                job_id=job_id,
                user_id=user_id,
                match_data=match_data,
                overall_score=overall_score,
                duplicated_because_id=url_duplicate.id,
                exclusion_type=SAME_URL_EXCLUSION,
                reason="Same job URL already exists in your active list.",
            )

        employer_key = resolve_employer_key(current_job)
        if not employer_key:
            return await _save_active(session, job_id, user_id, match_data, overall_score)

        same_company_jobs = await _list_active_peer_jobs(
            session,
            user_id=user_id,
            job_id=job_id,
            employer_key=employer_key,
            recycle_days=recycle_days,
        )

        if not same_company_jobs:
            return await _save_active(session, job_id, user_id, match_data, overall_score)

        current_title_norm = _normalize_title(current_job.title)
        for existing_job in same_company_jobs:
            existing_title_norm = _normalize_title(existing_job.title)
            if not (current_title_norm and existing_title_norm and current_title_norm == existing_title_norm):
                continue

            match_row = await session.execute(
                select(JobMatchResult).where(
                    JobMatchResult.job_id == existing_job.id,
                    JobMatchResult.user_id == user_id,
                )
            )
            existing_match = match_row.scalar_one_or_none()
            existing_score_str = str(existing_match.overall_score) if existing_match else "n/a"
            logger.info(
                "post_analysis_dedup_strict_similarity",
                job_id=job_id,
                existing_job_id=existing_job.id,
                existing_score=existing_score_str,
                new_score=overall_score,
            )
            return await _save_duplicated(
                session,
                job_id=job_id,
                user_id=user_id,
                match_data=match_data,
                overall_score=overall_score,
                duplicated_because_id=existing_job.id,
                exclusion_type=STRICT_SIMILARITY_EXCLUSION,
                reason="Same title and company as an existing active posting.",
            )

        pool_ids = [j.id for j in same_company_jobs]
        applied_result = await session.execute(
            select(ValidJobUserApplication).where(
                ValidJobUserApplication.user_id == user_id,
                ValidJobUserApplication.job_id.in_(pool_ids),
            )
        )
        applied = list(applied_result.scalars().all())
        if applied:
            applied_job_id = applied[0].job_id
            return await _save_duplicated(
                session,
                job_id=job_id,
                user_id=user_id,
                match_data=match_data,
                overall_score=overall_score,
                duplicated_because_id=applied_job_id,
                exclusion_type=APPLIED_COMPANY_EXCLUSION,
                reason=(
                    f"User already applied to another posting at this company "
                    f"within the {recycle_days}-day recycle window."
                ),
            )

        match_rows_result = await session.execute(
            select(JobMatchResult).where(
                JobMatchResult.user_id == user_id,
                JobMatchResult.job_id.in_(pool_ids),
            )
        )
        existing_matches = list(match_rows_result.scalars().all())
        if not existing_matches:
            return await _save_active(session, job_id, user_id, match_data, overall_score)

        best_existing = max(existing_matches, key=lambda m: m.overall_score)
        best_existing_score = best_existing.overall_score

        if overall_score > best_existing_score:
            result = await _save_active(session, job_id, user_id, match_data, overall_score)
            ujs_repo = UserJobStatusRepository(session)
            await ujs_repo.upsert(
                user_id=user_id,
                job_id=best_existing.job_id,
                status="duplicated",
                exclusion_type=SUPERSEDED_BY_HIGHER_EXCLUSION,
                duplicated_because_id=job_id,
                reason=(
                    f"Superseded by a higher-scoring posting at the same company "
                    f"({overall_score}% vs {best_existing_score}%)."
                ),
                match_score_at_decision=float(best_existing_score),
            )
            await publish_ws_event({
                "type": "job_status_changed",
                "user_id": user_id,
                "job_id": best_existing.job_id,
                "status": "duplicated",
                "exclusion_type": SUPERSEDED_BY_HIGHER_EXCLUSION,
            })
            result["flipped_job_id"] = best_existing.job_id
            return result

        return await _save_duplicated(
            session,
            job_id=job_id,
            user_id=user_id,
            match_data=match_data,
            overall_score=overall_score,
            duplicated_because_id=best_existing.job_id,
            exclusion_type=LOWER_SCORE_EXCLUSION,
            reason=(
                f"Lower or equal match score ({overall_score}% vs "
                f"{best_existing_score}%) at the same company."
            ),
        )


async def _save_active(
    session,
    job_id: str,
    user_id: str,
    match_data: dict,
    overall_score: int,
) -> dict:
    """Save match result and set user_job_status to active."""
    match_repo = JobMatchRepository(session)
    await match_repo.upsert(
        job_id=job_id,
        user_id=user_id,
        overall_score=overall_score,
        dimension_scores=match_data.get("dimension_scores", {}),
        summary=match_data.get("summary", ""),
        strengths=match_data.get("strengths", []),
        gaps=match_data.get("gaps", []),
        recommendation=match_data.get("recommendation", ""),
    )

    ujs_repo = UserJobStatusRepository(session)
    await ujs_repo.upsert(
        user_id=user_id,
        job_id=job_id,
        status="active",
        match_score_at_decision=float(overall_score),
    )

    await publish_ws_event({
        "type": "job_status_changed",
        "user_id": user_id,
        "job_id": job_id,
        "status": "active",
    })

    logger.info("post_analysis_dedup_saved_active", job_id=job_id, user_id=user_id, score=overall_score)
    return {"action": "saved_active", "job_id": job_id, "score": overall_score}


async def _save_duplicated(
    session,
    *,
    job_id: str,
    user_id: str,
    match_data: dict,
    overall_score: int,
    duplicated_because_id: str | None,
    exclusion_type: str,
    reason: str,
) -> dict:
    """Save match result and set user_job_status to duplicated."""
    match_repo = JobMatchRepository(session)
    await match_repo.upsert(
        job_id=job_id,
        user_id=user_id,
        overall_score=overall_score,
        dimension_scores=match_data.get("dimension_scores", {}),
        summary=match_data.get("summary", ""),
        strengths=match_data.get("strengths", []),
        gaps=match_data.get("gaps", []),
        recommendation=match_data.get("recommendation", ""),
    )

    ujs_repo = UserJobStatusRepository(session)
    await ujs_repo.upsert(
        user_id=user_id,
        job_id=job_id,
        status="duplicated",
        exclusion_type=exclusion_type,
        duplicated_because_id=duplicated_because_id,
        reason=reason,
        match_score_at_decision=float(overall_score),
    )

    await publish_ws_event({
        "type": "job_status_changed",
        "user_id": user_id,
        "job_id": job_id,
        "status": "duplicated",
        "exclusion_type": exclusion_type,
    })

    logger.info(
        "post_analysis_dedup_saved_duplicated",
        job_id=job_id,
        user_id=user_id,
        score=overall_score,
        exclusion_type=exclusion_type,
        because_id=duplicated_because_id,
    )
    return {
        "action": "saved_duplicated",
        "job_id": job_id,
        "score": overall_score,
        "exclusion_type": exclusion_type,
        "duplicated_because_id": duplicated_because_id,
        "reason": reason,
    }
