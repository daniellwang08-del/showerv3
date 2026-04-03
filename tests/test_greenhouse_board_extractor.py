import json
import pytest
from unittest.mock import AsyncMock, MagicMock

from app.extractors.greenhouse_board_extractor import (
    GreenhouseBoardExtractor,
    extract_greenhouse_board_tokens_from_html,
    greenhouse_extraction_token_candidates,
    parse_greenhouse_job_id_from_url,
)


def test_parse_job_id_from_path_and_query():
    assert parse_greenhouse_job_id_from_url(
        "https://abnormal.ai/careers/jobs/7528379003?gh_jid=7528379003&gh_src=x"
    ) == "7528379003"
    assert parse_greenhouse_job_id_from_url(
        "https://boards.greenhouse.io/acme/jobs/12345?t=1"
    ) == "12345"


def test_tokens_from_html_embed():
    html = (
        '<iframe src="https://job-boards.greenhouse.io/embed/job_app?for=abnormalsecurity&token=1"></iframe>'
    )
    assert "abnormalsecurity" in extract_greenhouse_board_tokens_from_html(html)


def test_token_candidates_url_first():
    url = "https://boards.greenhouse.io/mycompany/jobs/99"
    html = '<a href="https://boards.greenhouse.io/otherco/jobs/1">x</a>'
    c = greenhouse_extraction_token_candidates(url, html)
    assert c[0] == "mycompany"


@pytest.mark.asyncio
async def test_extract_maps_api_job(monkeypatch):
    payload = {
        "id": 7528379003,
        "title": "Security Engineer",
        "company_name": "Abnormal",
        "content": "<p>Build detection systems and automation pipelines for security.</p>"
        "<ul><li>Python</li><li>APIs</li><li>Distributed systems</li></ul>",
        "location": {"name": "Remote"},
        "absolute_url": "https://example.com/job",
    }
    http = MagicMock()
    http.fetch_json = AsyncMock(
        return_value=(json.dumps(payload), 200, {}),
    )
    ex = GreenhouseBoardExtractor(http_service=http)
    url = "https://boards.greenhouse.io/abnormalsecurity/jobs/7528379003"
    r = await ex.extract(url, "<html></html>")
    assert r.success
    assert r.structured_data
    assert r.structured_data["title"] == "Security Engineer"
    assert "detection" in (r.structured_data.get("description") or "").lower()
    assert r.structured_data.get("company") == "Abnormal"


@pytest.mark.asyncio
async def test_extract_tries_second_token_on_404():
    ok_job = {
        "id": 1,
        "title": "Role",
        "company_name": "Co",
        "content": "<p>Desc " + ("x" * 50) + "</p>",
        "location": {"name": "NYC"},
    }
    http = MagicMock()
    http.fetch_json = AsyncMock(
        side_effect=[
            ('{"error":"not found"}', 404, {}),
            (json.dumps(ok_job), 200, {}),
        ]
    )
    ex = GreenhouseBoardExtractor(http_service=http)
    # Two board candidates so the extractor can retry after 404.
    html = (
        '<iframe src="https://job-boards.greenhouse.io/embed/job_app?for=badtoken&t=1"></iframe>'
        '<a href="https://boards.greenhouse.io/goodco/jobs/1">x</a>'
    )
    url = "https://corp.example/careers/jobs/1?gh_jid=1"
    r = await ex.extract(url, html)
    assert r.success
    assert http.fetch_json.await_count == 2
