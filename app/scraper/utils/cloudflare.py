"""Authenticated HTTP session for RemoteRocketship.

Uses cookies saved during one-time browser setup (app.scraper.auth) and
injects them into a curl_cffi session with Chrome TLS impersonation
for fast, undetectable page fetching.

No credentials are stored. The auth module handles login; this module
only consumes the saved session cookies.
"""

import logging
import random
import time
from pathlib import Path
from typing import Optional

from curl_cffi import requests as cffi_requests

from app.scraper.auth import load_session

logger = logging.getLogger(__name__)

BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "DNT": "1",
}


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


class CloudflareSession:
    """Authenticated HTTP session that loads saved cookies from disk.

    Cookies are saved by `python -m app.scraper.auth setup` (one-time headed
    browser login). This class loads them and injects into curl_cffi for
    all page fetches.
    """

    def __init__(self, proxy_path: str = "", timeout: int = 20):
        self.timeout = timeout
        self.proxies_list = _load_proxies(proxy_path)
        self._session: Optional[cffi_requests.Session] = None
        self._authenticated = False
        self._create_session()
        self._load_saved_session()

    def _create_session(self):
        self._session = cffi_requests.Session(
            impersonate="chrome",
            timeout=self.timeout,
        )
        self._session.headers.update(BROWSER_HEADERS)

    def _load_saved_session(self):
        """Load cookies from the session file saved during auth setup."""
        cookies = load_session()
        if not cookies:
            logger.warning(
                "No saved session found. Run: python -m app.scraper.auth setup"
            )
            return

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

        if injected > 0:
            self._authenticated = True
            logger.info("Loaded %d cookies from saved session", injected)
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

    def fetch(self, url: str, max_retries: int = 3) -> Optional[str]:
        """Fetch a URL using the authenticated curl_cffi session.

        Returns the HTML body on success, None on failure.
        """
        for attempt in range(max_retries):
            try:
                html = self._try_curl_cffi(url)
                if html:
                    return html

                delay = (2 ** attempt) + random.uniform(0, 1)
                logger.warning("Retry %d/%d for %s in %.1fs", attempt + 1, max_retries, url, delay)
                time.sleep(delay)

            except Exception as e:
                logger.error("Fetch error on attempt %d for %s: %s", attempt + 1, url, e)
                delay = (2 ** attempt) + random.uniform(0, 1)
                time.sleep(delay)

        logger.error("All %d attempts failed for %s", max_retries, url)
        return None

    def _try_curl_cffi(self, url: str) -> Optional[str]:
        try:
            proxy_dict = self._get_proxy_dict()
            resp = self._session.get(url, proxies=proxy_dict)
            logger.info("curl_cffi %s → %d (%d bytes)", url[:80], resp.status_code, len(resp.content))

            if resp.status_code == 429:
                logger.warning("Rate limited (429) on %s", url)
                time.sleep(random.uniform(5, 15))
                return None

            if resp.status_code == 403:
                logger.warning(
                    "Got 403 from %s — session may have expired. "
                    "Re-run: python -m app.scraper.auth setup",
                    url,
                )
                return None

            resp.raise_for_status()
            return resp.text

        except Exception as e:
            logger.error("curl_cffi request failed for %s: %s", url, e)
            return None

    def close(self):
        if self._session:
            self._session.close()
