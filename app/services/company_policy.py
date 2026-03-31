from datetime import datetime
from sqlalchemy import select

from app.models.database import (
    InvalidJob,
    JobMatchResult,
    ValidJob,
    ValidJobUserApplication,
)
from app.core.logging import get_logger

logger = get_logger(__name__)


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
        title=job.title,
        company=job.company,
        location=job.location,
        description=job.description,
        posted_date=job.posted_date,
        experience_level=job.experience_level,
        industry=job.industry,
        raw_metadata=job.raw_metadata or {},
        duplicate_of_job_id=duplicate_of_job_id,
        duplication_reason=reason,
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
    Company dedupe rule after OpenAI match result:
    1) If any previously saved same-company job is already applied by this user,
       new job becomes duplicate.
    2) Else compare match score with previous same-company jobs for this user:
       - new score > previous best => keep new as valid and demote older company jobs
       - new score <= previous best => new becomes duplicate
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
        current.company = company_name.strip()

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
            reason=f"Company duplicate: existing applied job retained for '{effective_company}'.",
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
        return

    best_prev_id, best_prev_score = max(score_by_job_id.items(), key=lambda kv: kv[1])
    if new_match_score <= best_prev_score:
        await _demote_valid_job_to_invalid(
            session,
            current.id,
            duplicate_of_job_id=best_prev_id,
            reason=(
                f"Company duplicate: lower match score ({new_match_score}) "
                f"than previous best ({best_prev_score}) for '{effective_company}'."
            ),
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
            reason=(
                f"Company duplicate: replaced by higher match score job ({new_match_score}) "
                f"for '{effective_company}'."
            ),
            similarity_score=(float(prev_score) / 100.0) if prev_score is not None else None,
        )

