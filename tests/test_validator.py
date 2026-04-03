import pytest
from app.services.validator import validate_extracted_text, validate_job_data
from app.models.schemas import JobDescriptionSchema


class TestValidateExtractedText:
    def test_valid_text(self):
        text = "x" * 200
        result = validate_extracted_text(text)
        assert result.is_valid is True
        assert len(result.errors) == 0

    def test_empty_text_fails(self):
        result = validate_extracted_text("")
        assert result.is_valid is False
        assert any("empty" in e.lower() for e in result.errors)

    def test_short_text_warns(self):
        result = validate_extracted_text("x" * 50)
        assert result.is_valid is True
        assert any("short" in w.lower() for w in result.warnings)

    def test_whitespace_only_fails(self):
        result = validate_extracted_text("   \n\t  ")
        assert result.is_valid is False


class TestValidateJobData:
    @pytest.fixture
    def valid_job_data(self):
        return JobDescriptionSchema(
            title="Senior Software Engineer",
            company="Tech Corp",
            location="San Francisco, CA",
            description="We are looking for an experienced software engineer to join our team. " * 10,
            responsibilities=["Design systems", "Write code"],
            requirements=["5+ years experience", "Python expertise"],
        )

    def test_valid_job_passes(self, valid_job_data):
        result = validate_job_data(valid_job_data)
        assert result.is_valid is True

    def test_very_short_title_fails(self):
        job_data = JobDescriptionSchema(
            title="AB",
            description="Valid description with sufficient length for validation test.",
        )
        result = validate_job_data(job_data)
        assert result.is_valid is False
        assert any("title" in e.lower() for e in result.errors)

    def test_missing_description_fails(self):
        job_data = JobDescriptionSchema(
            title="Software Engineer",
            description="",
        )
        result = validate_job_data(job_data)
        assert result.is_valid is False
        assert any("description" in e.lower() for e in result.errors)

    def test_missing_company_warns(self):
        job_data = JobDescriptionSchema(
            title="Software Engineer",
            description="Valid description with sufficient length for validation test.",
        )
        result = validate_job_data(job_data)
        assert any("company" in w.lower() for w in result.warnings)
