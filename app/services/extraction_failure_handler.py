"""Move failed extractions out of the active dashboard into Hidden jobs."""

from __future__ import annotations

from sqlalchemy import select

from app.api.websocket import publish_ws_event
from app.core.logging import get_logger
from app.models.database import Job
from app.services.job_exclusion_types import EXTRACTION_FAILED_EXCLUSION
from app.storage.repository import UserJobStatusRepository

logger = get_logger(__name__)


def _truncate_reason(error: str, *, limit: int = 500) -> str:
    text = (error or "Extraction failed").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


async def mark_extraction_failed_for_user(
    session,
    *,
    job_id: str,
    user_id: str,
    error: str,
) -> None:
    """Hide a job from the user's active list after extraction failure."""
    row = await session.execute(select(Job).where(Job.id == job_id))
    job = row.scalar_one_or_none()
    if not job:
        logger.warning("extraction_failed_job_not_found", job_id=job_id, user_id=user_id)
        return

    job.status = "extraction_failed"
    reason = _truncate_reason(error)

    ujs_repo = UserJobStatusRepository(session)
    await ujs_repo.upsert(
        user_id=user_id,
        job_id=job_id,
        status="duplicated",
        exclusion_type=EXTRACTION_FAILED_EXCLUSION,
        duplicated_because_id=None,
        reason=reason,
    )

    await publish_ws_event({
        "type": "job_excluded_for_user",
        "user_id": user_id,
        "valid_job_id": job_id,
        "exclusion_type": EXTRACTION_FAILED_EXCLUSION,
        "reason": reason,
    })

    logger.info(
        "extraction_failed_hidden_for_user",
        job_id=job_id,
        user_id=user_id,
        reason_preview=reason[:120],
    )
