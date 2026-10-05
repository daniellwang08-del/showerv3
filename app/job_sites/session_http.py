"""Cookie-authenticated fetches for session-based job sites (curl_cffi)."""

from __future__ import annotations

import asyncio
from typing import Any

from app.core.logging import get_logger
from app.job_sites.errors import RateLimited, SessionExpired

logger = get_logger(__name__)


def _retry_after(raw: str | None) -> float | None:
    try:
        return max(0.0, float(raw)) if raw else None
    except ValueError:
        return None

BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
}


def normalize_cookies(raw: Any) -> list[dict]:
    """Accept Chrome extension cookies or Playwright-shaped cookies."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "")
        if not name or not value:
            continue
        domain = str(item.get("domain") or "")
        path = str(item.get("path") or "/")
        out.append(
            {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path,
                "secure": bool(item.get("secure", True)),
                "httpOnly": bool(item.get("httpOnly") or item.get("http_only")),
            }
        )
    return out


def cookies_for_domain(cookies: list[dict], needle: str) -> list[dict]:
    needle_l = needle.lower().lstrip(".")
    matched: list[dict] = []
    for cookie in cookies:
        domain = str(cookie.get("domain") or "").lower().lstrip(".")
        if domain == needle_l or domain.endswith("." + needle_l) or needle_l in domain:
            matched.append(cookie)
    return matched or list(cookies)


def _sync_get_json(
    url: str,
    *,
    cookies: list[dict],
    headers: dict,
    params: dict | None = None,
    impersonate: str = "chrome124",
) -> dict | list:
    from curl_cffi import requests as cffi_requests

    session = cffi_requests.Session(impersonate=impersonate, timeout=25)
    try:
        session.headers.update({**BROWSER_HEADERS, **headers})
        for cookie in cookies:
            name = cookie.get("name")
            value = cookie.get("value")
            if not name or value is None:
                continue
            session.cookies.set(
                str(name),
                str(value),
                domain=str(cookie.get("domain") or "") or None,
                path=str(cookie.get("path") or "/"),
            )
        response = session.get(url, params=params)
        if response.status_code in (401, 403):
            raise SessionExpired(
                f"Session rejected ({response.status_code}). Sign in again and recapture cookies."
            )
        if response.status_code == 429:
            raise RateLimited(
                "The site is rate limiting requests (429).",
                retry_after_seconds=_retry_after(response.headers.get("retry-after")),
            )
        response.raise_for_status()
        return response.json()
    finally:
        session.close()


async def get_json_with_cookies(
    url: str,
    *,
    cookies: list[dict],
    headers: dict,
    params: dict | None = None,
    impersonate: str = "chrome124",
) -> dict | list:
    return await asyncio.to_thread(
        _sync_get_json,
        url,
        cookies=cookies,
        headers=headers,
        params=params,
        impersonate=impersonate,
    )
