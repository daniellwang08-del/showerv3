"""Shared vs personal job pipeline rules.

Admin / platform ingest prepares a shared job description (extraction only).
Applicant ingest and "prepare" run personal analysis → tailor → resume build.

``manual_submit_pipeline`` (per-user) controls depth for URL/paste submits:
  - ``extract`` — shared JD only (no personal analysis chain)
  - ``match`` — extraction + Phase A only (``skip_phase_b``)
  - ``full`` — extraction + Phase A + Phase B when platform allows (default)
"""

from __future__ import annotations

from typing import Any, Literal

ManualSubmitPipeline = Literal["extract", "match", "full"]
VALID_MANUAL_SUBMIT_PIPELINES = frozenset({"extract", "match", "full"})


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
        # Shared scrape only — user is already linked via UserJobStatus.
        return None, False, False
    if mode == "match":
        return uid, True, True
    return uid, True, False
