"""Shared vs personal job pipeline rules.

Admin / platform ingest prepares a shared job description (extraction only).
Applicant ingest and "prepare" run personal analysis → tailor → resume build.
"""

from __future__ import annotations

from typing import Any


def ingest_chain_user_id(*, is_admin: bool, user_id: str | None) -> str | None:
    """User id passed into ``extract_job`` so the worker can chain analysis.

    - Admin (or missing user): ``None`` → extraction only; JD is shared.
    - Applicant: their ``user_id`` → extract then analyze/tailor for them.
    """
    if is_admin or not user_id:
        return None
    return str(user_id)


def extraction_has_shared_jd(extraction: Any | None) -> bool:
    """True when scraped text is available for personal analysis.

    ``extracted`` = scrape finished (``raw_plain_text`` saved).
    ``completed`` = scrape finished and/or structured by Phase A.

    Does not touch deferred ORM columns so list queries stay safe.
    """
    if extraction is None:
        return False

    status = getattr(extraction, "status", None)
    status_value = getattr(status, "value", status)
    return status_value in ("extracted", "completed")
