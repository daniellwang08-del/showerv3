"""RemoteRocketship must honor date-backfill posted_since / posted_until."""

from __future__ import annotations

from datetime import datetime

from app.scraper.pipelines.posted_date_filter import PostedDateFilterPipeline
from app.scraper.spiders.remoterocketship import (
    RemoteRocketshipSpider,
    _parse_rrs_created_at,
)
from scrapy.exceptions import DropItem


class _DummyCrawler:
    def __init__(self, spider):
        self.spider = spider


def _spider(**kwargs) -> RemoteRocketshipSpider:
    return RemoteRocketshipSpider(**kwargs)


def test_parse_rrs_created_at_iso_timezone():
    dt = _parse_rrs_created_at("2026-08-03T14:27:29.467+00:00")
    assert dt == datetime(2026, 8, 3, 14, 27, 29, 467000)


def test_parse_rrs_created_at_rejects_empty():
    assert _parse_rrs_created_at(None) is None
    assert _parse_rrs_created_at("") is None
    assert _parse_rrs_created_at("not-a-date") is None


def test_posted_in_range_rejects_null_when_window_set():
    spider = _spider(posted_since="2026-08-03", posted_until="2026-08-04")
    assert spider._posted_in_range(None) is False
    assert spider._posted_in_range(datetime(2026, 8, 3, 12, 0, 0)) is True
    assert spider._posted_in_range(datetime(2026, 8, 2, 23, 59, 59)) is False
    assert spider._posted_in_range(datetime(2026, 8, 5, 0, 0, 1)) is False


def test_posted_in_range_allows_null_without_window():
    spider = _spider()
    assert spider._posted_in_range(None) is True


def test_page_too_old_for_date_added_pagination():
    spider = _spider(posted_since="2026-08-03", posted_until="2026-08-04")
    assert spider._page_too_old([
        datetime(2026, 8, 2, 10, 0, 0),
        datetime(2026, 8, 1, 10, 0, 0),
    ])
    assert not spider._page_too_old([
        datetime(2026, 8, 3, 10, 0, 0),
        datetime(2026, 8, 2, 10, 0, 0),
    ])


def test_parse_job_data_sets_posted_at_from_created_at():
    spider = _spider()
    job = {
        "id": 123,
        "roleTitle": "Backend Engineer",
        "company": {"name": "Acme", "slug": "acme"},
        "slug": "backend-engineer",
        "url": "https://boards.greenhouse.io/acme/jobs/1",
        "locationType": "remote",
        "created_at": "2026-08-03T14:27:29.467+00:00",
        "techStack": ["Python"],
    }
    items = list(spider._parse_job_data(job))
    assert len(items) == 1
    assert items[0]["posted_at"] == datetime(2026, 8, 3, 14, 27, 29, 467000)


def test_yield_job_if_in_range_drops_old_listing():
    spider = _spider(posted_since="2026-08-03", posted_until="2026-08-04")
    old_job = {
        "id": 1,
        "roleTitle": "Old Role",
        "company": {"name": "Acme", "slug": "acme"},
        "url": "https://example.com/old",
        "created_at": "2026-08-01T10:00:00+00:00",
    }
    new_job = {
        "id": 2,
        "roleTitle": "New Role",
        "company": {"name": "Acme", "slug": "acme"},
        "url": "https://example.com/new",
        "created_at": "2026-08-03T10:00:00+00:00",
    }
    assert list(spider._yield_job_if_in_range(old_job)) == []
    kept = list(spider._yield_job_if_in_range(new_job))
    assert len(kept) == 1
    assert kept[0]["title"] == "New Role"


def test_posted_date_filter_pipeline_drops_outside_window():
    spider = _spider(posted_since="2026-08-03", posted_until="2026-08-04")
    pipeline = PostedDateFilterPipeline(_DummyCrawler(spider))

    class _Item:
        def __init__(self, posted_at):
            self.posted_at = posted_at

    assert pipeline.process_item(_Item(datetime(2026, 8, 3, 15, 0, 0))) is not None
    try:
        pipeline.process_item(_Item(datetime(2026, 8, 1, 15, 0, 0)))
        assert False, "expected DropItem"
    except DropItem:
        pass
    try:
        pipeline.process_item(_Item(None))
        assert False, "expected DropItem for null posted_at"
    except DropItem:
        pass


def test_rrs_spider_parses_posted_until_end_of_day():
    spider = _spider(posted_since="2026-08-03", posted_until="2026-08-04")
    assert spider.posted_until == datetime(2026, 8, 4, 23, 59, 59)
