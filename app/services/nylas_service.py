"""Nylas v3 mail access: hosted auth, grant bookkeeping and read-only message reads.

Nylas stores and refreshes each user's provider tokens. We keep only the grant
id and authenticate every call with the server API key, so no mailbox secret is
ever stored in our database.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from lxml import html as lxml_html
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import MailConnection

logger = get_logger(__name__)

_OAUTH_STATE_PURPOSE = "nylas_mail_oauth"
_OAUTH_STATE_TTL = timedelta(minutes=15)
_MESSAGE_FIELDS = "id,thread_id,subject,from,to,date,snippet,attachments"
MAX_INVITE_BYTES = 256 * 1024
# Smaller pages keep each provider query under the Nylas gateway timeout.
MAX_PAGE_SIZE = 100
MAX_ATTEMPTS = 4
RETRY_BASE_DELAY = 1.0

STATUS_CONNECTED = "connected"
STATUS_NEEDS_REAUTH = "needs_reauth"

PROVIDER_LABEL = {
    "google": "Gmail",
    "microsoft": "Outlook",
    "yahoo": "Yahoo Mail",
    "icloud": "iCloud Mail",
    "imap": "IMAP",
    "ews": "Exchange",
}


class MailError(Exception):
    """User-facing mail integration failure."""

    def __init__(self, message: str, *, code: str = "mail_error", status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class MailNotConfiguredError(MailError):
    def __init__(self, message: str = "Mail access is not configured on this server"):
        super().__init__(message, code="not_configured", status_code=503)


class MailAuthError(MailError):
    def __init__(self, message: str, *, code: str = "needs_reauth"):
        super().__init__(message, code=code, status_code=401)


def configured() -> bool:
    s = get_settings()
    return bool(s.nylas_api_key.strip() and s.nylas_client_id.strip())


def _api_uri() -> str:
    return (get_settings().nylas_api_uri or "https://api.us.nylas.com").strip().rstrip("/")


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {get_settings().nylas_api_key.strip()}", "Accept": "application/json"}


def server_status() -> dict[str, Any]:
    return {"server_configured": configured(), "providers": list(PROVIDER_LABEL.values())}


def resolve_redirect_uri(request_base_url: str | None = None) -> str:
    explicit = (get_settings().nylas_redirect_uri or "").strip()
    if explicit:
        return explicit.rstrip("/")
    base = (request_base_url or "").strip().rstrip("/")
    if not base:
        raise MailNotConfiguredError("NYLAS_REDIRECT_URI is not set and the request URL is unavailable")
    return f"{base}/api/v1/mail/callback"


def frontend_interviews_url(*, mail: str, reason: str | None = None) -> str:
    origin = (get_settings().frontend_url or "").strip().rstrip("/") or "http://localhost:5173"
    params = {"mail": mail}
    if reason:
        params["reason"] = reason[:200]
    return f"{origin}/app/interviews?{urlencode(params)}"


def create_oauth_state(user_id: str) -> str:
    secret = get_settings().auth_secret_key.strip()
    if not secret:
        raise MailNotConfiguredError("AUTH_SECRET_KEY is required for mail sign-in")
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": _OAUTH_STATE_PURPOSE,
        "user_id": user_id,
        "nonce": uuid.uuid4().hex[:12],
        "iat": int(now.timestamp()),
        "exp": int((now + _OAUTH_STATE_TTL).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def verify_oauth_state(state: str) -> str:
    try:
        payload = jwt.decode(state, get_settings().auth_secret_key, algorithms=["HS256"])
    except jwt.PyJWTError as e:
        raise MailAuthError("Sign-in link expired. Try connecting again.", code="invalid_state") from e
    user_id = payload.get("user_id")
    if payload.get("purpose") != _OAUTH_STATE_PURPOSE or not isinstance(user_id, str) or not user_id.strip():
        raise MailAuthError("Sign-in state is invalid", code="invalid_state")
    return user_id.strip()


def build_authorize_url(*, user_id: str, redirect_uri: str, login_hint: str | None = None) -> str:
    if not configured():
        raise MailNotConfiguredError()
    params = {
        "client_id": get_settings().nylas_client_id.strip(),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "access_type": "online",
        "state": create_oauth_state(user_id),
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{_api_uri()}/v3/connect/auth?{urlencode(params)}"


def _retry_delay(resp: httpx.Response | None, attempt: int) -> float:
    if resp is not None and resp.status_code == 429:
        try:
            return min(float(resp.headers.get("Retry-After", "")), 20.0)
        except ValueError:
            pass
    return RETRY_BASE_DELAY * (3**attempt)


async def _request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    # Reads are retried: providers behind Nylas time out (504) or throttle now and then.
    attempts = MAX_ATTEMPTS if method == "GET" else 1
    resp: httpx.Response | None = None
    for attempt in range(attempts):
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                resp = await client.request(method, f"{_api_uri()}{path}", headers=_auth_headers(), **kwargs)
        except httpx.HTTPError as e:
            if attempt + 1 < attempts:
                await asyncio.sleep(_retry_delay(None, attempt))
                continue
            raise MailError("Could not reach the mail service. Try again shortly.", code="network", status_code=502) from e
        if (resp.status_code == 429 or resp.status_code >= 500) and attempt + 1 < attempts:
            logger.info("nylas_request_retry", path=path.split("?")[0], status=resp.status_code, attempt=attempt + 1)
            await asyncio.sleep(_retry_delay(resp, attempt))
            continue
        break
    assert resp is not None
    if resp.status_code in (401, 403, 404) and "/grants/" in path:
        raise MailAuthError("Mail access expired or was revoked. Connect your email again.")
    if resp.status_code == 429:
        raise MailError("Mail provider rate limit reached. Try again in a minute.", code="rate_limited", status_code=429)
    if resp.status_code >= 400:
        logger.warning("nylas_request_failed", path=path.split("?")[0], status=resp.status_code, body=resp.text[:300])
        raise MailError(f"Mail service error ({resp.status_code})", code="api_error", status_code=502)
    if not resp.content:
        return {}
    data = resp.json()
    return data if isinstance(data, dict) else {}


async def exchange_code(code: str, *, redirect_uri: str) -> dict[str, Any]:
    """Trade the hosted-auth code for a grant; returns grant_id, email and provider."""
    if not configured():
        raise MailNotConfiguredError()
    s = get_settings()
    body = {
        "client_id": s.nylas_client_id.strip(),
        "client_secret": s.nylas_api_key.strip(),
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{_api_uri()}/v3/connect/token", json=body)
    except httpx.HTTPError as e:
        raise MailError("Could not reach the mail service", code="network", status_code=502) from e
    if resp.status_code >= 400:
        logger.warning("nylas_token_exchange_failed", status=resp.status_code, body=resp.text[:300])
        raise MailAuthError("Could not finish connecting your email", code="token_exchange_failed")
    payload = resp.json() or {}
    grant_id = payload.get("grant_id")
    if not isinstance(grant_id, str) or not grant_id:
        raise MailAuthError("The mail service did not return a grant", code="token_exchange_failed")
    email = payload.get("email")
    provider = payload.get("provider")
    if not email or not provider:
        grant = (await _request("GET", f"/v3/grants/{grant_id}")).get("data") or {}
        email = email or grant.get("email")
        provider = provider or grant.get("provider")
    return {
        "grant_id": grant_id,
        "email": str(email or "").strip().lower() or "unknown",
        "provider": str(provider or "").strip().lower() or None,
    }


async def revoke_grant(grant_id: str) -> None:
    try:
        await _request("DELETE", f"/v3/grants/{grant_id}")
    except MailError as e:
        logger.info("nylas_grant_delete_failed", error=str(e))


def _epoch(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


async def list_messages(
    grant_id: str,
    *,
    received_after: datetime,
    max_messages: int,
) -> list[dict[str, Any]]:
    """Message headers newest first, received after the given time (UTC)."""
    out: list[dict[str, Any]] = []
    page_token: str | None = None
    while len(out) < max_messages:
        params: dict[str, Any] = {
            "limit": min(MAX_PAGE_SIZE, max_messages - len(out)),
            "received_after": _epoch(received_after),
            "select": _MESSAGE_FIELDS,
        }
        if page_token:
            params["page_token"] = page_token
        data = await _request("GET", f"/v3/grants/{grant_id}/messages", params=params)
        batch = data.get("data") or []
        if not isinstance(batch, list) or not batch:
            break
        out.extend(m for m in batch if isinstance(m, dict) and m.get("id"))
        page_token = data.get("next_cursor") or None
        if not page_token:
            break
    return out[:max_messages]


async def get_message(grant_id: str, message_id: str) -> dict[str, Any]:
    data = await _request("GET", f"/v3/grants/{grant_id}/messages/{message_id}")
    msg = data.get("data")
    return msg if isinstance(msg, dict) else {}


def calendar_invite(raw: dict[str, Any]) -> dict[str, Any] | None:
    """The message's calendar invitation attachment (.ics), if it has one."""
    for a in raw.get("attachments") or []:
        if not isinstance(a, dict) or not a.get("id"):
            continue
        ctype = str(a.get("content_type") or "").lower()
        name = str(a.get("filename") or "").lower()
        if ctype.startswith(("text/calendar", "application/ics")) or name.endswith(".ics"):
            return {"id": str(a["id"]), "size": int(a.get("size") or 0)}
    return None


async def download_invite(grant_id: str, message_id: str, attachment_id: str) -> str:
    """Text of a calendar attachment; empty when it is missing or too large."""
    path = f"/v3/grants/{grant_id}/attachments/{attachment_id}/download"
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.get(f"{_api_uri()}{path}", params={"message_id": message_id}, headers=_auth_headers())
    except httpx.HTTPError as e:
        logger.info("nylas_invite_download_failed", error=type(e).__name__)
        return ""
    if resp.status_code in (401, 403):
        raise MailAuthError("Mail access expired or was revoked. Connect your email again.")
    if resp.status_code >= 400 or len(resp.content) > MAX_INVITE_BYTES:
        logger.info("nylas_invite_download_skipped", status=resp.status_code, size=len(resp.content))
        return ""
    return resp.content.decode("utf-8", errors="replace")


_WS = re.compile(r"[ \t\r\f\v]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")


def html_to_text(body: str | None) -> str:
    """Readable plain text from an HTML (or plain) email body."""
    if not body:
        return ""
    if "<" not in body:
        text = body
    else:
        try:
            doc = lxml_html.fromstring(body)
            for bad in doc.xpath("//script|//style|//head"):
                bad.drop_tree()
            for br in doc.xpath("//br"):
                br.tail = "\n" + (br.tail or "")
            for block in doc.xpath("//p|//div|//tr|//li|//h1|//h2|//h3|//h4"):
                block.tail = "\n" + (block.tail or "")
            for link in doc.xpath("//a[@href]"):
                href = link.get("href") or ""
                if href.startswith("http") and href not in (link.text_content() or ""):
                    link.tail = f" ({href})" + (link.tail or "")
            text = doc.text_content()
        except Exception:
            text = re.sub(r"<[^>]+>", " ", body)
    text = _WS.sub(" ", text)
    return _BLANK_LINES.sub("\n\n", text).strip()


def sender_label(raw_from: Any) -> str:
    if isinstance(raw_from, list) and raw_from:
        first = raw_from[0] if isinstance(raw_from[0], dict) else {}
        name = str(first.get("name") or "").strip()
        email = str(first.get("email") or "").strip()
        if name and email:
            return f"{name} <{email}>"
        return name or email
    return str(raw_from or "")


def message_datetime(raw: dict[str, Any]) -> datetime | None:
    """Naive UTC datetime from a Nylas message ``date`` (unix seconds)."""
    try:
        return datetime.fromtimestamp(int(raw.get("date")), tz=timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OverflowError):
        return None


async def get_connection(session: AsyncSession, user_id: str) -> MailConnection | None:
    return (
        await session.execute(select(MailConnection).where(MailConnection.user_id == user_id))
    ).scalar_one_or_none()


async def upsert_connection(
    session: AsyncSession, *, user_id: str, grant_id: str, email: str, provider: str | None
) -> MailConnection:
    row = await get_connection(session, user_id)
    now = datetime.utcnow()
    if row is None:
        row = MailConnection(id=str(uuid.uuid4()), user_id=user_id, grant_id=grant_id, email=email)
        session.add(row)
    elif row.grant_id != grant_id:
        old = row.grant_id
        if row.email != email:
            row.sync_cursor = None
        row.grant_id = grant_id
        await revoke_grant(old)
    row.email = email
    row.provider = provider
    row.status = STATUS_CONNECTED
    row.last_error = None
    row.connected_at = now
    await session.commit()
    await session.refresh(row)
    return row


async def delete_connection(session: AsyncSession, user_id: str) -> bool:
    row = await get_connection(session, user_id)
    if row is None:
        return False
    grant_id = row.grant_id
    await session.delete(row)
    await session.commit()
    await revoke_grant(grant_id)
    return True


def _iso(dt: datetime | None) -> str | None:
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


def connection_public(row: MailConnection | None) -> dict[str, Any]:
    if row is None:
        return {"connected": False}
    return {
        "connected": True,
        "email": row.email,
        "provider": row.provider,
        "provider_label": PROVIDER_LABEL.get(row.provider or "", (row.provider or "Email").title()),
        "status": row.status or STATUS_CONNECTED,
        "last_error": row.last_error,
        "sync_status": row.sync_status or "idle",
        "sync_started_at": _iso(row.sync_started_at),
        "last_synced_at": _iso(row.last_synced_at),
        "last_sync_error": row.last_sync_error,
        "last_sync_stats": row.last_sync_stats or None,
        "connected_at": _iso(row.connected_at),
    }
