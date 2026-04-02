"""
Exact URL match at submit time: skip work if the same URL string is already being
extracted or analyzed (no URL normalization — strict string equality on source_url).
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import JobExtraction, JobMatchInProgress, ValidJob
from app.models.schemas import ExtractionStatus
from app.core.logging import get_logger

logger = get_logger(__name__)


async def find_inflight_valid_job_with_same_url(
    session: AsyncSession,
    *,
    source_url: str,
    user_id: str | None,
) -> ValidJob | None:
    """
    Return an active valid job whose `source_url` equals `source_url` exactly and that
    is still in the extraction or (for this user) match-analysis pipeline.

    - Extraction queue: JobExtraction.status is pending or processing.
    - Analysis queue: a JobMatchInProgress row exists for this user and job (match running).
    """
    result = await session.execute(
        select(ValidJob)
        .where(
            ValidJob.source_url == source_url,
            ValidJob.is_active == True,
        )
        .order_by(ValidJob.created_at.asc())
    )
    for vj in result.scalars().all():
        if not vj.extraction_id:
            continue
        ext = await session.get(JobExtraction, vj.extraction_id)
        if not ext:
            continue
        if ext.status in (ExtractionStatus.PENDING, ExtractionStatus.PROCESSING):
            return vj
        if user_id and ext.status == ExtractionStatus.COMPLETED:
            prog = await session.execute(
                select(JobMatchInProgress).where(
                    JobMatchInProgress.valid_job_id == vj.id,
                    JobMatchInProgress.user_id == user_id,
                )
            )
            if prog.scalar_one_or_none():
                return vj
    return None
