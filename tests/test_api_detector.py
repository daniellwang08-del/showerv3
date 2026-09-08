import pytest
from app.extractors.api_detector import APIDetectorExtractor

SAMPLE_HTML_WITH_JSON_LD = """
<!DOCTYPE html>
<html>
<head>
    <script type="application/ld+json">
    {
        "@context": "https://schema.org/",
        "@type": "JobPosting",
        "title": "Senior Software Engineer",
        "description": "We are looking for an experienced software engineer to join our team.",
        "hiringOrganization": {
            "@type": "Organization",
            "name": "Tech Corp"
        },
        "jobLocation": {
            "@type": "Place",
            "address": {
                "@type": "PostalAddress",
                "addressLocality": "San Francisco",
                "addressRegion": "CA",
                "addressCountry": "US"
            }
        },
        "employmentType": "FULL_TIME",
        "datePosted": "2026-03-23T17:21:00.000Z",
        "baseSalary": {
            "@type": "MonetaryAmount",
            "currency": "USD",
            "value": {
                "@type": "QuantitativeValue",
                "minValue": 150000,
                "maxValue": 200000,
                "unitText": "YEAR"
            }
        },
        "educationRequirements": "Bachelor's degree in Computer Science",
        "experienceRequirements": "5+ years of software development",
        "skills": ["Python", "PostgreSQL", "AWS"]
    }
    </script>
</head>
<body>
    <h1>Senior Software Engineer</h1>
</body>
</html>
"""

SAMPLE_HTML_WITHOUT_JSON_LD = """
<!DOCTYPE html>
<html>
<head><title>Job Posting</title></head>
<body>
    <h1>Senior Software Engineer</h1>
    <p>Description of the job...</p>
</body>
</html>
"""


class TestAPIDetector:
    @pytest.fixture
    def extractor(self):
        return APIDetectorExtractor()

    @pytest.mark.asyncio
    async def test_can_extract_with_json_ld(self, extractor):
        result = await extractor.can_extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result is True

    @pytest.mark.asyncio
    async def test_cannot_extract_without_json_ld(self, extractor):
        result = await extractor.can_extract("https://example.com/job", SAMPLE_HTML_WITHOUT_JSON_LD)
        assert result is False

    @pytest.mark.asyncio
    async def test_extract_returns_plain_text(self, extractor):
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result.success is True
        assert result.raw_content is not None
        assert "Senior Software Engineer" in result.raw_content
        assert "Tech Corp" in result.raw_content
        assert result.structured_data == {
            "title": "Senior Software Engineer",
            "company": "Tech Corp",
            "location": "San Francisco, CA, US",
            "employment_type": "FULL_TIME",
        }

    @pytest.mark.asyncio
    async def test_nested_org_name_labeled_company_not_title(self, extractor):
        """hiringOrganization.name must not be relabeled as Title.

        The nested walk previously emitted a bare ``Company:`` line followed by
        ``Title: <employer>``, so the employer was never hydrated.
        """
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert "Company: Tech Corp" in result.raw_content
        assert "Title: Tech Corp" not in result.raw_content

    @pytest.mark.asyncio
    async def test_extract_captures_all_fields(self, extractor):
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result.success is True
        text = result.raw_content
        assert "San Francisco" in text
        assert "experienced software engineer" in text
        assert "150000" in text or "150,000" in text
        assert "200000" in text or "200,000" in text
        assert "FULL_TIME" in text or "Full Time" in text

    @pytest.mark.asyncio
    async def test_extract_captures_education_and_skills(self, extractor):
        """educationRequirements and skills must not be ignored."""
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result.success is True
        text = result.raw_content
        assert "Bachelor" in text
        assert "Computer Science" in text
        assert "Python" in text
        assert "PostgreSQL" in text

    @pytest.mark.asyncio
    async def test_extract_without_html_fails(self, extractor):
        result = await extractor.extract("https://example.com/job", None)
        assert result.success is False
