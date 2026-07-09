"""Detect and exclude LinkedIn job posting URLs from the extraction pipeline.

Aggregators (Jobright, etc.) often surface ``linkedin.com/jobs/...`` links. Those
postings are not extractable in this product, so they are removed when the
extraction stage starts rather than wasting worker time or cluttering the dashboard.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from sqlalchemy import select

from app.api.websocket import publish_ws_event
from app.core.logging import get_logger
from app.models.database import Job
from app.services.job_exclusion_types import LINKEDIN_JOB_EXCLUSION
from app.storage.repository import UserJobStatusRepository

logger = get_logger(__name__)

LINKEDIN_JOB_BLOCK_REASON = (
    "LinkedIn job postings are not supported and were removed automatically."
)

# Job board paths on linkedin.com (not profile /in/... URLs).
_LINKEDIN_JOB_PATH = re.compile(r"/jobs(?:/|$)", re.IGNORECASE)


def is_linkedin_job_url(url: str | None) -> bool:
    """Return True when *url* points at a LinkedIn job posting."""
    if not url or not str(url).strip():
        return False
    try:
        parsed = urlparse(str(url).strip())
    except Exception:
        return False

    host = (parsed.netloc or "").lower()
    if host != "linkedin.com" and not host.endswith(".linkedin.com"):
        return False

    path = parsed.path or ""
    # User profile URLs must never be treated as job postings.
    if re.search(r"/in(?:/|$)", path, re.IGNORECASE):
        return False

    return bool(_LINKEDIN_JOB_PATH.search(path))


def linkedin_job_block_reason(url: str | None) -> str | None:
    """Return the block reason when *url* is a LinkedIn job posting, else None."""
    return LINKEDIN_JOB_BLOCK_REASON if is_linkedin_job_url(url) else None


async def mark_linkedin_job_excluded_for_user(
    session,
    *,
    job_id: str,
    user_id: str,
) -> None:
    """Hide a LinkedIn job from the user's active dashboard."""
    row = await session.execute(select(Job).where(Job.id == job_id))
    job = row.scalar_one_or_none()
    if not job:
        logger.warning("linkedin_job_exclude_job_not_found", job_id=job_id, user_id=user_id)
        return

    job.status = "blocked"

    ujs_repo = UserJobStatusRepository(session)
    await ujs_repo.upsert(
        user_id=user_id,
        job_id=job_id,
        status="duplicated",
        exclusion_type=LINKEDIN_JOB_EXCLUSION,
        duplicated_because_id=None,
        reason=LINKEDIN_JOB_BLOCK_REASON,
    )

    await publish_ws_event({
        "type": "job_excluded_for_user",
        "user_id": user_id,
        "valid_job_id": job_id,
        "exclusion_type": LINKEDIN_JOB_EXCLUSION,
        "reason": LINKEDIN_JOB_BLOCK_REASON,
    })

    logger.info("linkedin_job_excluded_for_user", job_id=job_id, user_id=user_id)
