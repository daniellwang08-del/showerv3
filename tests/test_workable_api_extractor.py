"""Tests for Workable public (keyless) API extractor."""
import json
from unittest.mock import AsyncMock, patch

import pytest

from app.extractors.workable_api_extractor import (
    WorkableApiExtractor,
    _parse_workable_url,
    extract_workable_accounts_from_html,
    is_workable_job_url,
    parse_workable_shortcode_from_url,
)


class TestParseWorkableUrl:
    def test_parse_apply_job_url(self):
        url = "https://apply.workable.com/hack-the-box-ltd/j/25376A25BB/"
        assert _parse_workable_url(url) == ("hack-the-box-ltd", "25376A25BB")

    def test_parse_apply_job_url_with_apply_suffix(self):
        url = "https://apply.workable.com/c-serv/j/1E040E3017/apply/"
        assert _parse_workable_url(url) == ("c-serv", "1E040E3017")

    def test_parse_legacy_subdomain_url(self):
        url = "https://fidus.workable.com/j/304345ABD4"
        assert _parse_workable_url(url) == ("fidus", "304345ABD4")

    def test_parse_non_workable_returns_none(self):
        assert _parse_workable_url("https://example.com/jobs/123") is None
        assert _parse_workable_url("https://www.workable.com/j/ABC123") is None

    def test_is_workable_job_url(self):
        assert is_workable_job_url("https://apply.workable.com/acme/j/ABCDEF1234") is True
        assert is_workable_job_url("https://example.com/job") is False

    def test_parse_shortcode_from_query(self):
        assert parse_workable_shortcode_from_url("https://co.com/careers?shortcode=25376A25BB") == "25376A25BB"
        assert parse_workable_shortcode_from_url("https://co.com/careers") is None

    def test_extract_account_from_html(self):
        html = '<iframe src="https://apply.workable.com/acme-co/"></iframe>'
        assert extract_workable_accounts_from_html(html) == ["acme-co"]


class TestWorkableApiExtractor:
    @pytest.mark.asyncio
    async def test_can_extract_workable_url(self):
        extractor = WorkableApiExtractor()
        assert await extractor.can_extract("https://apply.workable.com/acme/j/ABCDEF1234") is True
        assert await extractor.can_extract("https://example.com/job") is False

    @pytest.mark.asyncio
    async def test_extract_success_returns_plain_text(self):
        mock_response = {
            "id": 5965043,
            "shortcode": "25376A25BB",
            "title": "Senior Data Engineer",
            "remote": True,
            "workplace": "remote",
            "type": "full",
            "department": ["R&D"],
            "location": {"country": "United States", "countryCode": "US", "city": "", "region": None},
            "published": "2026-07-16T00:00:00.000Z",
            "description": "<p>Build our data platform and scale pipelines.</p>",
            "requirements": "<p>5+ years of data engineering.</p>",
            "benefits": "<p>Great pay and remote work.</p>",
        }
        mock_fetch = AsyncMock(return_value=(json.dumps(mock_response), 200, {}))

        extractor = WorkableApiExtractor()
        with patch.object(extractor._http, "fetch_json", mock_fetch):
            result = await extractor.extract("https://apply.workable.com/hack-the-box-ltd/j/25376A25BB/")

        assert result.success is True
        assert result.structured_data is None
        assert result.raw_content is not None
        assert "Senior Data Engineer" in result.raw_content
        assert "data platform" in result.raw_content
        assert "data engineering" in result.raw_content
        assert "Great pay" in result.raw_content

    @pytest.mark.asyncio
    async def test_extract_non_200_fails(self):
        mock_fetch = AsyncMock(return_value=("Not Found", 404, {}))
        extractor = WorkableApiExtractor()
        with patch.object(extractor._http, "fetch_json", mock_fetch):
            result = await extractor.extract("https://apply.workable.com/acme/j/ABCDEF1234")
        assert result.success is False
        assert "404" in (result.error or "")

    @pytest.mark.asyncio
    async def test_extract_embedded_via_html_account(self):
        html = '<div data-account="acme-co"></div>'
        url = "https://acme.com/careers?shortcode=25376A25BB"
        mock_response = {
            "title": "Platform Engineer",
            "description": "<p>Own our platform infrastructure end to end.</p>",
        }
        mock_fetch = AsyncMock(return_value=(json.dumps(mock_response), 200, {}))
        extractor = WorkableApiExtractor()
        with patch.object(extractor._http, "fetch_json", mock_fetch):
            result = await extractor.extract(url, html)
        assert result.success is True
        assert result.raw_content is not None
        assert "Platform Engineer" in result.raw_content
