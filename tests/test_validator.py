import pytest
from app.services.validator import JobValidator, validate_job_data
from app.models.schemas import JobDescriptionSchema


class TestJobValidator:
    @pytest.fixture
    def validator(self):
        return JobValidator()

    @pytest.fixture
    def valid_job_data(self):
        return JobDescriptionSchema(
            title="Senior Software Engineer",
            company="Tech Corp",
            location="San Francisco, CA",
            description="We are looking for an experienced software engineer to join our team. " * 10,
            responsibilities=["Design systems", "Write code", "Code review"],
            requirements=["5+ years experience", "Python expertise"],
        )

    @pytest.fixture
    def minimal_job_data(self):
        return JobDescriptionSchema(
            title="Engineer",
            description="Short description that meets minimum length requirement for validation.",
        )

    def test_valid_job_passes(self, validator, valid_job_data):
        result = validator.validate(valid_job_data, 0.8)
        assert result.is_valid is True
        assert len(result.errors) == 0

    def test_very_short_title_fails(self, validator):
        job_data = JobDescriptionSchema(
            title="AB",
            description="Valid description with sufficient length for validation test.",
        )
        result = validator.validate(job_data, 0.5)
        assert result.is_valid is False
        assert any("title" in e.lower() for e in result.errors)

    def test_short_description_warning(self, validator):
        job_data = JobDescriptionSchema(
            title="Software Engineer",
            description="Short desc.",
        )
        result = validator.validate(job_data, 0.5)
        assert any("short" in w.lower() for w in result.warnings)

    def test_no_requirements_warning(self, validator):
        job_data = JobDescriptionSchema(
            title="Software Engineer",
            description="Valid description with sufficient length for validation test to pass.",
        )
        result = validator.validate(job_data, 0.5)
        assert any("requirements" in w.lower() or "responsibilities" in w.lower() for w in result.warnings)

    def test_missing_company_warning(self, validator, minimal_job_data):
        result = validator.validate(minimal_job_data, 0.5)
        assert any("company" in w.lower() for w in result.warnings)

    def test_confidence_adjustment_down(self, validator, minimal_job_data):
        result = validator.validate(minimal_job_data, 0.8)
        assert result.adjusted_confidence < 0.8

    def test_placeholder_text_detection(self, validator):
        job_data = JobDescriptionSchema(
            title="Lorem Ipsum Position",
            description="This is a placeholder description for testing purposes only.",
        )
        result = validator.validate(job_data, 0.5)
        assert result.is_valid is False

    def test_full_validation_function(self, valid_job_data):
        result = validate_job_data(valid_job_data, 0.9)
        assert result.is_valid is True
        assert result.adjusted_confidence > 0
