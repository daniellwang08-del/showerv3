"""Unit tests for Pumble service helpers."""

from datetime import date

import pytest

from app.services import pumble_service as ps


def test_daily_parent_text():
    assert ps._daily_parent_text(date(2026, 7, 9)) == "7/9/2026 (NAO post)"


def test_clamp_auto_post_threshold():
    assert ps._clamp_auto_post_threshold(-5) == 0
    assert ps._clamp_auto_post_threshold(150) == 100
    assert ps._clamp_auto_post_threshold(75) == 75


def test_extract_message_id_top_level():
    assert ps._extract_message_id({"messageId": "abc123"}) == "abc123"
    assert ps._extract_message_id({"id": "xyz"}) == "xyz"


def test_extract_message_id_nested():
    assert ps._extract_message_id({"message": {"id": "nested-id"}}) == "nested-id"


def test_url_from_message_text():
    assert ps._url_from_message_text("https://example.com/job/1") == "https://example.com/job/1"
    assert ps._url_from_message_text("not a url") is None


def test_parse_channels_filters_direct_messages():
    payload = [
        {
            "channel": {
                "id": "ch-public",
                "name": "job_link",
                "channelType": "PRIVATE",
            }
        },
        {
            "channel": {
                "id": "dm-1",
                "name": "",
                "channelType": "DIRECT",
            }
        },
    ]
    channels = ps._parse_channels(payload)
    assert len(channels) == 1
    assert channels[0]["id"] == "ch-public"
    assert channels[0]["is_private"] is True


@pytest.mark.asyncio
async def test_verify_api_key_requires_value():
    with pytest.raises(ValueError, match="API key is required"):
        await ps.verify_api_key("")


def test_default_label():
    assert ps._default_label("jobs", "ws-1") == "ws-1 · #jobs"
    assert ps._default_label("jobs") == "#jobs"


def test_serialize_integration_shape():
    from types import SimpleNamespace

    config = SimpleNamespace(
        id="cfg-1",
        label="Team channel",
        channel_id="ch-1",
        channel_name="jobs",
        workspace_id="ws-1",
        is_enabled=True,
        auto_post_threshold=80,
        parent_posted_date=None,
    )
    row = ps._serialize_integration(config, api_key_hint="abc…xyz")
    assert row["id"] == "cfg-1"
    assert row["label"] == "Team channel"
    assert row["is_enabled"] is True
    assert row["api_key_hint"] == "abc…xyz"
