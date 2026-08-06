"""Authenticated HTTP session for RemoteRocketship.

Fetches via curl_cffi with pinned Chrome TLS fingerprints and residential
proxies resolved via ``app.scraper.utils.proxies`` (``SCRAPER_PROXY_*`` /
``SCRAPER_PROXY_LIST_PATH`` / ``PROXY_URL``).

Evidence (2026-08-03):
  - Floating ``impersonate="chrome"`` → chrome146 → Cloudflare 403 challenge.
  - Direct home IP can burn such that every fingerprint gets CF 403.
  - Residential proxy ``151.247.185.166`` + ``chrome123`` returned HTTP 200
    with jobs while ``chrome124`` on the same proxy still got CF 403.
  - Headless Playwright does not clear remoterocketship managed challenges.
  - Scrapy must not TLS-handshake remoterocketship.com (handled in the spider).
"""

from __future__ import annotations

import logging
import random
import time
from typing import Optional

from curl_cffi import requests as cffi_requests

from app.scraper.auth import load_session
from app.scraper.utils.proxies import (
    _load_proxies_from_file as _load_proxies,
    _parse_proxy_line,
    proxy_egress_label,
    resolve_scraper_proxies_from_settings,
)

logger = logging.getLogger(__name__)

# Prefer fingerprints proven to pass remoterocketship CF via residential proxy.
# Never use the floating alias "chrome" (maps to chrome146 → blocked).
IMPERSONATE_CANDIDATES = ("chrome123", "chrome124", "chrome116", "chrome110")
# Back-compat alias used by tests / logs.
IMPERSONATE = IMPERSONATE_CANDIDATES[0]

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
    """HTTP session for RRS: proxy + rotating Chrome TLS fingerprints.

    Complete reliability against remoterocketship Cloudflare requires:
      1. Residential proxies via ``SCRAPER_PROXY_*`` / list file / ``PROXY_URL``
      2. Fingerprint rotation (chrome123/124/…) — CF blocks specific JA3s per IP
      3. Never using the floating ``chrome`` alias
    """

    def __init__(
        self,
        proxy_path: str = "",
        timeout: int = 25,
        proxies: list[str] | None = None,
    ):
        self.timeout = timeout
        explicit = [p for p in (proxies or []) if p]
        from_file = _load_proxies(proxy_path) if proxy_path else []
        resolved = explicit or from_file or resolve_scraper_proxies_from_settings()
        # Preserve order, drop empties / dupes.
        seen: set[str] = set()
        self.proxies_list: list[str] = []
        for url in resolved:
            if url and url not in seen:
                seen.add(url)
                self.proxies_list.append(url)

        self._proxy_index = 0
        self._current_proxy: Optional[str] = None
        self._impersonate_index = 0
        self._impersonate: str = IMPERSONATE_CANDIDATES[0]
        self._cf_hits_on_fingerprint = 0
        self._session: Optional[cffi_requests.Session] = None
        self._authenticated = False
        self.last_status_code: Optional[int] = None
        self.last_failure_reason: Optional[str] = None
        self._cookies: list[dict] = []
        if self.proxies_list:
            self._current_proxy = self.proxies_list[0]
            logger.info(
                "RRS CloudflareSession loaded %d residential prox%s (egress=%s)",
                len(self.proxies_list),
                "y" if len(self.proxies_list) == 1 else "ies",
                proxy_egress_label(self._current_proxy),
            )
        else:
            logger.error(
                "RRS CloudflareSession has no residential proxies configured. "
                "Set SCRAPER_PROXY_URL=http://user:pass@host:port "
                "or SCRAPER_PROXY_LIST_PATH=/path/to/proxies.txt "
                "(or PROXY_ENABLED=true + PROXY_URL). "
                "Without this, Cloudflare will block the VPS IP."
            )
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

    def _proxy_dict(self) -> dict:
        if not self._current_proxy:
            return {}
        return {"http": self._current_proxy, "https": self._current_proxy}

    def _rotate_proxy(self) -> None:
        if not self.proxies_list:
            return
        self._proxy_index = (self._proxy_index + 1) % len(self.proxies_list)
        self._current_proxy = self.proxies_list[self._proxy_index]
        logger.info(
            "Rotated RRS proxy egress → %s",
            proxy_egress_label(self._current_proxy),
        )

    def _rotate_impersonate(self) -> str:
        self._impersonate_index = (self._impersonate_index + 1) % len(IMPERSONATE_CANDIDATES)
        nxt = IMPERSONATE_CANDIDATES[self._impersonate_index]
        logger.info("Rotating TLS impersonation → %s", nxt)
        self._create_session(nxt)
        return nxt

    def fetch(self, url: str, max_retries: int | None = None) -> Optional[str]:
        """Fetch via proxy + fingerprint rotation until success or exhausted.

        Returns the body on success, None on failure.
        On failure, ``last_failure_reason`` and ``last_status_code`` are set.
        """
        self.last_status_code = None
        self.last_failure_reason = None

        # Each candidate fingerprint once, then one cool-down pass if no proxies.
        attempts = max_retries
        if attempts is None:
            attempts = len(IMPERSONATE_CANDIDATES) * max(1, len(self.proxies_list) or 1)
            attempts = min(max(attempts, 4), 12)

        for attempt in range(attempts):
            try:
                html = self._try_curl_cffi(url)
                if html is not None:
                    self.last_failure_reason = None
                    self._cf_hits_on_fingerprint = 0
                    return html

                reason = self.last_failure_reason
                if reason == "auth_expired":
                    return None

                if reason == "cloudflare_blocked":
                    self._cf_hits_on_fingerprint += 1
                    # With a proxy pool, rotate egress immediately — CF burns per IP.
                    if self.proxies_list and len(self.proxies_list) > 1:
                        self._rotate_proxy()
                        self._create_session(self._impersonate)
                    # Evidence: after a cool-down, retrying the SAME fingerprint
                    # (chrome123) succeeded; rotating before the wait burned attempts
                    # on chrome124 which still failed on this proxy.
                    elif self._cf_hits_on_fingerprint >= 2:
                        self._rotate_impersonate()
                        self._cf_hits_on_fingerprint = 0

                    if self.proxies_list:
                        delay = 2.0 + random.uniform(0, 2.0)
                    else:
                        # No proxy: CF burns the VPS IP if we hammer it. Keep cool-down
                        # short enough that systemd TimeoutStopSec can still exit.
                        delay = 12.0 + random.uniform(0, 6.0)
                    logger.warning(
                        "Cloudflare challenge — retry %d/%d in %.0fs "
                        "(impersonate=%s, proxy=%s)",
                        attempt + 1,
                        attempts,
                        delay,
                        self._impersonate,
                        proxy_egress_label(self._current_proxy),
                    )
                    time.sleep(delay)
                    continue

                delay = (2 ** min(attempt, 3)) + random.uniform(0, 1)
                logger.warning(
                    "Retry %d/%d for %s in %.1fs (reason=%s)",
                    attempt + 1,
                    attempts,
                    url,
                    delay,
                    reason,
                )
                time.sleep(delay)

            except Exception as e:
                self.last_failure_reason = "fetch_failed"
                logger.error("Fetch error on attempt %d for %s: %s", attempt + 1, url, e)
                delay = (2 ** min(attempt, 3)) + random.uniform(0, 1)
                time.sleep(delay)

        if not self.last_failure_reason:
            self.last_failure_reason = "fetch_failed"
        logger.error(
            "Fetch failed for %s (reason=%s, status=%s, impersonate=%s, proxy=%s)",
            url,
            self.last_failure_reason,
            self.last_status_code,
            self._impersonate,
            proxy_egress_label(self._current_proxy),
        )
        return None

    def _try_curl_cffi(self, url: str) -> Optional[str]:
        try:
            proxy_dict = self._proxy_dict()
            resp = self._session.get(url, proxies=proxy_dict or None)
            self.last_status_code = resp.status_code
            body = resp.text or ""
            logger.info(
                "curl_cffi[%s] %s → %d (%d bytes)%s",
                self._impersonate,
                url[:80],
                resp.status_code,
                len(resp.content),
                f" via {proxy_egress_label(self._current_proxy)}" if proxy_dict else "",
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
            # Proxy connection failures should rotate too.
            if self.proxies_list and len(self.proxies_list) > 1:
                self._rotate_proxy()
                self._create_session(self._impersonate)
            return None

    def close(self):
        if self._session:
            self._session.close()
            self._session = None
