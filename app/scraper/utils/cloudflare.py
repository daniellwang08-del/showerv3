"""Authenticated HTTP session for RemoteRocketship.

Uses cookies saved during one-time browser setup (app.scraper.auth) and
injects them into a curl_cffi session with Chrome TLS impersonation.

Evidence (2026-08-03):
  - Default ``impersonate="chrome"`` (and chrome131/chrome136) get a Cloudflare
    403 "Just a moment..." challenge on remoterocketship.com.
  - ``impersonate="chrome124"`` returns HTTP 200 for homepage + API.
  - Aggressive retry storms against CF burn the IP temporarily; keep retries
    few and spaced.
  - Scrapy's own TLS handshake to remoterocketship.com also triggers CF and
    must not precede curl_cffi fetches (handled in the spider).
"""

from __future__ import annotations

import logging
import random
import time
from pathlib import Path
from typing import Optional

from curl_cffi import requests as cffi_requests

from app.scraper.auth import load_session

logger = logging.getLogger(__name__)

# Only fingerprint proven to pass remoterocketship.com Cloudflare as of 2026-08-03.
IMPERSONATE_CANDIDATES = ("chrome124",)

BROWSER_HEADERS = {
    "Accept": "application/json, text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.remoterocketship.com/",
    "Origin": "https://www.remoterocketship.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "DNT": "1",
}

_CF_TEXT_HINTS = (
    "just a moment",
    "performing security verification",
    "checking your browser",
    "cf-turnstile",
    "verify you are human",
    "cdn-cgi/challenge",
    "challenges.cloudflare.com",
)


def _load_proxies(proxy_path: str) -> list[str]:
    if not proxy_path:
        return []
    p = Path(proxy_path)
    if not p.exists():
        return []
    lines = p.read_text().strip().splitlines()
    return [l.strip() for l in lines if l.strip() and not l.startswith("#")]


def _pick_proxy(proxies: list[str]) -> Optional[str]:
    if not proxies:
        return None
    proxy = random.choice(proxies)
    if not proxy.startswith("http"):
        proxy = f"http://{proxy}"
    return proxy


def is_cloudflare_challenge_response(
    status_code: int | None,
    body: str | None,
    headers: dict | None = None,
) -> bool:
    """Return True when the response is a Cloudflare browser challenge."""
    text = (body or "").lower()
    if text and any(h in text for h in _CF_TEXT_HINTS):
        return True
    if status_code == 403:
        server = ""
        if headers:
            server = str(headers.get("server") or headers.get("Server") or "").lower()
        if "cloudflare" in server:
            return True
        if text and ("cloudflare" in text or "<title>just a moment" in text):
            return True
    return False


class CloudflareSession:
    """HTTP session that loads saved cookies and fetches via curl_cffi.

    Cookies are saved by `python -m app.scraper.auth capture rrs`. Listing
    endpoints work without cookies once Cloudflare is bypassed; cookies are
    still injected when present.
    """

    def __init__(self, proxy_path: str = "", timeout: int = 20):
        self.timeout = timeout
        self.proxies_list = _load_proxies(proxy_path)
        self._session: Optional[cffi_requests.Session] = None
        self._impersonate: str = IMPERSONATE_CANDIDATES[0]
        self._authenticated = False
        self.last_status_code: Optional[int] = None
        self.last_failure_reason: Optional[str] = None
        self._cookies: list[dict] = []
        self._create_session(self._impersonate)
        self._load_saved_session()

    def _create_session(self, impersonate: str):
        if self._session is not None:
            try:
                self._session.close()
            except Exception:
                pass
        self._impersonate = impersonate
        self._session = cffi_requests.Session(
            impersonate=impersonate,
            timeout=self.timeout,
        )
        self._session.headers.update(BROWSER_HEADERS)
        self._inject_cookies(self._cookies)

    def _inject_cookies(self, cookies: list[dict]) -> int:
        if not self._session or not cookies:
            return 0
        injected = 0
        for cookie in cookies:
            name = cookie.get("name", "")
            value = cookie.get("value", "")
            if not name or not value:
                continue
            self._session.cookies.set(
                name,
                value,
                domain=cookie.get("domain", ""),
                path=cookie.get("path", "/"),
            )
            injected += 1
        return injected

    def _load_saved_session(self):
        """Load cookies from the session file saved during auth setup."""
        cookies = load_session("rrs") or []
        self._cookies = cookies
        if not cookies:
            logger.warning(
                "No saved RRS session found. Listing may still work without auth. "
                "To capture: python -m app.scraper.auth capture rrs"
            )
            return

        injected = self._inject_cookies(cookies)
        if injected > 0:
            self._authenticated = True
            logger.info(
                "Loaded %d cookies from saved session (impersonate=%s)",
                injected,
                self._impersonate,
            )
        else:
            logger.warning("Session file contained no valid cookies")

    @property
    def is_authenticated(self) -> bool:
        return self._authenticated

    def _get_proxy_dict(self) -> dict:
        proxy = _pick_proxy(self.proxies_list)
        if proxy:
            return {"http": proxy, "https": proxy}
        return {}

    def fetch(self, url: str, max_retries: int = 2) -> Optional[str]:
        """Fetch a URL using curl_cffi with chrome124 impersonation.

        Returns the body on success, None on failure.
        On failure, ``last_failure_reason`` and ``last_status_code`` are set.

        Do not pre-hit the homepage: a failed warm-up challenge burns the IP
        before the real API call. Cloudflare cool-downs after challenges are
        long (~1–2 minutes); retries use a matching backoff.
        """
        self.last_status_code = None
        self.last_failure_reason = None

        for attempt in range(max_retries):
            try:
                html = self._try_curl_cffi(url)
                if html is not None:
                    self.last_failure_reason = None
                    return html

                reason = self.last_failure_reason
                if reason == "auth_expired":
                    return None

                if reason == "cloudflare_blocked":
                    if attempt + 1 >= max_retries:
                        break
                    delay = 50.0 + random.uniform(0, 20.0)
                    logger.warning(
                        "Cloudflare challenge (impersonate=%s) — cool-down "
                        "retry %d/%d in %.0fs",
                        self._impersonate,
                        attempt + 1,
                        max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue

                delay = (2 ** attempt) + random.uniform(0, 1)
                logger.warning(
                    "Retry %d/%d for %s in %.1fs (reason=%s)",
                    attempt + 1,
                    max_retries,
                    url,
                    delay,
                    reason,
                )
                time.sleep(delay)

            except Exception as e:
                self.last_failure_reason = "fetch_failed"
                logger.error("Fetch error on attempt %d for %s: %s", attempt + 1, url, e)
                delay = (2 ** attempt) + random.uniform(0, 1)
                time.sleep(delay)

        if not self.last_failure_reason:
            self.last_failure_reason = "fetch_failed"
        logger.error(
            "Fetch failed for %s (reason=%s, status=%s, impersonate=%s)",
            url,
            self.last_failure_reason,
            self.last_status_code,
            self._impersonate,
        )
        return None

    def _try_curl_cffi(self, url: str) -> Optional[str]:
        try:
            proxy_dict = self._get_proxy_dict()
            resp = self._session.get(url, proxies=proxy_dict)
            self.last_status_code = resp.status_code
            body = resp.text or ""
            logger.info(
                "curl_cffi[%s] %s → %d (%d bytes)",
                self._impersonate,
                url[:80],
                resp.status_code,
                len(resp.content),
            )

            if is_cloudflare_challenge_response(
                resp.status_code, body, dict(resp.headers)
            ):
                self.last_failure_reason = "cloudflare_blocked"
                logger.warning(
                    "Cloudflare challenge on %s (status=%s, impersonate=%s)",
                    url[:80],
                    resp.status_code,
                    self._impersonate,
                )
                return None

            if resp.status_code == 429:
                self.last_failure_reason = "rate_limited"
                logger.warning("Rate limited (429) on %s", url)
                time.sleep(random.uniform(5, 15))
                return None

            if resp.status_code in (401, 403):
                self.last_failure_reason = "auth_expired"
                self._authenticated = False
                logger.warning(
                    "Got %s from %s - session may have expired. "
                    "Re-run: python -m app.scraper.auth capture rrs",
                    resp.status_code,
                    url[:80],
                )
                return None

            resp.raise_for_status()
            return body

        except Exception as e:
            self.last_failure_reason = "fetch_failed"
            logger.error("curl_cffi request failed for %s: %s", url, e)
            return None

    def close(self):
        if self._session:
            self._session.close()
            self._session = None
