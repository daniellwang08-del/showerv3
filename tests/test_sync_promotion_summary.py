"""Sync summary must expose promotion counters for the admin banner."""

from app.tasks.worker import _aggregate_promotion_stats, _build_sync_summary


def test_aggregate_promotion_stats_sums_platforms():
    results = [
        {
            "spider": "jobright",
            "success": True,
            "items_scraped": 180,
            "items_new": 40,
            "items_updated": 140,
            "promotion": {
                "total": 40,
                "new": 35,
                "exact_duplicate_dropped": 5,
                "linked_existing": 5,
                "enqueued": 35,
                "blocked": 0,
                "failed": 0,
                "skipped_invalid_url": 0,
                "linkedin_skipped": 0,
                "linkedin_purged": 0,
            },
        },
        {
            "spider": "adzuna",
            "success": True,
            "items_scraped": 10,
            "items_new": 10,
            "items_updated": 0,
            "promotion": {
                "total": 8,
                "new": 8,
                "exact_duplicate_dropped": 0,
                "linked_existing": 0,
                "enqueued": 8,
                "blocked": 1,
                "failed": 0,
                "skipped_invalid_url": 1,
                "linkedin_skipped": 0,
                "linkedin_purged": 2,
            },
        },
    ]
    promo = _aggregate_promotion_stats(results)
    assert promo is not None
    assert promo["enqueued"] == 43
    assert promo["new"] == 43
    assert promo["exact_duplicate_dropped"] == 5
    assert promo["linked_existing"] == 5
    assert promo["linkedin_purged"] == 2
    assert promo["blocked"] == 1


def test_aggregate_promotion_stats_legacy_linked_existing():
    """Older promoters only emit linked_existing — treat as exact-URL drops."""
    promo = _aggregate_promotion_stats(
        [
            {
                "spider": "wttj",
                "success": True,
                "promotion": {
                    "new": 2,
                    "linked_existing": 7,
                    "enqueued": 2,
                },
            }
        ]
    )
    assert promo is not None
    assert promo["exact_duplicate_dropped"] == 7
    assert promo["linked_existing"] == 7


def test_build_sync_summary_includes_promotion():
    summary = _build_sync_summary(
        spider_name="jobright",
        sync_mode="incremental",
        posted_since=None,
        posted_until=None,
        platforms=["jobright"],
        results=[
            {
                "spider": "jobright",
                "success": True,
                "items_scraped": 180,
                "items_new": 40,
                "items_updated": 140,
                "promotion": {
                    "total": 40,
                    "new": 35,
                    "exact_duplicate_dropped": 5,
                    "linked_existing": 5,
                    "enqueued": 35,
                    "blocked": 0,
                    "failed": 0,
                    "skipped_invalid_url": 0,
                    "linkedin_skipped": 0,
                    "linkedin_purged": 0,
                },
            }
        ],
    )
    assert summary["items_scraped"] == 180
    assert summary["items_new"] == 40
    assert summary["items_updated"] == 140
    assert summary["promotion"]["enqueued"] == 35
    assert summary["promotion"]["exact_duplicate_dropped"] == 5
    assert summary["results"][0]["promotion"]["new"] == 35


def test_aggregate_promotion_stats_none_when_missing():
    assert _aggregate_promotion_stats([{"spider": "x", "success": True}]) is None
