"""Unit tests for Welcome to the Jungle remote-US + apply_url enrichment."""

from __future__ import annotations

from datetime import datetime, timezone

from app.scraper.spiders.welcometothejungle import (
    ALGOLIA_PAGINATION_LIMIT,
    DEFAULT_REMOTE_US_LOOKBACK_DAYS,
    REMOTE_US_FACET_FILTERS,
    WelcomeToTheJungleSpider,
    _skill_names,
    _strip_html,
)
from app.services.scrape_promoter import pick_target_url
from app.services.scraper_sync_service import build_run_plan


def test_skill_names_prefers_english():
    skills = [
        {"name": {"en": "Negotiation skills", "fr": "Négociation"}, "reference": "x"},
        {"name": "Plain string skill"},
        "Direct string",
        {"name": {"fr": "Seul FR"}},
    ]
    assert _skill_names(skills) == [
        "Negotiation skills",
        "Plain string skill",
        "Direct string",
        "Seul FR",
    ]


def test_strip_html():
    assert _strip_html("<p>Hello <b>world</b></p>") == "Hello world"
    assert _strip_html(None) == ""


def test_remote_us_defaults():
    spider = WelcomeToTheJungleSpider()
    assert spider.mode == "remote_us"
    assert spider.enrich_apply is True
    assert spider.lookback_days == DEFAULT_REMOTE_US_LOOKBACK_DAYS
    assert spider.max_pages == ALGOLIA_PAGINATION_LIMIT // spider.HITS_PER_PAGE
    assert REMOTE_US_FACET_FILTERS == [["remote:fulltime"], ["offices.country_code:US"]]


def test_parse_hit_sets_origin_url_from_apply_url():
    spider = WelcomeToTheJungleSpider()
    hit = {
        "name": "Enterprise Account Executive",
        "slug": "enterprise-account-executive_fr_4ewsbpfm",
        "reference": "88dbe55e-8ad6-49a3-815d-35921ddc19d5",
        "objectID": "88dbe55e-8ad6-49a3-815d-35921ddc19d5",
        "remote": "fulltime",
        "published_at": "2026-07-29T00:14:08Z",
        "summary": "Join Runway",
        "organization": {"name": "Runway", "slug": "runway-1"},
        "offices": [{"city": None, "country_code": "US"}],
        "contract_type": "full_time",
    }
    rest = {
        "name": "Enterprise Account Executive",
        "apply_url": "https://jobs.ashbyhq.com/runway-ml/0a79e4be-d7ea-4d43-9400-33a23f552b81",
        "ats": "external",
        "skills": [{"name": {"en": "Communication skills"}}],
        "description": "<p>Full JD from REST</p>",
        "profile": "",
    }
    item = spider._parse_hit(hit, rest_job=rest)
    assert item is not None
    assert item["url"].startswith("https://www.welcometothejungle.com/en/companies/runway-1/jobs/")
    assert item["origin_url"] == rest["apply_url"]
    assert item["tags"] == ["Communication skills"]
    assert "Full JD from REST" in item["description"]
    assert pick_target_url(item) == rest["apply_url"]


def test_parse_hit_without_apply_url_keeps_listing_only():
    spider = WelcomeToTheJungleSpider()
    hit = {
        "name": "Native WTTJ Role",
        "slug": "native-role",
        "reference": "abc",
        "remote": "fulltime",
        "organization": {"name": "Waiv", "slug": "waiv"},
        "offices": [{"city": "Boston", "country_code": "US"}],
    }
    item = spider._parse_hit(hit, rest_job={"apply_url": None, "ats": "wkit", "skills": []})
    assert item["url"].endswith("/companies/waiv/jobs/native-role")
    assert item["origin_url"] is None
    assert pick_target_url(item) == item["url"]


def test_numeric_filters_for_bounds():
    filters = WelcomeToTheJungleSpider._numeric_filters_for_bounds(100, 200)
    assert filters == [
        "published_at_timestamp>=100",
        "published_at_timestamp<200",
    ]


def test_build_run_plan_wttj_remote_us_defaults():
    plan = build_run_plan(spider_name="welcometothejungle", sync_mode="incremental")
    assert len(plan) == 1
    name, kwargs = plan[0]
    assert name == "welcometothejungle"
    assert kwargs["mode"] == "remote_us"
    assert kwargs["pages"] == "20"
    assert kwargs["enrich_apply"] == "true"
    assert kwargs["lookback_days"] == "180"


def test_hit_posted_at_parses_iso():
    dt = WelcomeToTheJungleSpider._hit_posted_at({"published_at": "2026-07-29T00:14:08Z"})
    assert dt is not None
    assert dt.astimezone(timezone.utc).year == 2026
