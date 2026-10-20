"""One RapidAPI key serves every RapidAPI board; this maps RapidAPI's gateway errors to sync outcomes.

The gateway answers before the API does, with its own messages:
403 "You are not subscribed to this API." when the key has no plan for the
API, 401/403 for a bad key, and 429 for both per-second throttling and a used
up monthly quota ("You have exceeded the MONTHLY quota ...").
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.job_sites.base import CredentialField
from app.job_sites.errors import ConnectionConfigError, QuotaExhausted, RateLimited, SessionExpired

_TIMEOUT = httpx.Timeout(45.0)
KEYS_URL = "https://rapidapi.com/developer/apps"


def rapidapi_key_field(listing_url: str) -> CredentialField:
    return CredentialField(
        key="api_key",
        label="RapidAPI key",
        placeholder="your X-RapidAPI-Key",
        help_url=listing_url,
        help_text=(
            "One RapidAPI key works for every RapidAPI board. Subscribe this key to the API's plan "
            "on RapidAPI first (the free plan is enough to try it)."
        ),
    )


def require_key(credentials: dict[str, Any], api_name: str) -> str:
    key = str(credentials.get("api_key") or "").strip()
    if not key:
        raise ConnectionConfigError(f"{api_name} requires a RapidAPI key.")
    return key


def _gateway_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict):
        return str(body.get("message") or body.get("error") or body.get("detail") or "")[:300]
    return ""


def _reset_at(headers: httpx.Headers) -> datetime | None:
    for name in ("x-ratelimit-requests-reset", "x-ratelimit-jobs-reset", "x-ratelimit-reset"):
        raw = headers.get(name)
        try:
            seconds = float(raw) if raw else None
        except ValueError:
            seconds = None
        if seconds and seconds > 0:
            return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=seconds)
    return None


def raise_for_gateway(response: httpx.Response, *, api_name: str, listing_url: str) -> None:
    code = response.status_code
    if code < 400:
        return
    message = _gateway_message(response)
    lowered = message.lower()
    if code == 403 and "not subscribed" in lowered:
        raise ConnectionConfigError(
            f"This RapidAPI key is not subscribed to {api_name}. Subscribe to a plan at "
            f"{listing_url}, then sync again."
        )
    if code in (401, 403) and ("key" in lowered or "unauthorized" in lowered or "forbidden" in lowered):
        raise SessionExpired(f"RapidAPI rejected this key. Copy a current key from {KEYS_URL} and reconnect.")
    if code == 429:
        if "quota" in lowered:
            raise QuotaExhausted(
                f"This RapidAPI key has used its {api_name} plan quota. Upgrade the plan at {listing_url} "
                "or wait for it to reset.",
                resets_at=_reset_at(response.headers),
            )
        retry = response.headers.get("retry-after")
        try:
            wait = float(retry) if retry else None
        except ValueError:
            wait = None
        raise RateLimited(f"{api_name} is rate limiting requests. Trying again shortly.", retry_after_seconds=wait)
    response.raise_for_status()


async def rapidapi_request(
    method: str,
    host: str,
    path: str,
    *,
    api_key: str,
    api_name: str,
    listing_url: str,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    headers = {
        "X-RapidAPI-Key": api_key,
        "X-RapidAPI-Host": host,
        "Accept": "application/json",
        "User-Agent": "NAO/1.0 (+https://nao.it.com)",
    }
    timeout = httpx.Timeout(timeout_seconds) if timeout_seconds else _TIMEOUT
    async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=True) as client:
        response = await client.request(method, f"https://{host}{path}", params=params, json=json_body)
    raise_for_gateway(response, api_name=api_name, listing_url=listing_url)
    if not response.content:
        return None
    return response.json()
