"""Regression: job-site connect helpers must resolve without NameError."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from app.api import job_sites_routes as routes
from app.job_sites.base import FetchContext


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
