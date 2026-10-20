"""Public HTML pages for boards without an API, fetched as Chrome (curl_cffi)."""

from __future__ import annotations

import asyncio
import re
from html import unescape

from app.core.logging import get_logger
from app.job_sites.errors import RateLimited

logger = get_logger(__name__)

_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
# A bot check usually clears on a fresh session, often with a different browser fingerprint.
_FINGERPRINTS = ("chrome124", "chrome131", "safari17_0", "firefox133")
CHALLENGE_ATTEMPTS = 4
CHALLENGE_BACKOFF_SECONDS = (2.0, 4.0, 8.0)
CHALLENGE_RETRY_AFTER_SECONDS = 3600
_BLOCK_TAGS = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6]|/tr|/section|/ul|/ol)\b[^>]*>", re.IGNORECASE)
_LIST_ITEM = re.compile(r"<\s*li\b[^>]*>", re.IGNORECASE)
_TAGS = re.compile(r"<[^>]+>")
_SCRIPTS = re.compile(r"<(script|style)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL)


class BotChallenge(RateLimited):
    """The site served a human-verification page (AWS WAF CAPTCHA or challenge) instead of content."""


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


def is_bot_challenge(status_code: int, headers, text: str) -> bool:
    if headers.get("x-amzn-waf-action"):
        return True
    return status_code in (202, 405) and "Human Verification" in (text or "")[:4000]


def _sync_get(url: str, params: dict | None, session) -> str:
    response = session.get(url, params=params)
    if is_bot_challenge(response.status_code, response.headers, response.text):
        raise BotChallenge(
            "The site showed a bot check instead of results. We will try again later.",
            retry_after_seconds=CHALLENGE_RETRY_AFTER_SECONDS,
        )
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
        self._timeout = timeout
        self._fingerprints = [impersonate] + [f for f in _FINGERPRINTS if f != impersonate]
        self._fingerprint_index = 0
        self._session = self._new_session()

    def _new_session(self):
        from curl_cffi import requests as cffi_requests

        fingerprint = self._fingerprints[self._fingerprint_index % len(self._fingerprints)]
        session = cffi_requests.Session(impersonate=fingerprint, timeout=self._timeout)
        session.headers.update(_HEADERS)
        return session

    def _rotate(self) -> None:
        self._session.close()
        self._fingerprint_index += 1
        self._session = self._new_session()

    async def get(self, url: str, params: dict | None = None) -> str:
        for attempt in range(CHALLENGE_ATTEMPTS):
            try:
                return await asyncio.to_thread(_sync_get, url, params, self._session)
            except BotChallenge:
                if attempt == CHALLENGE_ATTEMPTS - 1:
                    logger.warning("html_fetch_bot_challenge_persisted", url=url.split("?")[0], attempts=CHALLENGE_ATTEMPTS)
                    raise
                logger.info("html_fetch_bot_challenge_retry", url=url.split("?")[0], attempt=attempt + 1)
                await asyncio.sleep(CHALLENGE_BACKOFF_SECONDS[min(attempt, len(CHALLENGE_BACKOFF_SECONDS) - 1)])
                self._rotate()
        raise AssertionError("unreachable")

    def close(self) -> None:
        self._session.close()

    async def __aenter__(self) -> "HtmlSession":
        return self

    async def __aexit__(self, *_exc) -> None:
        self.close()
