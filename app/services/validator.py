"""
Validation for extracted content and structured job data.

Two-stage validation:
1. ``validate_extracted_text`` — after extraction, checks plain text quality.
2. ``validate_job_data`` — after LLM structuring, checks structured output.
"""

import re

from app.models.schemas import JobDescriptionSchema
from app.core.logging import get_logger
from dataclasses import dataclass

logger = get_logger(__name__)

MIN_EXTRACTED_TEXT_LENGTH = 100
MIN_TITLE_LENGTH = 3
MAX_TITLE_LENGTH = 500
MIN_DESCRIPTION_LENGTH = 50

# Patterns that indicate the extraction returned a login/auth wall, captcha,
# 404 page or empty SPA shell instead of a real job description.
_WALL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bplease (?:log\s*in|sign\s*in) to (?:view|continue|see)\b", re.I),
    re.compile(r"\b(?:log\s*in|sign\s*in) (?:required|to view this job)\b", re.I),
    re.compile(r"\bcreate (?:a free )?account to (?:view|apply)\b", re.I),
    re.compile(r"\b(?:are you a robot|verifying you are human|cloudflare ray)\b", re.I),
    re.compile(r"\b(?:access denied|403 forbidden|you don't have permission)\b", re.I),
    re.compile(r"\bpage not found\b|\b404\s+error\b|\bthis job (?:is no longer|has expired)\b", re.I),
    re.compile(r"\bjavascript is required\b|\benable javascript\b", re.I),
)


@dataclass
class ValidationResult:
    is_valid: bool
    errors: list[str]
    warnings: list[str]


def _detect_wall(text: str) -> str | None:
    """Return a wall pattern label if the text looks like a non-JD wall."""
    sample = text[:4000]
    for pat in _WALL_PATTERNS:
        m = pat.search(sample)
        if m:
            return m.group(0)[:80]
    return None


def validate_extracted_text(text: str) -> ValidationResult:
    """Validate plain text quality after extraction, before caching.

    Treats login/captcha/404 walls and JS-only SPA shells as hard failures
    so the LLM never sees them and we don't cache a useless extraction.
    """
    errors: list[str] = []
    warnings: list[str] = []

    stripped = (text or "").strip()
    if not stripped:
        errors.append("Extracted text is empty")
        return ValidationResult(is_valid=False, errors=errors, warnings=warnings)

    if len(stripped) < MIN_EXTRACTED_TEXT_LENGTH:
        warnings.append(f"Extracted text is short ({len(stripped)} chars)")

    wall_hit = _detect_wall(stripped)
    if wall_hit:
        errors.append(f"Extraction looks like a wall/error page: '{wall_hit}'")

    if errors or warnings:
        logger.info(
            "extraction_validation",
            is_valid=not errors,
            errors=errors,
            warnings=warnings,
        )

    return ValidationResult(
        is_valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
    )


def validate_job_data(job_data: JobDescriptionSchema) -> ValidationResult:
    """Validate structured job data after LLM analysis."""
    errors: list[str] = []
    warnings: list[str] = []

    if not job_data.title or len(job_data.title) < MIN_TITLE_LENGTH:
        errors.append("Title is missing or too short")
    elif len(job_data.title) > MAX_TITLE_LENGTH:
        warnings.append("Title exceeds maximum length")

    if not job_data.description:
        errors.append("Description is missing")
    elif len(job_data.description) < MIN_DESCRIPTION_LENGTH:
        warnings.append("Description is very short")

    if not job_data.company:
        warnings.append("Company name not found")

    if errors or warnings:
        logger.info(
            "job_data_validation",
            is_valid=not errors,
            errors=errors,
            warnings=warnings,
        )

    return ValidationResult(
        is_valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
    )
