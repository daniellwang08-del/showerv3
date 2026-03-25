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
        }
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
    async def test_extract_json_ld_success(self, extractor):
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result.success is True
        assert result.structured_data is not None
        assert result.structured_data["title"] == "Senior Software Engineer"
        assert result.structured_data["company"] == "Tech Corp"
        assert "San Francisco" in result.structured_data["location"]
        assert result.confidence >= 0.9

    @pytest.mark.asyncio
    async def test_extract_without_html_fails(self, extractor):
        result = await extractor.extract("https://example.com/job", None)
        assert result.success is False

    @pytest.mark.asyncio
    async def test_extract_salary_parsing(self, extractor):
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result.success is True
        assert "150,000" in result.structured_data["salary_range"]
        assert "200,000" in result.structured_data["salary_range"]

    @pytest.mark.asyncio
    async def test_extract_date_posted_parsing(self, extractor):
        result = await extractor.extract("https://example.com/job", SAMPLE_HTML_WITH_JSON_LD)
        assert result.success is True
        assert result.structured_data["posted_date"] == "2026-03-23T17:21:00.000Z"
