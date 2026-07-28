"""Shared auto-post eligibility filters for Google Sheets + Pumble.

Filter shape (persisted JSON on each integration config):

* ``work_modes`` — allow-list of ``remote`` / ``hybrid`` / ``onsite``
  (empty = any work mode). Resolution uses the same signal stack as
  ``resolve_display_work_mode`` (Job.work_mode, location, remote_policy, is_remote).
* ``exclude_companies`` — block-list; match any entry (case-insensitive
  substring) → skip auto-post (e.g. previous employers).

``auto_post_threshold`` remains the minimum match score (separate column).

Legacy keys (``remote_only``, ``companies``, ``company_contains``, …) are
accepted on read: include lists are dropped; ``remote_only`` maps to
``work_modes=["remote"]``.
"""

from __future__ import annotations

from typing import Any

from app.models.database import Job
from app.services.job_field_utils import resolve_display_work_mode

KNOWN_WORK_MODES: tuple[str, ...] = ("remote", "hybrid", "onsite")


def default_auto_post_filters() -> dict[str, Any]:
    return {
        "work_modes": [],
        "exclude_companies": [],
    }


def _clean_string_list(raw: Any) -> list[str]:
    if isinstance(raw, str) and raw.strip():
        raw = [p.strip() for p in raw.split(",")]
    if not isinstance(raw, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw:
        name = str(item or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(name)
    return cleaned


def _clean_work_modes(raw: Any) -> list[str]:
    if isinstance(raw, str) and raw.strip():
        raw = [raw]
    if not isinstance(raw, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw:
        mode = str(item or "").strip().lower()
        if mode == "on-site":
            mode = "onsite"
        if mode not in KNOWN_WORK_MODES or mode in seen:
            continue
        seen.add(mode)
        cleaned.append(mode)
    return cleaned


def normalize_auto_post_filters(raw: Any) -> dict[str, Any]:
    """Coerce persisted/API payload into the current filters dict."""
    base = default_auto_post_filters()
    if not isinstance(raw, dict):
        return base

    work_modes = _clean_work_modes(raw.get("work_modes"))
    if not work_modes and bool(raw.get("remote_only")):
        work_modes = ["remote"]
    base["work_modes"] = work_modes

    exclude = _clean_string_list(
        raw.get("exclude_companies")
        if raw.get("exclude_companies") is not None
        else raw.get("companies_exclude")
    )
    base["exclude_companies"] = exclude
    return base


def resolve_job_work_mode(job: Job) -> str | None:
    """Resolve job work mode to remote|hybrid|onsite (or None if unknown)."""
    meta = job.raw_metadata if isinstance(job.raw_metadata, dict) else {}
    location = getattr(job, "location", None) or meta.get("location")
    remote_policy = meta.get("remote_policy")
    is_remote = bool(meta.get("is_remote"))
    if not is_remote and isinstance(meta.get("is_remote"), str):
        is_remote = meta.get("is_remote", "").strip().lower() in {"1", "true", "yes"}

    return resolve_display_work_mode(
        analysis_work_mode=job.work_mode,
        location=str(location) if location else None,
        remote_policy=str(remote_policy) if remote_policy else None,
        is_remote=is_remote,
    )


def _company_matches_any(company: str, needles: list[str]) -> bool:
    if not needles:
        return False
    hay = (company or "").lower()
    if not hay:
        return False
    return any(n.lower() in hay for n in needles)


def job_matches_auto_post_filters(job: Job, filters: dict[str, Any] | None) -> bool:
    """Return True when *job* passes the normalized auto-post filters."""
    f = normalize_auto_post_filters(filters)

    modes = f["work_modes"]
    if modes:
        resolved = resolve_job_work_mode(job)
        if resolved is None or resolved not in modes:
            return False

    exclude = f["exclude_companies"]
    if exclude and _company_matches_any(job.company or "", exclude):
        return False

    return True
