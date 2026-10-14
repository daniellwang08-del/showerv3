"""Gmail read-only OAuth + inbox search for per-user connections.

Uses Google OAuth authorization code flow with ``gmail.readonly`` only.
Refresh tokens are Fernet-encrypted at rest (same helpers as Pumble keys).
"""

from __future__ import annotations

import asyncio
import base64
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import GmailConnection
from app.utils.secret_encryption import decrypt_secret, encrypt_secret

logger = get_logger(__name__)

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email"
OPENID_SCOPE = "openid"

SCOPES = (GMAIL_READONLY_SCOPE, USERINFO_EMAIL_SCOPE, OPENID_SCOPE)
SCOPE_STRING = " ".join(SCOPES)

_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
_OAUTH_STATE_PURPOSE = "gmail_oauth"
_OAUTH_STATE_TTL = timedelta(minutes=15)
_ACCESS_TOKEN_SKEW = timedelta(seconds=60)
_MAX_SEARCH_RESULTS = 25
_DEFAULT_SEARCH_RESULTS = 15

STATUS_CONNECTED = "connected"
STATUS_NEEDS_REAUTH = "needs_reauth"


class GmailError(Exception):
    """User-facing Gmail integration failure."""

    def __init__(self, message: str, *, code: str = "gmail_error", status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class GmailNotConfiguredError(GmailError):
    def __init__(self, message: str = "Gmail OAuth is not configured on this server"):
        super().__init__(message, code="not_configured", status_code=503)


class GmailAuthError(GmailError):
    def __init__(self, message: str, *, code: str = "auth_error"):
        super().__init__(message, code=code, status_code=401)


def oauth_configured() -> bool:
    settings = get_settings()
    return bool(settings.google_oauth_client_id.strip() and settings.google_oauth_client_secret.strip())


def get_server_status() -> dict[str, Any]:
    return {
        "server_configured": oauth_configured(),
        "scopes": list(SCOPES),
    }


def resolve_redirect_uri(request_base_url: str | None = None) -> str:
    settings = get_settings()
    explicit = (settings.google_oauth_redirect_uri or "").strip()
    if explicit:
        return explicit.rstrip("/")
    base = (request_base_url or "").strip().rstrip("/")
    if not base:
        raise GmailNotConfiguredError(
            "GOOGLE_OAUTH_REDIRECT_URI is not set and the request base URL is unavailable"
        )
    return f"{base}/api/v1/gmail/callback"


def frontend_integrations_url(*, gmail: str, reason: str | None = None) -> str:
    settings = get_settings()
    origin = (settings.frontend_url or "").strip().rstrip("/") or "http://localhost:5173"
    params = {"tab": "inbox", "gmail": gmail}
    if reason:
        params["reason"] = reason[:200]
    return f"{origin}/app/integrations?{urlencode(params)}"


def create_oauth_state(user_id: str) -> str:
    settings = get_settings()
    if not settings.auth_secret_key.strip():
        raise GmailNotConfiguredError("AUTH_SECRET_KEY is required for Gmail OAuth state")
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": _OAUTH_STATE_PURPOSE,
        "user_id": user_id,
        "nonce": uuid.uuid4().hex,
        "iat": int(now.timestamp()),
        "exp": int((now + _OAUTH_STATE_TTL).timestamp()),
    }
    return jwt.encode(payload, settings.auth_secret_key, algorithm="HS256")


def verify_oauth_state(state: str) -> str:
    settings = get_settings()
    try:
        payload = jwt.decode(state, settings.auth_secret_key, algorithms=["HS256"])
    except jwt.PyJWTError as e:
        raise GmailAuthError("OAuth state is invalid or expired", code="invalid_state") from e
    if payload.get("purpose") != _OAUTH_STATE_PURPOSE:
        raise GmailAuthError("OAuth state purpose mismatch", code="invalid_state")
    user_id = payload.get("user_id")
    if not isinstance(user_id, str) or not user_id.strip():
        raise GmailAuthError("OAuth state missing user", code="invalid_state")
    return user_id.strip()


def build_authorize_url(*, user_id: str, redirect_uri: str) -> str:
    if not oauth_configured():
        raise GmailNotConfiguredError()
    settings = get_settings()
    params = {
        "client_id": settings.google_oauth_client_id.strip(),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE_STRING,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "false",
        "state": create_oauth_state(user_id),
    }
    return f"{_AUTH_URL}?{urlencode(params)}"


async def exchange_code(code: str, *, redirect_uri: str) -> dict[str, Any]:
    if not oauth_configured():
        raise GmailNotConfiguredError()
    settings = get_settings()
    data = {
        "code": code,
        "client_id": settings.google_oauth_client_id.strip(),
        "client_secret": settings.google_oauth_client_secret.strip(),
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(_TOKEN_URL, data=data)
    if resp.status_code >= 400:
        logger.warning("gmail_token_exchange_failed", status=resp.status_code)
        raise GmailAuthError("Could not complete Google sign-in", code="token_exchange_failed")
    payload = resp.json()
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise GmailAuthError("Google did not return an access token", code="token_exchange_failed")
    refresh_token = payload.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token:
        raise GmailAuthError(
            "Google did not return a refresh token. Disconnect the app in your Google Account "
            "permissions and connect again.",
            code="missing_refresh_token",
        )
    expires_in = int(payload.get("expires_in") or 3600)
    scope = str(payload.get("scope") or SCOPE_STRING)
    if GMAIL_READONLY_SCOPE not in scope.split():
        raise GmailAuthError(
            "Gmail read access was not granted. Connect again and allow inbox read permission.",
            code="missing_scope",
        )
    email = await _fetch_profile_email(access_token)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": expires_in,
        "scope": scope,
        "google_email": email,
    }


async def _fetch_profile_email(access_token: str) -> str:
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            f"{_GMAIL_API}/users/me/profile",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if resp.status_code >= 400:
        raise GmailAuthError("Could not read the Google account email", code="profile_failed")
    email = (resp.json() or {}).get("emailAddress")
    if not isinstance(email, str) or "@" not in email:
        raise GmailAuthError("Google profile did not include an email address", code="profile_failed")
    return email.strip().lower()


async def upsert_connection(
    session: AsyncSession,
    *,
    user_id: str,
    google_email: str,
    refresh_token: str,
    access_token: str,
    expires_in: int,
    scopes: str,
) -> GmailConnection:
    result = await session.execute(select(GmailConnection).where(GmailConnection.user_id == user_id))
    row = result.scalar_one_or_none()
    now = datetime.utcnow()
    expires_at = now + timedelta(seconds=max(60, expires_in))
    if row is None:
        row = GmailConnection(
            id=str(uuid.uuid4()),
            user_id=user_id,
            google_email=google_email,
            refresh_token_encrypted=encrypt_secret(refresh_token),
            access_token_encrypted=encrypt_secret(access_token),
            access_token_expires_at=expires_at,
            scopes=scopes,
            is_enabled=True,
            status=STATUS_CONNECTED,
            last_error=None,
            connected_at=now,
        )
        session.add(row)
    else:
        # Google may omit refresh_token on re-consent if one already exists; we
        # always require it in exchange_code, so replace when present.
        row.google_email = google_email
        row.refresh_token_encrypted = encrypt_secret(refresh_token)
        row.access_token_encrypted = encrypt_secret(access_token)
        row.access_token_expires_at = expires_at
        row.scopes = scopes
        row.is_enabled = True
        row.status = STATUS_CONNECTED
        row.last_error = None
        row.connected_at = now
    await session.commit()
    await session.refresh(row)
    return row


async def get_connection(session: AsyncSession, user_id: str) -> GmailConnection | None:
    result = await session.execute(select(GmailConnection).where(GmailConnection.user_id == user_id))
    return result.scalar_one_or_none()


def connection_public(row: GmailConnection | None) -> dict[str, Any]:
    if row is None:
        return {"configured": False}
    return {
        "configured": True,
        "google_email": row.google_email,
        "is_enabled": bool(row.is_enabled),
        "status": row.status or STATUS_CONNECTED,
        "last_error": row.last_error,
        "scopes": (row.scopes or "").split(),
        "connected_at": row.connected_at.isoformat() if row.connected_at else None,
    }


async def set_enabled(session: AsyncSession, user_id: str, enabled: bool) -> GmailConnection:
    row = await get_connection(session, user_id)
    if row is None:
        raise GmailError("Gmail is not connected", code="not_connected", status_code=404)
    row.is_enabled = bool(enabled)
    await session.commit()
    await session.refresh(row)
    return row


async def delete_connection(session: AsyncSession, user_id: str) -> bool:
    row = await get_connection(session, user_id)
    if row is None:
        return False
    refresh = None
    try:
        refresh = decrypt_secret(row.refresh_token_encrypted)
    except ValueError:
        logger.warning("gmail_refresh_decrypt_failed_on_disconnect", user_id=user_id)
    await session.delete(row)
    await session.commit()
    if refresh:
        await _revoke_token(refresh)
    return True


async def _revoke_token(token: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(_REVOKE_URL, data={"token": token})
    except Exception as e:
        logger.info("gmail_revoke_failed", error=str(e))


async def _refresh_access_token(session: AsyncSession, row: GmailConnection) -> str:
    if not oauth_configured():
        raise GmailNotConfiguredError()
    settings = get_settings()
    try:
        refresh_token = decrypt_secret(row.refresh_token_encrypted)
    except ValueError as e:
        row.status = STATUS_NEEDS_REAUTH
        row.last_error = "Stored Gmail credentials could not be decrypted"
        await session.commit()
        raise GmailAuthError(row.last_error, code="decrypt_failed") from e

    data = {
        "client_id": settings.google_oauth_client_id.strip(),
        "client_secret": settings.google_oauth_client_secret.strip(),
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(_TOKEN_URL, data=data)
    if resp.status_code >= 400:
        body = {}
        try:
            body = resp.json()
        except Exception:
            body = {}
        err = str(body.get("error") or "")
        row.status = STATUS_NEEDS_REAUTH
        row.last_error = "Gmail access was revoked or expired. Connect again."
        await session.commit()
        logger.warning("gmail_refresh_failed", status=resp.status_code, error=err)
        raise GmailAuthError(row.last_error, code="needs_reauth")

    payload = resp.json()
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise GmailAuthError("Google refresh did not return an access token", code="refresh_failed")
    expires_in = int(payload.get("expires_in") or 3600)
    row.access_token_encrypted = encrypt_secret(access_token)
    row.access_token_expires_at = datetime.utcnow() + timedelta(seconds=max(60, expires_in))
    row.status = STATUS_CONNECTED
    row.last_error = None
    await session.commit()
    return access_token


async def get_valid_access_token(session: AsyncSession, row: GmailConnection) -> str:
    if not row.is_enabled:
        raise GmailError("Gmail integration is turned off", code="disabled", status_code=400)
    if row.status == STATUS_NEEDS_REAUTH:
        raise GmailAuthError(
            row.last_error or "Gmail needs to be reconnected",
            code="needs_reauth",
        )
    expires = row.access_token_expires_at
    if row.access_token_encrypted and expires is not None:
        # Stored timestamps are naive UTC.
        if expires > datetime.utcnow() + _ACCESS_TOKEN_SKEW:
            try:
                return decrypt_secret(row.access_token_encrypted)
            except ValueError:
                pass
    return await _refresh_access_token(session, row)


def _header_map(payload: dict[str, Any]) -> dict[str, str]:
    headers = (payload.get("payload") or {}).get("headers") or []
    out: dict[str, str] = {}
    if not isinstance(headers, list):
        return out
    for item in headers:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        value = item.get("value")
        if isinstance(name, str) and isinstance(value, str):
            out[name.lower()] = value
    return out


def _parse_internal_date(ms: Any) -> str | None:
    try:
        value = int(ms)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc).isoformat()


def _parse_date_header(value: str | None) -> str | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def summarize_message(raw: dict[str, Any]) -> dict[str, Any]:
    headers = _header_map(raw)
    date = _parse_internal_date(raw.get("internalDate")) or _parse_date_header(headers.get("date"))
    return {
        "id": raw.get("id"),
        "thread_id": raw.get("threadId"),
        "snippet": (raw.get("snippet") or "").strip(),
        "subject": (headers.get("subject") or "").strip() or "(no subject)",
        "from": (headers.get("from") or "").strip(),
        "to": (headers.get("to") or "").strip(),
        "date": date,
        "label_ids": list(raw.get("labelIds") or []),
    }


def _decode_body_data(data: str | None) -> str:
    if not data:
        return ""
    padded = data + "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _walk_parts(part: dict[str, Any], *, prefer_plain: bool = True) -> str:
    mime = str(part.get("mimeType") or "")
    body = part.get("body") if isinstance(part.get("body"), dict) else {}
    data = body.get("data") if isinstance(body, dict) else None
    if mime.startswith("text/") and isinstance(data, str):
        text = _decode_body_data(data)
        if text:
            return text
    parts = part.get("parts")
    if not isinstance(parts, list):
        return ""
    plain = ""
    html = ""
    for child in parts:
        if not isinstance(child, dict):
            continue
        child_mime = str(child.get("mimeType") or "")
        extracted = _walk_parts(child, prefer_plain=prefer_plain)
        if not extracted:
            continue
        if child_mime == "text/plain" and not plain:
            plain = extracted
        elif child_mime == "text/html" and not html:
            html = extracted
        elif not plain and not html:
            plain = extracted
    if prefer_plain:
        return plain or html
    return html or plain


def extract_message_body(raw: dict[str, Any]) -> str:
    payload = raw.get("payload")
    if not isinstance(payload, dict):
        return ""
    text = _walk_parts(payload)
    return text.strip()


async def _gmail_get(
    client: httpx.AsyncClient,
    path: str,
    *,
    access_token: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resp = await client.get(
        f"{_GMAIL_API}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params or {},
    )
    if resp.status_code == 401:
        raise GmailAuthError("Gmail access expired. Connect again.", code="needs_reauth")
    if resp.status_code == 403:
        raise GmailError("Gmail API denied this request", code="forbidden", status_code=403)
    if resp.status_code == 429:
        raise GmailError("Gmail rate limit reached. Try again shortly.", code="rate_limited", status_code=429)
    if resp.status_code >= 400:
        raise GmailError(f"Gmail API error ({resp.status_code})", code="api_error", status_code=502)
    data = resp.json()
    return data if isinstance(data, dict) else {}


async def search_messages(
    access_token: str,
    *,
    query: str,
    max_results: int = _DEFAULT_SEARCH_RESULTS,
) -> dict[str, Any]:
    q = (query or "").strip()
    if not q:
        raise GmailError("Search query is required", code="empty_query", status_code=422)
    if len(q) > 500:
        raise GmailError("Search query is too long", code="query_too_long", status_code=422)
    limit = max(1, min(int(max_results), _MAX_SEARCH_RESULTS))

    async with httpx.AsyncClient(timeout=30.0) as client:
        listed = await _gmail_get(
            client,
            "/users/me/messages",
            access_token=access_token,
            params={"q": q, "maxResults": limit},
        )
        refs = listed.get("messages") or []
        if not isinstance(refs, list) or not refs:
            return {"query": q, "result_size_estimate": listed.get("resultSizeEstimate") or 0, "messages": []}

        async def fetch_one(message_id: str) -> dict[str, Any] | None:
            try:
                raw = await _gmail_get(
                    client,
                    f"/users/me/messages/{message_id}",
                    access_token=access_token,
                    params={"format": "metadata", "metadataHeaders": ["From", "To", "Subject", "Date"]},
                )
                return summarize_message(raw)
            except GmailError:
                raise
            except Exception as e:
                logger.warning("gmail_message_fetch_failed", message_id=message_id, error=str(e))
                return None

        ids = [str(item.get("id")) for item in refs if isinstance(item, dict) and item.get("id")]
        fetched = await asyncio.gather(*[fetch_one(mid) for mid in ids])

    messages = [m for m in fetched if m and m.get("id")]
    return {
        "query": q,
        "result_size_estimate": listed.get("resultSizeEstimate") or len(messages),
        "messages": messages,
    }


async def get_message_detail(access_token: str, message_id: str) -> dict[str, Any]:
    mid = (message_id or "").strip()
    if not mid or len(mid) > 200:
        raise GmailError("Invalid message id", code="invalid_id", status_code=422)
    async with httpx.AsyncClient(timeout=30.0) as client:
        raw = await _gmail_get(
            client,
            f"/users/me/messages/{mid}",
            access_token=access_token,
            params={"format": "full"},
        )
    summary = summarize_message(raw)
    summary["body_text"] = extract_message_body(raw)
    return summary
