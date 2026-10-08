"""Shared vs personal job pipeline rules.

Admin / platform ingest prepares a shared job description (extraction only).
Applicant ingest and "prepare" run personal analysis → tailor → resume build.

``manual_submit_pipeline`` (per-user) controls depth for URL/paste submits:
  - ``extract`` - shared JD only (no personal analysis chain)
  - ``match`` - extraction + Phase A only (``skip_phase_b``)
  - ``full`` - extraction + Phase A + Phase B when platform allows (default)
"""

from __future__ import annotations

from typing import Any, Literal

ManualSubmitPipeline = Literal["extract", "match", "full"]
VALID_MANUAL_SUBMIT_PIPELINES = frozenset({"extract", "match", "full"})

ApplicationResumeSource = Literal["original", "tailored"]


def normalize_application_resume_source(raw: Any) -> ApplicationResumeSource:
    return "original" if str(raw or "").strip().lower() == "original" else "tailored"


def has_tailored_resume(data: Any) -> bool:
    """True when a build row holds real tailored résumé content.

    Autofill also caches lookups on that column, so a dict alone is not enough.
    """
    if not isinstance(data, dict):
        return False
    return bool(data.get("work_experience") or data.get("profile_summary") or data.get("technical_skills"))


def documents_ready_clause(build_model: Any) -> Any:
    """SQL: the job's application documents are built.

    Tailored mode needs the tailored résumé. Original résumé mode builds only
    the cover letter (résumé files are ``skipped``), so that counts too.
    """
    from sqlalchemy import and_, or_

    return or_(
        build_model.resume_docx_status == "completed",
        and_(
            build_model.resume_docx_status == "skipped",
            build_model.cover_letter_docx_status == "completed",
        ),
    )


DOCUMENTS_READY_SQL = (
    "(rb.resume_docx_status = 'completed' OR "
    "(rb.resume_docx_status = 'skipped' AND rb.cover_letter_docx_status = 'completed'))"
)


async def user_uses_original_resume(user_id: str | None) -> bool:
    """True when the user applies with their original résumé (no per-job tailoring)."""
    if not user_id:
        return False
    from sqlalchemy import select

    from app.models.database import User
    from app.storage.database import get_session

    async with get_session() as session:
        raw = (
            await session.execute(select(User.application_resume_source).where(User.id == user_id))
        ).scalar_one_or_none()
    return normalize_application_resume_source(raw) == "original"


def normalize_manual_submit_pipeline(raw: Any) -> ManualSubmitPipeline:
    value = str(raw or "full").strip().lower()
    if value in VALID_MANUAL_SUBMIT_PIPELINES:
        return value  # type: ignore[return-value]
    return "full"


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

    ``extracted`` = scrape finished (shared raw JD ready).
    ``completed`` = Phase A structured the posting (also implies scrape finished).

    Does not touch deferred ORM columns so list queries stay safe.
    """
    if extraction is None:
        return False

    status = getattr(extraction, "status", None)
    status_value = getattr(status, "value", status)
    return status_value in ("extracted", "completed")


def manual_submit_enqueue_flags(
    pipeline: ManualSubmitPipeline,
    *,
    is_admin: bool,
    user_id: str | None,
) -> tuple[str | None, bool, bool]:
    """Return ``(extract_user_id, chain_analysis, skip_phase_b)`` for submit enqueue.

    Admin always extract-only. Applicant depth comes from ``pipeline``.
    """
    if is_admin or not user_id:
        return None, False, False
    uid = str(user_id)
    mode = normalize_manual_submit_pipeline(pipeline)
    if mode == "extract":
        # Shared scrape only, user is already linked via UserJobStatus.
        return None, False, False
    if mode == "match":
        return uid, True, True
    return uid, True, False
