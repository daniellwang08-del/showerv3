"""Public HTML pages for boards without an API, fetched as Chrome (curl_cffi)."""

from __future__ import annotations

import asyncio
import re
from html import unescape

from app.job_sites.errors import RateLimited

_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_BLOCK_TAGS = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6]|/tr|/section|/ul|/ol)\b[^>]*>", re.IGNORECASE)
_LIST_ITEM = re.compile(r"<\s*li\b[^>]*>", re.IGNORECASE)
_TAGS = re.compile(r"<[^>]+>")
_SCRIPTS = re.compile(r"<(script|style)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL)


def html_to_text(html: str) -> str:
    """Readable plain text from an HTML fragment, keeping paragraph and list breaks."""
    text = _SCRIPTS.sub(" ", html or "")
    text = _LIST_ITEM.sub("\n- ", text)
    text = _BLOCK_TAGS.sub("\n", text)
    text = unescape(_TAGS.sub(" ", text))
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.splitlines()]
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


def _sync_get(url: str, params: dict | None, session) -> str:
    response = session.get(url, params=params)
    if response.status_code in (403, 429):
        raise RateLimited(
            f"The site turned the request away ({response.status_code}). We will try again later.",
            retry_after_seconds=3 * 3600,
        )
    response.raise_for_status()
    return response.text


class HtmlSession:
    """One browser-like session reused across a board's listing and detail pages."""

    def __init__(self, *, impersonate: str = "chrome124", timeout: float = 25.0):
        from curl_cffi import requests as cffi_requests

        self._session = cffi_requests.Session(impersonate=impersonate, timeout=timeout)
        self._session.headers.update(_HEADERS)

    async def get(self, url: str, params: dict | None = None) -> str:
        return await asyncio.to_thread(_sync_get, url, params, self._session)

    def close(self) -> None:
        self._session.close()

    async def __aenter__(self) -> "HtmlSession":
        return self

    async def __aexit__(self, *_exc) -> None:
        self.close()
