import pytest
from pydantic import ValidationError
from app.models.schemas import (
    ExtractionRequest,
    JobDescriptionSchema,
    ExtractionMethod,
    ExtractionStatus,
)


class TestExtractionRequest:
    def test_valid_url(self):
        request = ExtractionRequest(url="https://example.com/jobs/123")
        assert str(request.url) == "https://example.com/jobs/123"

    def test_url_with_whitespace(self):
        request = ExtractionRequest(url="  https://example.com/jobs/123  ")
        assert "example.com" in str(request.url)

    def test_invalid_url_raises(self):
        with pytest.raises(ValidationError):
            ExtractionRequest(url="not-a-valid-url")

    def test_force_refresh_default(self):
        request = ExtractionRequest(url="https://example.com/jobs/123")
        assert request.force_refresh is False

    def test_force_refresh_override(self):
        request = ExtractionRequest(url="https://example.com/jobs/123", force_refresh=True)
        assert request.force_refresh is True


class TestJobDescriptionSchema:
    def test_minimal_valid_schema(self):
        job = JobDescriptionSchema(
            title="Software Engineer",
            description="A great opportunity to join our team.",
        )
        assert job.title == "Software Engineer"
        assert job.company is None
        assert job.responsibilities == []

    def test_full_schema(self):
        job = JobDescriptionSchema(
            title="Senior Engineer",
            company="Tech Corp",
            location="San Francisco",
            employment_type="Full-time",
            salary_range="$150k - $200k",
            description="Join our amazing team.",
            responsibilities=["Code", "Review"],
            requirements=["5 years", "Python"],
            benefits=["Health", "401k"],
        )
        assert job.company == "Tech Corp"
        assert len(job.responsibilities) == 2
        assert len(job.requirements) == 2

    def test_title_min_length(self):
        with pytest.raises(ValidationError):
            JobDescriptionSchema(title="", description="Valid description")

    def test_description_min_length(self):
        with pytest.raises(ValidationError):
            JobDescriptionSchema(title="Valid Title", description="Short")


class TestEnums:
    def test_extraction_methods(self):
        assert ExtractionMethod.API_JSON_LD.value == "api_json_ld"
        assert ExtractionMethod.STATIC_HTML.value == "static_html"
        assert ExtractionMethod.BROWSER_RENDER.value == "browser_render"

    def test_extraction_status(self):
        assert ExtractionStatus.PENDING.value == "pending"
        assert ExtractionStatus.COMPLETED.value == "completed"
        assert ExtractionStatus.FAILED.value == "failed"
