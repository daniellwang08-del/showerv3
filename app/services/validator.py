"""
Validation for extracted content and structured job data.

Two-stage validation:
1. ``validate_extracted_text`` — after extraction, checks plain text quality.
2. ``validate_job_data`` — after LLM structuring, checks structured output.
"""

from app.models.schemas import JobDescriptionSchema
from app.core.logging import get_logger
from dataclasses import dataclass

logger = get_logger(__name__)

MIN_EXTRACTED_TEXT_LENGTH = 100
MIN_TITLE_LENGTH = 3
MAX_TITLE_LENGTH = 500
MIN_DESCRIPTION_LENGTH = 50


@dataclass
class ValidationResult:
    is_valid: bool
    errors: list[str]
    warnings: list[str]


def validate_extracted_text(text: str) -> ValidationResult:
    """Validate plain text quality after extraction, before caching."""
    errors: list[str] = []
    warnings: list[str] = []

    stripped = text.strip()
    if not stripped:
        errors.append("Extracted text is empty")
    elif len(stripped) < MIN_EXTRACTED_TEXT_LENGTH:
        warnings.append(f"Extracted text is short ({len(stripped)} chars)")

    if errors or warnings:
        logger.info("extraction_validation", is_valid=not errors, errors=errors, warnings=warnings)

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
