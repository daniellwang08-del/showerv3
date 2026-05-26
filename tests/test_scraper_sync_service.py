from datetime import date

import pytest

from app.services.scraper_sync_service import (
    build_run_plan,
    build_spider_run_kwargs,
    list_sync_platforms,
    resolve_spider_names,
)


def test_list_sync_platforms_includes_known_spiders():
    names = {row["name"] for row in list_sync_platforms()}
    assert "adzuna" in names
    assert "jobright" in names
    assert "remoterocketship" in names


def test_resolve_spider_names_all():
    names = resolve_spider_names("all", None)
    assert "adzuna" in names
    assert len(names) >= 7


def test_resolve_spider_names_subset():
    names = resolve_spider_names("all", ["adzuna", "jobright"])
    assert names == ["adzuna", "jobright"]


def test_resolve_spider_names_unknown_raises():
    with pytest.raises(ValueError, match="Unknown spider"):
        resolve_spider_names("all", ["not-a-spider"])


def test_build_spider_run_kwargs_incremental_empty():
    assert build_spider_run_kwargs(sync_mode="incremental") == {}


def test_build_spider_run_kwargs_date_backfill_requires_since():
    with pytest.raises(ValueError, match="posted_since"):
        build_spider_run_kwargs(sync_mode="date_backfill")


def test_build_spider_run_kwargs_date_backfill():
    kwargs = build_spider_run_kwargs(
        sync_mode="date_backfill",
        posted_since=date(2025, 1, 1),
        posted_until=date(2025, 1, 31),
    )
    assert kwargs == {
        "fresh": "true",
        "posted_since": "2025-01-01",
        "posted_until": "2025-01-31",
    }


def test_build_run_plan_merges_defaults_and_mode_kwargs():
    plan = build_run_plan(
        spider_names=["adzuna"],
        sync_mode="date_backfill",
        posted_since=date(2025, 3, 1),
    )
    assert len(plan) == 1
    name, kwargs = plan[0]
    assert name == "adzuna"
    assert kwargs["fresh"] == "true"
    assert kwargs["posted_since"] == "2025-03-01"
    assert kwargs["pages"] == "3"


def test_build_run_plan_incremental_single_spider():
    plan = build_run_plan(spider_name="jobright", sync_mode="incremental")
    assert plan == [("jobright", {"pages": "5"})]
