"""Regression tests for GET /scraper/sync/status response construction."""

from datetime import datetime

from app.api.scraper_routes import SyncStatusResponse, _sync_running_message


def test_sync_running_message_includes_elapsed():
    assert _sync_running_message("adzuna", 735, 1770) == (
        "Spider 'adzuna' running — 735 scraped (1770s elapsed)."
    )


def test_sync_running_message_without_elapsed():
    assert _sync_running_message("jobright", 0, None) == (
        "Spider 'jobright' running — 0 scraped."
    )


def test_sync_status_response_running_message_is_string_not_tuple():
    """Guard against `(expr,)` accidentally passed as message (Pydantic expects str)."""
    response = SyncStatusResponse(
        status="running",
        spider_name="adzuna",
        items_scraped=735,
        items_new=610,
        items_updated=125,
        started_at=datetime(2026, 6, 8, 3, 56, 9),
        elapsed_seconds=1770,
        message=_sync_running_message("adzuna", 735, 1770),
    )
    assert isinstance(response.message, str)
    assert "735 scraped" in response.message
