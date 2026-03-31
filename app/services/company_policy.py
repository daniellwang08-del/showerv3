from datetime import datetime
from sqlalchemy import select

from app.models.database import ValidJob, InvalidJob
from app.core.logging import get_logger

logger = get_logger(__name__)


def normalize_company(company: str | None) -> str:
    if not company:
        return ""
    return " ".join(company.strip().lower().split())


async def enforce_one_active_job_per_company(
    session,
    valid_job_id: str,
    *,
    company_name: str | None = None,
) -> None:
    """
    Keep only one active valid job per company.
    If another active valid job already exists for same company, move current job to invalid.
    """
    row = await session.execute(select(ValidJob).where(ValidJob.id == valid_job_id))
    current = row.scalar_one_or_none()
    if not current or not current.is_active:
        return

    effective_company = company_name or current.company
    company_key = normalize_company(effective_company)
    if not company_key:
        return

    # Keep current row's company aligned with the structured source used for comparison.
    if company_name and normalize_company(current.company) != company_key:
        current.company = company_name.strip()

    all_rows = await session.execute(
        select(ValidJob)
        .where(ValidJob.is_active == True)
        .order_by(ValidJob.created_at.asc())
    )
    same_company = [
        j
        for j in all_rows.scalars().all()
        if normalize_company(j.company) == company_key
    ]

    if len(same_company) <= 1:
        return

    canonical = same_company[0]
    if canonical.id == current.id:
        return

    reason = (
        f"Company policy duplicate: only one active application per company. "
        f"Keeping earliest job for '{effective_company}'."
    )

    invalid = InvalidJob(
        source_url=current.source_url,
        normalized_url=current.normalized_url,
        domain=current.domain,
        title=current.title,
        company=current.company,
        location=current.location,
        description=current.description,
        posted_date=current.posted_date,
        experience_level=current.experience_level,
        industry=current.industry,
        raw_metadata=current.raw_metadata or {},
        duplicate_of_job_id=canonical.id,
        duplication_reason=reason,
        similarity_score=1.0,
        similarity_hash=current.similarity_hash,
        is_active=True,
    )
    session.add(invalid)

    current.is_active = False
    current.updated_at = datetime.utcnow()

    logger.info(
        "single_company_policy_moved_to_invalid",
        valid_job_id=current.id,
        duplicate_of=canonical.id,
        company=current.company,
    )

