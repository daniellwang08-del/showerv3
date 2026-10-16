"""User work-mode allow-list for the jobs board.

``users.work_mode_preferences`` is a list of ``remote`` / ``hybrid`` / ``onsite``.
Empty (or all three) means no filter. Non-empty hides jobs whose resolved work
mode is known and outside the allow-list. Unknown modes stay visible, matching
the country-preferences "keep ambiguous" policy. Jobs the viewer added themselves
always stay visible.
"""

from __future__ import annotations

from typing import Any, Iterable

KNOWN_WORK_MODES: tuple[str, ...] = ("remote", "hybrid", "onsite")


def normalize_work_mode_preferences(values: list[str] | None) -> list[str]:
    """Dedupe and keep only known modes, in stable Remote / Hybrid / Onsite order."""
    if not values:
        return []
    seen: set[str] = set()
    cleaned: list[str] = []
    for item in values:
        mode = str(item or "").strip().lower()
        if mode == "on-site":
            mode = "onsite"
        if mode not in KNOWN_WORK_MODES or mode in seen:
            continue
        seen.add(mode)
        cleaned.append(mode)
    return [m for m in KNOWN_WORK_MODES if m in seen]


def resolved_work_mode_sql_expr():
    """Approximate ``resolve_display_work_mode`` for SQL visibility filters.

    Priority: stored ``Job.work_mode``, then hybrid location text (before remote),
    then remote signals, then onsite location text. Returns NULL when unknown.
    """
    from sqlalchemy import and_, case, or_

    from app.models.database import Job

    hybrid_loc = Job.location.ilike("%hybrid%")
    remote_loc = and_(
        Job.location.ilike("%remote%"),
        ~Job.location.ilike("%hybrid%"),
    )
    onsite_loc = or_(
        Job.location.ilike("%onsite%"),
        Job.location.ilike("%on-site%"),
        Job.location.ilike("%on site%"),
        Job.location.ilike("%in-office%"),
        Job.location.ilike("%in office%"),
    )
    is_remote_meta = Job.raw_metadata["is_remote"].as_boolean() == True  # noqa: E712

    return case(
        (Job.work_mode.in_(list(KNOWN_WORK_MODES)), Job.work_mode),
        (hybrid_loc, "hybrid"),
        (or_(is_remote_meta, remote_loc), "remote"),
        (onsite_loc, "onsite"),
        else_=None,
    )


def work_mode_pool_visibility_clause(user_id: str, allowed_modes: Iterable[str] | None):
    """Keep jobs this viewer added; hide others with a known disallowed work mode."""
    from sqlalchemy import or_

    from app.services.job_location_classifier import job_added_by_user_clause

    allowed = normalize_work_mode_preferences(list(allowed_modes or []))
    if not allowed or len(allowed) >= len(KNOWN_WORK_MODES):
        return None

    resolved = resolved_work_mode_sql_expr()
    # Unknown stays visible; only drop when we know the mode and it is outside.
    return or_(
        job_added_by_user_clause(user_id),
        resolved.is_(None),
        resolved.in_(allowed),
    )


def job_matches_work_mode_preferences(job: Any, allowed_modes: Iterable[str] | None) -> bool:
    """Python-side check used by tests / non-SQL paths."""
    from app.services.auto_post_filters import resolve_job_work_mode

    allowed = normalize_work_mode_preferences(list(allowed_modes or []))
    if not allowed or len(allowed) >= len(KNOWN_WORK_MODES):
        return True
    resolved = resolve_job_work_mode(job)
    if resolved is None:
        return True
    return resolved in allowed
