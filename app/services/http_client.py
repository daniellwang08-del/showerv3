import httpx
import asyncio
import random
import time
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.exceptions import NetworkError
from contextlib import asynccontextmanager
from typing import AsyncGenerator

logger = get_logger(__name__)

try:
    from curl_cffi.requests import AsyncSession as _CurlAsyncSession
    _CURL_CFFI_AVAILABLE = True
except ImportError:
    _CurlAsyncSession = None  # type: ignore
    _CURL_CFFI_AVAILABLE = False
    logger.warning("curl_cffi_not_available", reason="ImportError - impersonation fallback disabled")

try:
    import brotli  # noqa: F401
    _ACCEPT_ENCODING = "gzip, deflate, br"
except ImportError:
    _ACCEPT_ENCODING = "gzip, deflate"

class _TokenBucket:
    """Simple async token-bucket rate limiter.

    Only sleeps when the rate limit is actually being exceeded, unlike
    unconditional asyncio.sleep() on every request.
    """

    def __init__(self, rate: float, burst: int = 1) -> None:
        self._rate = rate
        self._burst = burst
        self._tokens = float(burst)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last
            self._tokens = min(self._burst, self._tokens + elapsed * self._rate)
            self._last = now

            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return

            wait = (1.0 - self._tokens) / self._rate
            self._tokens = 0.0
            self._last = now + wait
        await asyncio.sleep(wait)


_rate_limiter: _TokenBucket | None = None


def _get_rate_limiter() -> _TokenBucket:
    global _rate_limiter
    if _rate_limiter is None:
        settings = get_settings()
        _rate_limiter = _TokenBucket(
            rate=settings.rate_limit_requests_per_second,
            burst=max(1, settings.max_concurrent_requests),
        )
    return _rate_limiter


USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
]

def is_waf_challenge_response(
    status_code: int,
    headers: dict[str, str] | dict,
    body: str = "",
) -> bool:
    """Detect AWS WAF / CloudFront bot-challenge pages (not real job content)."""
    normalized = {str(k).lower(): str(v).lower() for k, v in (headers or {}).items()}
    if normalized.get("x-amzn-waf-action") == "challenge":
        return True
    if status_code == 202 and normalized.get("server") == "cloudfront":
        return True
    sample = (body or "")[:4000].lower()
    if "x-amzn-waf-action" in sample or "awswafintegration" in sample:
        return True
    if status_code == 202 and ("challenge" in sample or "javascript is disabled" in sample):
        return True
    return False


ACCEPT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": _ACCEPT_ENCODING,
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

_client: httpx.AsyncClient | None = None
_semaphore: asyncio.Semaphore | None = None


async def init_http_client() -> None:
    global _client, _semaphore
    settings = get_settings()

    _semaphore = asyncio.Semaphore(settings.rate_limit_burst)

    _client = httpx.AsyncClient(
        timeout=httpx.Timeout(settings.http_timeout_seconds),
        follow_redirects=True,
        max_redirects=10,
        http2=True,
        limits=httpx.Limits(
            max_keepalive_connections=20,
            max_connections=100,
            keepalive_expiry=30,
        ),
    )
    logger.info("http_client_initialized", timeout=settings.http_timeout_seconds, rate_limit_burst=settings.rate_limit_burst)


async def close_http_client() -> None:
    global _client
    if _client:
        await _client.aclose()
        _client = None
    logger.info("http_client_closed")


def get_random_headers() -> dict[str, str]:
    headers = ACCEPT_HEADERS.copy()
    headers["User-Agent"] = random.choice(USER_AGENTS)
    return headers


def get_json_headers() -> dict[str, str]:
    """Headers for JSON API requests (e.g. Ashby, vendor APIs)."""
    headers = {
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": _ACCEPT_ENCODING,
        "User-Agent": random.choice(USER_AGENTS),
    }
    return headers


class HTTPService:
    def __init__(self):
        self._settings = get_settings()

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.NetworkError)),
        reraise=True,
    )
    async def fetch(self, url: str) -> tuple[str, int, dict[str, str]]:
        """Fetch URL with httpx. On 401/403, transparently retries with
        curl_cffi Chrome TLS impersonation, which bypasses most bot detection
        used by Lever, Workday, careers.* and similar ATS sites.
        """
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await _get_rate_limiter().acquire()

            try:
                headers = get_random_headers()
                response = await _client.get(url, headers=headers)

                logger.info(
                    "http_fetch",
                    url=url,
                    status_code=response.status_code,
                    content_length=len(response.content),
                )

                if response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", 60))
                    logger.warning("http_fetch_rate_limited", url=url, retry_after=retry_after)
                    await asyncio.sleep(retry_after)
                    raise httpx.NetworkError("Rate limited")

                if response.status_code in (401, 403) and _CURL_CFFI_AVAILABLE:
                    logger.info(
                        "http_fetch_blocked_retrying_impersonate",
                        url=url, status_code=response.status_code,
                    )
                    impersonate_result = await self._fetch_with_impersonation(url)
                    if impersonate_result is not None:
                        return impersonate_result

                if is_waf_challenge_response(
                    response.status_code,
                    dict(response.headers),
                    response.text,
                ):
                    logger.warning(
                        "http_fetch_waf_challenge",
                        url=url,
                        status_code=response.status_code,
                        waf_action=response.headers.get("x-amzn-waf-action"),
                    )
                    raise NetworkError(
                        "Bot protection challenge (AWS WAF)",
                        {"url": url, "status_code": response.status_code},
                    )

                response.raise_for_status()
                return response.text, response.status_code, dict(response.headers)

            except httpx.HTTPStatusError as e:
                if e.response.status_code in (401, 403) and _CURL_CFFI_AVAILABLE:
                    logger.info(
                        "http_fetch_status_error_retrying_impersonate",
                        url=url, status_code=e.response.status_code,
                    )
                    impersonate_result = await self._fetch_with_impersonation(url)
                    if impersonate_result is not None:
                        return impersonate_result
                logger.warning("http_fetch_status_error", url=url, status_code=e.response.status_code)
                raise NetworkError(
                    f"HTTP error {e.response.status_code}",
                    {"url": url, "status_code": e.response.status_code},
                )
            except httpx.TimeoutException:
                logger.warning("http_fetch_timeout", url=url)
                raise
            except httpx.NetworkError as e:
                logger.warning("http_fetch_network_error", url=url, error=str(e))
                raise

    async def _fetch_with_impersonation(self, url: str) -> tuple[str, int, dict[str, str]] | None:
        """Fetch using curl_cffi with Chrome TLS fingerprint to bypass bot detection.
        Returns None on failure so callers can decide whether to raise the
        original httpx error.
        """
        if not _CURL_CFFI_AVAILABLE or _CurlAsyncSession is None:
            return None
        try:
            timeout = self._settings.http_timeout_seconds
            async with _CurlAsyncSession(
                impersonate="chrome",
                timeout=timeout,
            ) as session:
                headers = {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Sec-Fetch-Dest": "document",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "none",
                    "Sec-Fetch-User": "?1",
                    "Upgrade-Insecure-Requests": "1",
                }
                resp = await session.get(url, headers=headers, allow_redirects=True)
                logger.info(
                    "http_fetch_impersonate",
                    url=url,
                    status_code=resp.status_code,
                    content_length=len(resp.content or b""),
                )
                if is_waf_challenge_response(
                    resp.status_code,
                    dict(resp.headers),
                    resp.text or "",
                ):
                    logger.warning(
                        "http_fetch_impersonate_waf_challenge",
                        url=url,
                        status_code=resp.status_code,
                    )
                    return None
                if resp.status_code >= 400:
                    # Log the specific block reason so operators can see which
                    # sites consistently reject curl_cffi impersonation and can
                    # decide whether to add them to the aggregator-domain list.
                    logger.warning(
                        "http_fetch_impersonate_blocked",
                        url=url,
                        status_code=resp.status_code,
                        body_preview=(resp.text or "")[:200],
                    )
                    return None
                return resp.text, resp.status_code, dict(resp.headers)
        except Exception as e:
            logger.warning("http_fetch_impersonate_failed", url=url, error=str(e))
            return None

    async def resolve_redirect(self, url: str, timeout: float = 10.0) -> str | None:
        """Follow all HTTP redirects and return the final destination URL.

        Designed for affiliate/tracking URLs (e.g. Adzuna ``/land/ad/``
        click-tracking pages) that perform a server-side 302 redirect to the
        real employer job page.  Uses curl_cffi Chrome impersonation first so
        the request looks like a real browser click; falls back to plain httpx
        if curl_cffi is unavailable.

        Returns the final URL string on success, or None if the request was
        blocked (4xx / 5xx) or failed with a network error.  A short timeout
        is used intentionally — we want a fast yes/no answer, not a 30-second
        hang waiting for Cloudflare challenges.
        """
        if _CURL_CFFI_AVAILABLE and _CurlAsyncSession is not None:
            try:
                async with _CurlAsyncSession(impersonate="chrome", timeout=timeout) as session:
                    headers = {
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate",
                        "Sec-Fetch-Site": "none",
                        "Sec-Fetch-User": "?1",
                        "Upgrade-Insecure-Requests": "1",
                        "Referer": "https://www.adzuna.com/",
                    }
                    resp = await session.get(url, headers=headers, allow_redirects=True)
                    if resp.status_code < 400:
                        final = str(resp.url)
                        logger.info(
                            "resolve_redirect_success",
                            url=url,
                            final_url=final,
                            status_code=resp.status_code,
                            via="curl_cffi",
                        )
                        return final
                    logger.warning(
                        "resolve_redirect_blocked",
                        url=url,
                        status_code=resp.status_code,
                        via="curl_cffi",
                    )
                    return None
            except Exception as e:
                logger.warning("resolve_redirect_curl_cffi_failed", url=url, error=str(e))

        # curl_cffi unavailable or failed — try plain httpx as last resort
        if _client is not None:
            try:
                resp = await _client.get(url, headers=get_random_headers(), timeout=timeout)
                if resp.status_code < 400:
                    final = str(resp.url)
                    logger.info(
                        "resolve_redirect_success",
                        url=url,
                        final_url=final,
                        status_code=resp.status_code,
                        via="httpx",
                    )
                    return final
                logger.warning(
                    "resolve_redirect_blocked",
                    url=url,
                    status_code=resp.status_code,
                    via="httpx",
                )
            except Exception as e:
                logger.warning("resolve_redirect_httpx_failed", url=url, error=str(e))

        return None

    async def fetch_impersonated(self, url: str) -> tuple[str, int, dict[str, str]]:
        """Direct curl_cffi fetch (Chrome impersonation). Use for ATS APIs/sites
        known to block plain httpx (Lever, Workday, careers.*).
        Raises NetworkError on failure.
        """
        result = await self._fetch_with_impersonation(url)
        if result is None:
            raise NetworkError(
                "curl_cffi impersonation fetch failed",
                {"url": url},
            )
        return result

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.NetworkError)),
        reraise=True,
    )
    async def post_json(
        self,
        url: str,
        *,
        body: dict,
        headers: dict[str, str] | None = None,
    ) -> tuple[str, int, dict[str, str]]:
        """POST JSON body and return (text, status_code, headers)."""
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await _get_rate_limiter().acquire()
            req_headers = headers or get_json_headers()
            response = await _client.post(url, json=body, headers=req_headers)
            logger.info(
                "http_post_json",
                url=url,
                status_code=response.status_code,
                content_length=len(response.content),
            )
            return response.text, response.status_code, dict(response.headers)

    async def fetch_json(self, url: str) -> tuple[str, int, dict[str, str]]:
        """Fetch URL with Accept: application/json for API endpoints."""
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await _get_rate_limiter().acquire()

            try:
                headers = get_json_headers()
                response = await _client.get(url, headers=headers)

                logger.info(
                    "http_fetch_json",
                    url=url,
                    status_code=response.status_code,
                    content_length=len(response.content),
                )

                if response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", 60))
                    logger.warning("http_fetch_rate_limited", url=url, retry_after=retry_after)
                    await asyncio.sleep(retry_after)
                    raise httpx.NetworkError("Rate limited")

                response.raise_for_status()
                return response.text, response.status_code, dict(response.headers)

            except httpx.HTTPStatusError as e:
                logger.warning("http_fetch_status_error", url=url, status_code=e.response.status_code)
                raise NetworkError(
                    f"HTTP error {e.response.status_code}",
                    {"url": url, "status_code": e.response.status_code},
                )
            except httpx.TimeoutException:
                logger.warning("http_fetch_timeout", url=url)
                raise
            except httpx.NetworkError as e:
                logger.warning("http_fetch_network_error", url=url, error=str(e))
                raise

    async def fetch_with_redirect_chain(self, url: str) -> tuple[str, str, int]:
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await _get_rate_limiter().acquire()

            headers = get_random_headers()
            response = await _client.get(url, headers=headers)
            response.raise_for_status()
            final_url = str(response.url)
            return response.text, final_url, response.status_code
