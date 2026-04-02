from datetime import datetime
from sqlalchemy import select

from app.models.database import (
    InvalidJob,
    JobMatchResult,
    ValidJob,
    ValidJobUserApplication,
)
from app.core.logging import get_logger
from app.storage.repository import _truncate_for_db

logger = get_logger(__name__)

# Must match `invalid_jobs` / `valid_jobs` VARCHAR lengths (PostgreSQL truncates on overflow otherwise).
_VARCHAR_TITLE = 500
_VARCHAR_COMPANY = 500
_VARCHAR_LOCATION = 500
_VARCHAR_DUP_REASON = 500
_VARCHAR_VALID_JOB_COMPANY = 500
# Short snippet for embedding in duplication_reason so the full message stays within 500 chars.
_REASON_COMPANY_SNIPPET = 96


def _clip_varchar(value: str | None, max_len: int) -> str | None:
    """Alias for repository helper; keeps call sites readable."""
    return _truncate_for_db(value, max_len)


def _company_snippet_for_reason(company: str | None) -> str:
    """Short label for duplication_reason text (avoid huge LLM garbage in f-strings)."""
    s = _truncate_for_db(company, _REASON_COMPANY_SNIPPET)
    return s if s else "unknown company"


def normalize_company(company: str | None) -> str:
    if not company:
        return ""
    return " ".join(company.strip().lower().split())


async def _demote_valid_job_to_invalid(
    session,
    valid_job_id: str,
    *,
    duplicate_of_job_id: str,
    reason: str,
    similarity_score: float | None = None,
) -> None:
    row = await session.execute(select(ValidJob).where(ValidJob.id == valid_job_id))
    job = row.scalar_one_or_none()
    if not job or not job.is_active:
        return

    invalid = InvalidJob(
        source_url=job.source_url,
        normalized_url=job.normalized_url,
        domain=job.domain,
        title=_clip_varchar(job.title, _VARCHAR_TITLE),
        company=_clip_varchar(job.company, _VARCHAR_COMPANY) or "Unknown",
        location=_clip_varchar(job.location, _VARCHAR_LOCATION),
        description=job.description,
        posted_date=job.posted_date,
        experience_level=_truncate_for_db(job.experience_level, 100),
        industry=_truncate_for_db(job.industry, 200),
        raw_metadata=job.raw_metadata or {},
        duplicate_of_job_id=duplicate_of_job_id,
        duplication_reason=_clip_varchar(reason, _VARCHAR_DUP_REASON),
        similarity_score=similarity_score,
        similarity_hash=job.similarity_hash,
        is_active=True,
    )
    session.add(invalid)

    job.is_active = False
    job.updated_at = datetime.utcnow()

    logger.info(
        "company_policy_job_demoted_to_invalid",
        valid_job_id=job.id,
        duplicate_of=duplicate_of_job_id,
        company=job.company,
        reason=reason,
    )


async def enforce_company_priority_after_match(
    session,
    valid_job_id: str,
    *,
    user_id: str,
    new_match_score: int,
    company_name: str | None = None,
) -> None:
    """
    Company dedupe rule **after** match analysis (LLM structured job + match score stored).

    Runs once per completed match for the *new* posting (`valid_job_id`). Uses normalized
    company name (from structured LLM output when provided, else the valid_jobs row).

    1) If any other active same-company job was **already applied** by this user → demote
       the **new** job (duplicate of the applied row).
    2) Else if any previous same-company job has a **match score** for this user:
       - new score **>** previous best → demote those older rows (new wins).
       - new score **<=** previous best → demote the **new** job (duplicate of best prior).
    3) Else (same-company rows exist but **none** have a match score yet for this user) →
       the newly analyzed posting wins; older same-company active rows are demoted.
       This avoids leaving multiple active listings for one company when only the new
       job has a score to compare.
    """
    row = await session.execute(select(ValidJob).where(ValidJob.id == valid_job_id))
    current = row.scalar_one_or_none()
    if not current or not current.is_active:
        return

    effective_company = company_name or current.company
    company_key = normalize_company(effective_company)
    if not company_key:
        return

    if company_name and normalize_company(current.company) != company_key:
        current.company = _clip_varchar(company_name.strip(), _VARCHAR_VALID_JOB_COMPANY) or current.company

    all_rows = await session.execute(
        select(ValidJob).where(ValidJob.is_active == True).order_by(ValidJob.created_at.asc())
    )
    same_company = [
        job for job in all_rows.scalars().all()
        if job.id != current.id and normalize_company(job.company) == company_key
    ]
    if not same_company:
        return

    previous_ids = [job.id for job in same_company]
    applied_rows = await session.execute(
        select(ValidJobUserApplication).where(
            ValidJobUserApplication.user_id == user_id,
            ValidJobUserApplication.valid_job_id.in_(previous_ids),
        )
    )
    applied = applied_rows.scalars().all()
    if applied:
        # Any previously-applied job at this company takes precedence over newly seen postings.
        applied_sorted = sorted(applied, key=lambda r: r.applied_at or datetime.min, reverse=True)
        canonical_id = applied_sorted[0].valid_job_id
        await _demote_valid_job_to_invalid(
            session,
            current.id,
            duplicate_of_job_id=canonical_id,
            reason=_clip_varchar(
                f"Company duplicate: existing applied job retained for "
                f"'{_company_snippet_for_reason(effective_company)}'.",
                _VARCHAR_DUP_REASON,
            )
            or "Company duplicate: existing applied job retained.",
            similarity_score=float(new_match_score) / 100.0,
        )
        return

    prev_match_rows = await session.execute(
        select(JobMatchResult).where(
            JobMatchResult.user_id == user_id,
            JobMatchResult.valid_job_id.in_(previous_ids),
        )
    )
    score_by_job_id = {row.valid_job_id: int(row.overall_score) for row in prev_match_rows.scalars().all()}
    if not score_by_job_id:
        # First posting at this company (for this user) to have a match score; older
        # same-company rows have nothing to compare — keep the analyzed job, demote the rest.
        for prev_job in same_company:
            await _demote_valid_job_to_invalid(
                session,
                prev_job.id,
                duplicate_of_job_id=current.id,
                reason=_clip_varchar(
                    f"Company duplicate: superseded by analyzed posting for "
                    f"'{_company_snippet_for_reason(effective_company)}' "
                    f"(no prior match score for comparison).",
                    _VARCHAR_DUP_REASON,
                )
                or "Company duplicate: superseded by analyzed posting.",
                similarity_score=None,
            )
        return

    best_prev_id, best_prev_score = max(score_by_job_id.items(), key=lambda kv: kv[1])
    if new_match_score <= best_prev_score:
        await _demote_valid_job_to_invalid(
            session,
            current.id,
            duplicate_of_job_id=best_prev_id,
            reason=_clip_varchar(
                f"Company duplicate: lower match score ({new_match_score}) "
                f"than previous best ({best_prev_score}) for "
                f"'{_company_snippet_for_reason(effective_company)}'.",
                _VARCHAR_DUP_REASON,
            )
            or "Company duplicate: lower match score than previous best.",
            similarity_score=float(new_match_score) / 100.0,
        )
        return

    # New job wins; demote previous active same-company jobs to keep a single active target.
    for prev_job in same_company:
        prev_score = score_by_job_id.get(prev_job.id)
        await _demote_valid_job_to_invalid(
            session,
            prev_job.id,
            duplicate_of_job_id=current.id,
            reason=_clip_varchar(
                f"Company duplicate: replaced by higher match score job ({new_match_score}) "
                f"for '{_company_snippet_for_reason(effective_company)}'.",
                _VARCHAR_DUP_REASON,
            )
            or "Company duplicate: replaced by higher match score job.",
            similarity_score=(float(prev_score) / 100.0) if prev_score is not None else None,
        )

