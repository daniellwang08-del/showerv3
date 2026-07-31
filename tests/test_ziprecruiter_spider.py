"""Unit tests for ZipRecruiter publisher-API spider."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from scrapy.http import HtmlResponse, TextResponse

from app.scraper.spiders.ziprecruiter import (
    DEFAULT_JOB_TITLES,
    JOBS_PER_PAGE,
    ZipRecruiterSpider,
    _days_ago_from_posted_since,
    _is_ziprecruiter_host,
)
from app.services.scrape_promoter import pick_target_url
from app.services.scraper_sync_service import build_run_plan


def test_is_ziprecruiter_host():
    assert _is_ziprecruiter_host("https://www.ziprecruiter.com/jobs/abc")
    assert _is_ziprecruiter_host("https://ziprecruiter.com/cjobs/xyz")
    assert not _is_ziprecruiter_host("https://jobs.ashbyhq.com/acme/1")


def test_days_ago_from_posted_since():
    since = datetime(2026, 7, 1, tzinfo=timezone.utc)
    days = _days_ago_from_posted_since(since.replace(tzinfo=None), fallback=7)
    assert days >= 1


def test_spider_defaults_use_multi_titles(monkeypatch):
    monkeypatch.setattr(
        "app.scraper.spiders.ziprecruiter.settings.ZIPRECRUITER_API_KEY",
        "test-key",
    )
    spider = ZipRecruiterSpider()
    assert spider._api_key == "test-key"
    assert spider.job_titles == DEFAULT_JOB_TITLES
    assert spider.max_pages >= 1
    assert spider.custom_settings.get("ROBOTSTXT_OBEY") is False


def test_build_run_plan_rejects_ziprecruiter_not_in_sync_list():
    with pytest.raises(ValueError, match="Unknown spider"):
        build_run_plan(spider_name="ziprecruiter", sync_mode="incremental")


def test_parse_api_page_emits_redirect_request(monkeypatch):
    monkeypatch.setattr(
        "app.scraper.spiders.ziprecruiter.settings.ZIPRECRUITER_API_KEY",
        "test-key",
    )
    spider = ZipRecruiterSpider(job_titles="Software Engineer", pages="2")
    payload = {
        "success": True,
        "num_paginable_jobs": 150,
        "jobs": [
            {
                "id": "job-1",
                "name": "Software Engineer",
                "url": "https://www.ziprecruiter.com/jobs/job-1",
                "snippet": "Build things",
                "location": "Remote",
                "hiring_company": {"name": "Acme", "url": "https://acme.example"},
                "posted_time": "2026-07-28T12:00:00Z",
                "has_non_zr_url": True,
                "salary_min_annual": 140000,
                "salary_max_annual": 180000,
            }
        ],
    }
    import json as json_lib

    request = spider._api_request("Software Engineer", page=1)
    response = TextResponse(
        url=request.url,
        request=request,
        body=json_lib.dumps(payload).encode("utf-8"),
        encoding="utf-8",
    )
    response.meta["search_title"] = "Software Engineer"
    response.meta["page"] = 1

    out = list(spider.parse_api_page(response))
    assert len(out) == 1
    assert out[0].url.endswith("/jobs/job-1")
    assert out[0].callback == spider.parse_apply_redirect


def test_parse_apply_redirect_sets_origin_url(monkeypatch):
    monkeypatch.setattr(
        "app.scraper.spiders.ziprecruiter.settings.ZIPRECRUITER_API_KEY",
        "test-key",
    )
    spider = ZipRecruiterSpider(job_titles="Software Engineer")
    job_meta = {
        "source_job_id": "job-1",
        "zr_url": "https://www.ziprecruiter.com/jobs/job-1",
        "title": "Software Engineer",
        "company_name": "Acme",
        "location": "Remote",
        "is_remote": True,
        "salary_raw": "$140,000 - $180,000/yr",
        "description": "Build things",
        "job_type": "full_time",
        "posted_at": None,
    }
    request = MagicMock()
    request.url = job_meta["zr_url"]
    request.meta = {"job_data": job_meta}
    response = HtmlResponse(
        url="https://jobs.ashbyhq.com/acme/abc",
        request=request,
        body=b"<html></html>",
        encoding="utf-8",
        status=200,
    )
    items = list(spider.parse_apply_redirect(response))
    assert len(items) == 1
    item = items[0]
    assert item["url"] == job_meta["zr_url"]
    assert item["origin_url"] == "https://jobs.ashbyhq.com/acme/abc"
    assert pick_target_url(item) == item["origin_url"]


def test_parse_apply_redirect_keeps_zr_when_stays_on_host(monkeypatch):
    monkeypatch.setattr(
        "app.scraper.spiders.ziprecruiter.settings.ZIPRECRUITER_API_KEY",
        "test-key",
    )
    spider = ZipRecruiterSpider(job_titles="Software Engineer")
    job_meta = {
        "source_job_id": "job-2",
        "zr_url": "https://www.ziprecruiter.com/jobs/job-2",
        "title": "Zip Apply Role",
        "company_name": "LocalCo",
        "location": "Austin, TX",
        "is_remote": False,
        "salary_raw": None,
        "description": "Snippet",
        "job_type": None,
        "posted_at": None,
    }
    request = MagicMock()
    request.url = job_meta["zr_url"]
    request.meta = {"job_data": job_meta}
    response = HtmlResponse(
        url="https://www.ziprecruiter.com/jobs/job-2?apply=1",
        request=request,
        body=b"<html></html>",
        encoding="utf-8",
        status=200,
    )
    items = list(spider.parse_apply_redirect(response))
    assert items[0]["origin_url"] is None
    assert pick_target_url(items[0]) == job_meta["zr_url"]


def test_jobs_per_page_constant():
    assert JOBS_PER_PAGE == 100
