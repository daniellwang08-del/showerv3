"""Shared helpers for normalizing job title/company fields from LLM or DB values."""

from __future__ import annotations

_INVALID_JOB_FIELD_VALUES = frozenset({
    "none",
    "null",
    "n/a",
    "na",
    "unknown",
    "unknown position",
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
