import pytest
from app.extractors.html_extractor import HTMLExtractor

SAMPLE_JOB_HTML = """
<!DOCTYPE html>
<html>
<head><title>Software Engineer at TechCorp</title></head>
<body>
    <header>
        <h1 class="job-title">Software Engineer</h1>
        <div class="company-name">TechCorp Inc.</div>
        <div class="job-location">New York, NY</div>
    </header>
    <main>
        <article class="job-description">
            <h2>About the Role</h2>
            <p>We are looking for a talented software engineer to join our growing team.
            You will be responsible for building and maintaining our core platform.</p>
            
            <h3>Requirements</h3>
            <ul>
                <li>5+ years of experience</li>
                <li>Strong Python skills</li>
                <li>Experience with distributed systems</li>
            </ul>
            
            <h3>Responsibilities</h3>
            <ul>
                <li>Design and implement new features</li>
                <li>Code review and mentoring</li>
                <li>On-call rotation</li>
            </ul>
        </article>
    </main>
</body>
</html>
"""

MINIMAL_HTML = """
<html><body><p>Hello</p></body></html>
"""


class TestHTMLExtractor:
    @pytest.fixture
    def extractor(self):
        return HTMLExtractor()

    @pytest.mark.asyncio
    async def test_can_extract_valid_html(self, extractor):
        result = await extractor.can_extract("https://example.com", SAMPLE_JOB_HTML)
        assert result is True

    @pytest.mark.asyncio
    async def test_cannot_extract_empty_html(self, extractor):
        result = await extractor.can_extract("https://example.com", "")
        assert result is False

    @pytest.mark.asyncio
    async def test_cannot_extract_none(self, extractor):
        result = await extractor.can_extract("https://example.com", None)
        assert result is False

    @pytest.mark.asyncio
    async def test_extract_job_details(self, extractor):
        result = await extractor.extract("https://example.com", SAMPLE_JOB_HTML)
        assert result.success is True
        assert result.structured_data is not None
        assert "Software Engineer" in result.structured_data["title"]

    @pytest.mark.asyncio
    async def test_extract_company(self, extractor):
        result = await extractor.extract("https://example.com", SAMPLE_JOB_HTML)
        assert result.success is True
        assert "TechCorp" in result.structured_data["company"]

    @pytest.mark.asyncio
    async def test_extract_location(self, extractor):
        result = await extractor.extract("https://example.com", SAMPLE_JOB_HTML)
        assert result.success is True
        assert "New York" in result.structured_data["location"]

    @pytest.mark.asyncio
    async def test_extract_description(self, extractor):
        result = await extractor.extract("https://example.com", SAMPLE_JOB_HTML)
        assert result.success is True
        assert "software engineer" in result.structured_data["description"].lower()

    @pytest.mark.asyncio
    async def test_minimal_html_fails(self, extractor):
        result = await extractor.extract("https://example.com", MINIMAL_HTML)
        assert result.success is False

    @pytest.mark.asyncio
    async def test_confidence_score(self, extractor):
        result = await extractor.extract("https://example.com", SAMPLE_JOB_HTML)
        assert result.success is True
        assert 0 < result.confidence <= 1.0
