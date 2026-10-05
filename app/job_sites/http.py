"""Shared HTTP helpers for job-site plugins."""

from __future__ import annotations

from typing import Any

import httpx

_TIMEOUT = httpx.Timeout(25.0)
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; NAO/1.0; +https://nao.it.com)"
    ),
    "Accept": "application/json",
}


async def get_json(
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    auth: tuple[str, str] | None = None,
) -> Any:
    merged = {**_HEADERS, **(headers or {})}
    async with httpx.AsyncClient(
        timeout=_TIMEOUT, headers=merged, follow_redirects=True
    ) as client:
        response = await client.get(url, params=params, auth=auth)
        response.raise_for_status()
        return response.json()


async def post_json(
    url: str,
    *,
    json_body: dict | None = None,
    headers: dict | None = None,
) -> Any:
    merged = {**_HEADERS, **(headers or {})}
    async with httpx.AsyncClient(
        timeout=_TIMEOUT, headers=merged, follow_redirects=True
    ) as client:
        response = await client.post(url, json=json_body or {})
        response.raise_for_status()
        return response.json()
