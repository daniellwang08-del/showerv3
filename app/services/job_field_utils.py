"""Shared helpers for normalizing job title/company fields from LLM or DB values."""

from __future__ import annotations

_INVALID_JOB_FIELD_VALUES = frozenset({
    "none",
    "null",
    "n/a",
    "na",
    "unknown",
    "unknown position",
    "untitled",
    "tbd",
    "not specified",
})

_DESCRIPTION_TITLE_SKIP = frozenset({
    "description",
    "requirements",
    "responsibilities",
    "benefits",
    "about the role",
    "about us",
    "job description",
    "overview",
})


def clean_optional_job_field(value) -> str | None:
    """Return a stripped string or None for empty/placeholder values."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in _INVALID_JOB_FIELD_VALUES:
        return None
    return text


def parse_job_title(value) -> str:
    """Parse a structured job title, never returning the literal string 'None'."""
    return clean_optional_job_field(value) or "Unknown Position"


def infer_title_from_description(description: str | None) -> str | None:
    """Best-effort title recovery when the LLM omits structured_job.title."""
    if not description:
        return None
    first_line = description.strip().split("\n", 1)[0].strip()
    if not first_line or len(first_line) > 120:
        return None
    lowered = first_line.lower()
    if lowered in _INVALID_JOB_FIELD_VALUES or lowered in _DESCRIPTION_TITLE_SKIP:
        return None
    if first_line.endswith(":"):
        return None
    return first_line


def resolve_job_display_title(
    *,
    job_title: str | None = None,
    extraction_title: str | None = None,
    submitted_title: str | None = None,
    description: str | None = None,
) -> str | None:
    """Pick the best available title for UI display."""
    for candidate in (job_title, extraction_title, submitted_title):
        cleaned = clean_optional_job_field(candidate)
        if cleaned:
            return cleaned
    return infer_title_from_description(description)


def repair_stored_job_title(
    *,
    current_title: str | None,
    description: str | None = None,
) -> str | None:
    """Normalize a persisted title, inferring from description when corrupted."""
    cleaned = clean_optional_job_field(current_title)
    if cleaned:
        return cleaned
    return infer_title_from_description(description)


# Values that must NOT be treated as a real work-mode classification. The LLM
# writes the sentinel "unknown" whenever it cannot classify; treating that as a
# concrete value (instead of "no signal") previously masked the scraper's
# is_remote flag and left the jobs table blank.
_WORK_MODE_EMPTY_VALUES = frozenset({
    "", "unknown", "none", "null", "n/a", "na", "tbd", "not specified", "undisclosed",
})


def normalize_work_mode_display(value) -> str | None:
    """Map any work_mode string / free-text into ``remote|hybrid|onsite`` or None.

    Returns None for empty, ``"unknown"`` and other placeholder values so callers
    can fall back to other signals. Business rule: "partial(ly) remote" counts as
    ``remote``.
    """
    if value is None:
        return None
    mode = str(value).strip().lower()
    if mode in _WORK_MODE_EMPTY_VALUES:
        return None
    if mode in {"remote", "hybrid", "onsite"}:
        return mode
    if "partial" in mode and "remote" in mode:
        return "remote"
    if "hybrid" in mode or "flexible" in mode:
        return "hybrid"
    if "remote" in mode or "wfh" in mode or "work from home" in mode or "work-from-home" in mode:
        return "remote"
    if (
        "onsite" in mode
        or "on-site" in mode
        or "on site" in mode
        or "in-office" in mode
        or "in office" in mode
        or "in-person" in mode
    ):
        return "onsite"
    return None


def resolve_display_work_mode(
    *,
    analysis_work_mode: str | None = None,
    location: str | None = None,
    remote_policy: str | None = None,
    title: str | None = None,
    is_remote: bool = False,
) -> str | None:
    """Resolve the work mode shown in the jobs table from all available signals.

    Priority order:
      1. An explicit remote/hybrid/onsite classification from analysis/extraction.
      2. Title markers (e.g. ``AI Engineer | REMOTE``) — delimited only.
      3. The location text (e.g. "Remote, United States", "Austin, TX (Hybrid)").
      4. The remote-policy text (e.g. "Remote within the US").
      5. The scraper's ``is_remote`` flag.
    Returns None only when no signal indicates a work mode.
    """
    explicit = normalize_work_mode_display(analysis_work_mode)
    if explicit:
        return explicit
    if title:
        # Delimited markers only — avoid "Remote Support Engineer" false positives.
        from app.services.work_mode_classifier import classify_work_mode_rules

        titled = classify_work_mode_rules(title=title)
        if titled:
            return titled
    for text in (location, remote_policy):
        signal = normalize_work_mode_display(text)
        if signal:
            return signal
    if is_remote:
        return "remote"
    return None
