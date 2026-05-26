"""Build spider run plans for incremental and date-range sync."""

from __future__ import annotations

from datetime import date
from typing import Literal

from app.scraper.runner import ALL_SPIDERS, SPIDER_META

SyncMode = Literal["incremental", "date_backfill"]


def list_sync_platforms() -> list[dict]:
    """Platforms available for sync (matches SPIDER_META keys)."""
    return [
        {"name": name, "label": meta["label"], "requires_auth": meta["requires_auth"]}
        for name, meta in SPIDER_META.items()
    ]


def resolve_spider_names(spider_name: str, spider_names: list[str] | None) -> list[str]:
    if spider_names:
        unknown = [n for n in spider_names if n not in SPIDER_META]
        if unknown:
            raise ValueError(f"Unknown spider(s): {unknown}")
        return spider_names
    if spider_name == "all":
        return [name for name, _ in ALL_SPIDERS]
    if spider_name not in SPIDER_META:
        raise ValueError(f"Unknown spider: {spider_name}")
    return [spider_name]


def default_spider_kwargs(spider_name: str) -> dict[str, str]:
    for name, kwargs in ALL_SPIDERS:
        if name == spider_name:
            return dict(kwargs)
    return {}


def build_spider_run_kwargs(
    *,
    sync_mode: SyncMode,
    posted_since: date | None = None,
    posted_until: date | None = None,
) -> dict[str, str]:
    """Keyword args passed to ``scrapy crawl -a key=value``."""
    kwargs: dict[str, str] = {}
    if sync_mode == "date_backfill":
        if posted_since is None:
            raise ValueError("posted_since is required for date_backfill sync")
        kwargs["fresh"] = "true"
        kwargs["posted_since"] = posted_since.isoformat()
        if posted_until is not None:
            kwargs["posted_until"] = posted_until.isoformat()
    return kwargs


def build_run_plan(
    *,
    spider_name: str = "all",
    spider_names: list[str] | None = None,
    sync_mode: SyncMode = "incremental",
    posted_since: date | None = None,
    posted_until: date | None = None,
) -> list[tuple[str, dict[str, str]]]:
    """Return ordered (spider_name, scrapy_kwargs) pairs to execute."""
    names = resolve_spider_names(spider_name, spider_names)
    mode_kwargs = build_spider_run_kwargs(
        sync_mode=sync_mode,
        posted_since=posted_since,
        posted_until=posted_until,
    )
    plan: list[tuple[str, dict[str, str]]] = []
    for name in names:
        merged = default_spider_kwargs(name)
        merged.update(mode_kwargs)
        plan.append((name, merged))
    return plan
