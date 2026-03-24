from app.models.schemas import JobDescriptionSchema
from app.core.logging import get_logger
from dataclasses import dataclass

logger = get_logger(__name__)

MIN_TITLE_LENGTH = 3
MAX_TITLE_LENGTH = 500
MIN_DESCRIPTION_LENGTH = 50
MIN_CONFIDENCE_THRESHOLD = 0.4


@dataclass
class ValidationResult:
    is_valid: bool
    errors: list[str]
    warnings: list[str]
    adjusted_confidence: float


class JobValidator:
    def validate(
        self,
        job_data: JobDescriptionSchema,
        initial_confidence: float,
    ) -> ValidationResult:
        errors = []
        warnings = []
        confidence_adjustments = 0.0

        if not job_data.title or len(job_data.title) < MIN_TITLE_LENGTH:
            errors.append("Title is missing or too short")
        elif len(job_data.title) > MAX_TITLE_LENGTH:
            warnings.append("Title exceeds maximum length")
            confidence_adjustments -= 0.1

        if not job_data.description:
            errors.append("Description is missing")
        elif len(job_data.description) < MIN_DESCRIPTION_LENGTH:
            warnings.append("Description is very short")
            confidence_adjustments -= 0.15

        if not job_data.company:
            warnings.append("Company name not found")
            confidence_adjustments -= 0.05

        if not job_data.location:
            warnings.append("Location not found")
            confidence_adjustments -= 0.05

        if not job_data.requirements and not job_data.responsibilities:
            warnings.append("No requirements or responsibilities found")
            confidence_adjustments -= 0.1

        if self._contains_placeholder_text(job_data.title):
            errors.append("Title contains placeholder text")

        if self._contains_placeholder_text(job_data.description):
            warnings.append("Description may contain placeholder text")
            confidence_adjustments -= 0.2

        adjusted_confidence = max(0.0, min(1.0, initial_confidence + confidence_adjustments))

        if adjusted_confidence < MIN_CONFIDENCE_THRESHOLD and not errors:
            warnings.append(f"Low confidence score: {adjusted_confidence:.2f}")

        is_valid = len(errors) == 0

        if errors or warnings:
            logger.info(
                "validation_result",
                is_valid=is_valid,
                errors=errors,
                warnings=warnings,
                adjusted_confidence=adjusted_confidence,
            )

        return ValidationResult(
            is_valid=is_valid,
            errors=errors,
            warnings=warnings,
            adjusted_confidence=adjusted_confidence,
        )

    def _contains_placeholder_text(self, text: str | None) -> bool:
        if not text:
            return False

        placeholders = [
            "lorem ipsum",
            "placeholder",
            "[insert",
            "{insert",
            "example text",
            "sample text",
            "xxx",
            "tbd",
        ]
        text_lower = text.lower()
        return any(p in text_lower for p in placeholders)


def validate_job_data(job_data: JobDescriptionSchema, confidence: float) -> ValidationResult:
    return JobValidator().validate(job_data, confidence)
