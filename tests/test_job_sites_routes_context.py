"""Regression: job-site connect helpers must resolve without NameError."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from app.api import job_sites_routes as routes
from app.job_sites.base import FetchContext
from app.job_sites.registry import get_plugin
from app.services.job_site_connection_sync import credential_hints


class _FakeUser:
    email = "user@example.com"
    country_preferences = ["US"]
    id = "u1"
    is_active = True


class _FakeResult:
    def scalar_one_or_none(self):
        return _FakeUser()


class _FakeSession:
    async def execute(self, *a, **k):
        return _FakeResult()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def test_user_fetch_context_resolves_without_nameerror():
    async def _run():
        with patch.object(routes, "get_session", return_value=_FakeSession()):
            ctx = await routes._user_fetch_context("u1")
        assert isinstance(ctx, FetchContext)
        assert ctx.user_email == "user@example.com"
        assert ctx.primary_country == "US"

    asyncio.run(_run())


def test_browser_capture_merges_cookies_and_storage():
    """Extension capture arrives as cookies + web storage, with no password."""
    plugin = get_plugin("jobright")
    body = routes.JobSiteConnectRequest(
        credentials={"cookie_header": "SESSION_ID=abc"},
        cookies=[{"name": "SESSION_ID", "value": "abc", "domain": ".jobright.ai"}],
        storage={
            "localStorage": {"token": "xyz"},
            "sessionStorage": {},
            "ignored": "not-a-dict",
        },
    )
    creds = routes._merge_credentials(plugin, body)

    assert creds["cookies"][0]["name"] == "SESSION_ID"
    assert creds["storage"] == {"localStorage": {"token": "xyz"}}

    hints = credential_hints("jobright", creds)
    assert hints["cookies"] == "1 cookies"
    assert hints["storage"] == "1 keys"
    assert hints["session"] == "captured from browser"
    assert "password" not in hints


def test_trim_storage_enforces_size_budget():
    big = {"localStorage": {"a": "x" * (routes.MAX_STORAGE_CHARS + 10), "b": "small"}}
    trimmed = routes._trim_storage(big)
    assert trimmed == {"localStorage": {"b": "small"}}
