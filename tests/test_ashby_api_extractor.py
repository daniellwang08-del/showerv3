"""Tests for Ashby public API extractor."""
import json
from unittest.mock import AsyncMock, patch

import pytest

from app.extractors.ashby_api_extractor import (
    AshbyApiExtractor,
    _parse_ashby_url,
    extract_ashby_company_slugs_from_html,
    is_ashby_job_url,
    parse_ashby_jid_from_url,
)


class TestParseAshbyUrl:
    def test_parse_standard_job_url(self):
        url = "https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434"
        result = _parse_ashby_url(url)
        assert result == ("tailor", "08796053-4fa8-48db-9a73-a977ae2c5434")

    def test_parse_application_url(self):
        url = "https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434/application?jr_id=abc"
        result = _parse_ashby_url(url)
        assert result == ("tailor", "08796053-4fa8-48db-9a73-a977ae2c5434")

    def test_parse_slug_with_hyphen(self):
        url = "https://jobs.ashbyhq.com/tambo-ai/39fcac07-6f9f-4e49-a989-26ca75aa5d5a"
        result = _parse_ashby_url(url)
        assert result == ("tambo-ai", "39fcac07-6f9f-4e49-a989-26ca75aa5d5a")

    def test_parse_non_ashby_returns_none(self):
        assert _parse_ashby_url("https://example.com/jobs/123") is None
        assert _parse_ashby_url("https://greenhouse.io/company/job") is None

    def test_is_ashby_job_url(self):
        assert is_ashby_job_url("https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434") is True
        assert is_ashby_job_url("https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434/application") is True
        assert is_ashby_job_url("https://example.com/job") is False

    def test_parse_ashby_jid_from_company_careers_url(self):
        u = "https://www.vesta.com/careers?ashby_jid=deee60e6-d180-41aa-8d0e-f7e9e4baf0ba"
        assert parse_ashby_jid_from_url(u) == "deee60e6-d180-41aa-8d0e-f7e9e4baf0ba"

    def test_extract_slug_from_html(self):
        html = '<a href="https://jobs.ashbyhq.com/acme-corp/deee60e6-d180-41aa-8d0e-f7e9e4baf0ba">Apply</a>'
        assert extract_ashby_company_slugs_from_html(html) == ["acme-corp"]


class TestAshbyApiExtractor:
    @pytest.mark.asyncio
    async def test_can_extract_ashby_url(self):
        extractor = AshbyApiExtractor()
        assert await extractor.can_extract("https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434") is True
        assert await extractor.can_extract("https://example.com/job") is False

    @pytest.mark.asyncio
    async def test_extract_success_with_mocked_http(self):
        mock_response = {
            "jobs": [
                {
                    "id": "08796053-4fa8-48db-9a73-a977ae2c5434",
                    "title": "Full-Stack Software Engineer",
                    "location": "Remote (Anywhere in the world)",
                    "employmentType": "FullTime",
                    "descriptionPlain": "We are looking for a talented engineer.",
                    "descriptionHtml": "<p>We are looking for a talented engineer.</p>",
                    "isRemote": True,
                    "publishedAt": "2026-02-27T02:34:16.756+00:00",
                    "jobUrl": "https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434",
                }
            ]
        }
        mock_fetch = AsyncMock(return_value=(json.dumps(mock_response), 200, {}))

        extractor = AshbyApiExtractor()
        with patch.object(extractor._http, "fetch_json", mock_fetch):
            result = await extractor.extract(
                "https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434"
            )

        assert result.success is True
        assert result.structured_data is not None
        assert result.structured_data["title"] == "Full-Stack Software Engineer"
        assert result.structured_data["location"] == "Remote (Anywhere in the world)"
        assert "engineer" in result.structured_data["description"].lower()
        assert result.structured_data["company"] == "Tailor"  # derived from slug "tailor"
        assert result.structured_data["remote_policy"] == "Remote"
        assert result.confidence >= 0.9

    @pytest.mark.asyncio
    async def test_extract_job_not_found(self):
        mock_response = {"jobs": [{"id": "other-uuid", "title": "Other Job"}]}
        mock_fetch = AsyncMock(return_value=(json.dumps(mock_response), 200, {}))

        extractor = AshbyApiExtractor()
        with patch.object(extractor._http, "fetch_json", mock_fetch):
            result = await extractor.extract(
                "https://jobs.ashbyhq.com/tailor/08796053-4fa8-48db-9a73-a977ae2c5434"
            )

        assert result.success is False
        assert "not found" in (result.error or "").lower()

    @pytest.mark.asyncio
    async def test_extract_embedded_success_with_mocked_http(self):
        html = """
        <html><body>
        <a href="https://jobs.ashbyhq.com/demo-co/08796053-4fa8-48db-9a73-a977ae2c5434">Board</a>
        </body></html>
        """
        url = "https://employer.example/careers?ashby_jid=08796053-4fa8-48db-9a73-a977ae2c5434"
        mock_response = {
            "jobs": [
                {
                    "id": "08796053-4fa8-48db-9a73-a977ae2c5434",
                    "title": "Platform Engineer",
                    "location": "Remote",
                    "employmentType": "FullTime",
                    "descriptionPlain": "Build things.",
                    "descriptionHtml": "<p>Build things.</p>",
                    "isRemote": True,
                    "publishedAt": "2026-02-27T02:34:16.756+00:00",
                    "jobUrl": "https://jobs.ashbyhq.com/demo-co/08796053-4fa8-48db-9a73-a977ae2c5434",
                }
            ]
        }
        mock_fetch = AsyncMock(return_value=(json.dumps(mock_response), 200, {}))
        extractor = AshbyApiExtractor()
        with patch.object(extractor._http, "fetch_json", mock_fetch):
            result = await extractor.extract_embedded(url, html)
        assert result.success is True
        assert result.structured_data is not None
        assert result.structured_data["title"] == "Platform Engineer"
