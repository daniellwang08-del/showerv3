"""Unit tests for Gmail OAuth helpers and message parsing (no live Google calls)."""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import gmail_service as gmail


@pytest.fixture
def oauth_settings(monkeypatch):
    settings = SimpleNamespace(
        google_oauth_client_id="client-id",
        google_oauth_client_secret="client-secret",
        google_oauth_redirect_uri="http://127.0.0.1:8000/api/v1/gmail/callback",
        auth_secret_key="test-auth-secret-key-for-gmail-32b",
        frontend_url="http://localhost:5173",
        settings_encryption_key="test-settings-encryption-key",
        app_env="local",
    )
    monkeypatch.setattr(gmail, "get_settings", lambda: settings)
    # secret_encryption also reads settings; keep encrypt/decrypt working in unit tests.
    from app.utils import secret_encryption

    secret_encryption._fernet = None
    monkeypatch.setattr(secret_encryption, "get_settings", lambda: settings)
    return settings


def test_oauth_configured_requires_both_credentials(oauth_settings, monkeypatch):
    assert gmail.oauth_configured() is True
    oauth_settings.google_oauth_client_secret = ""
    assert gmail.oauth_configured() is False


def test_resolve_redirect_uri_prefers_explicit(oauth_settings):
    assert gmail.resolve_redirect_uri("https://ignored.example") == (
        "http://127.0.0.1:8000/api/v1/gmail/callback"
    )


def test_resolve_redirect_uri_falls_back_to_request(oauth_settings):
    oauth_settings.google_oauth_redirect_uri = ""
    assert gmail.resolve_redirect_uri("https://api.example.com") == (
        "https://api.example.com/api/v1/gmail/callback"
    )


def test_oauth_state_round_trip(oauth_settings):
    state = gmail.create_oauth_state("user-123")
    assert gmail.verify_oauth_state(state) == "user-123"


def test_oauth_state_rejects_tampering(oauth_settings):
    state = gmail.create_oauth_state("user-123")
    with pytest.raises(gmail.GmailAuthError):
        gmail.verify_oauth_state(state + "x")


def test_build_authorize_url_is_readonly(oauth_settings):
    url = gmail.build_authorize_url(
        user_id="u1",
        redirect_uri="http://127.0.0.1:8000/api/v1/gmail/callback",
    )
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "gmail.readonly" in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "gmail.modify" not in url
    assert "mail.google.com" not in url


def test_summarize_message_reads_headers():
    raw = {
        "id": "abc",
        "threadId": "thr",
        "snippet": "Hello there",
        "internalDate": "1700000000000",
        "labelIds": ["INBOX"],
        "payload": {
            "headers": [
                {"name": "Subject", "value": "Offer update"},
                {"name": "From", "value": "Jobs <jobs@acme.com>"},
                {"name": "To", "value": "you@gmail.com"},
            ]
        },
    }
    summary = gmail.summarize_message(raw)
    assert summary["id"] == "abc"
    assert summary["subject"] == "Offer update"
    assert summary["from"] == "Jobs <jobs@acme.com>"
    assert summary["snippet"] == "Hello there"
    assert summary["date"]


def test_extract_message_body_prefers_plain_text():
    raw = {
        "payload": {
            "mimeType": "multipart/alternative",
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": "SGVsbG8gcGxhaW4="},  # Hello plain
                },
                {
                    "mimeType": "text/html",
                    "body": {"data": "PGI+SFRNTDwvYj4="},  # <b>HTML</b>
                },
            ],
        }
    }
    assert gmail.extract_message_body(raw) == "Hello plain"


def test_frontend_integrations_url(oauth_settings):
    url = gmail.frontend_integrations_url(gmail="connected")
    assert url.startswith("http://localhost:5173/app/integrations?")
    assert "tab=inbox" in url
    assert "gmail=connected" in url


@pytest.mark.asyncio
async def test_search_messages_empty_query_rejected():
    with pytest.raises(gmail.GmailError) as ei:
        await gmail.search_messages("token", query="  ")
    assert ei.value.code == "empty_query"


@pytest.mark.asyncio
async def test_search_messages_fetches_metadata(monkeypatch):
    list_payload = {
        "messages": [{"id": "m1"}, {"id": "m2"}],
        "resultSizeEstimate": 2,
    }
    detail = {
        "id": "m1",
        "threadId": "t1",
        "snippet": "Hi",
        "internalDate": "1700000000000",
        "payload": {"headers": [{"name": "Subject", "value": "Hello"}, {"name": "From", "value": "a@b.com"}]},
    }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None, params=None):
            resp = MagicMock()
            resp.status_code = 200
            if url.endswith("/users/me/messages"):
                resp.json.return_value = list_payload
            else:
                payload = {**detail, "id": url.rsplit("/", 1)[-1]}
                resp.json.return_value = payload
            return resp

    monkeypatch.setattr(gmail.httpx, "AsyncClient", FakeClient)
    out = await gmail.search_messages("tok", query="from:a@b.com", max_results=10)
    assert out["query"] == "from:a@b.com"
    assert len(out["messages"]) == 2
    assert out["messages"][0]["subject"] == "Hello"


@pytest.mark.asyncio
async def test_get_valid_access_token_uses_cached(monkeypatch, oauth_settings):
    from app.utils.secret_encryption import encrypt_secret

    row = SimpleNamespace(
        is_enabled=True,
        status=gmail.STATUS_CONNECTED,
        last_error=None,
        access_token_encrypted=encrypt_secret("cached-access"),
        access_token_expires_at=datetime.utcnow() + timedelta(hours=1),
        refresh_token_encrypted=encrypt_secret("refresh"),
    )
    refresh = AsyncMock()
    monkeypatch.setattr(gmail, "_refresh_access_token", refresh)
    token = await gmail.get_valid_access_token(MagicMock(), row)
    assert token == "cached-access"
    refresh.assert_not_awaited()
