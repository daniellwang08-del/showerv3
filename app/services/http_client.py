import httpx
import asyncio
import random
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.exceptions import NetworkError
from contextlib import asynccontextmanager
from typing import AsyncGenerator

logger = get_logger(__name__)

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

ACCEPT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
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
        "Accept-Encoding": "gzip, deflate, br",
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
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await asyncio.sleep(1 / self._settings.rate_limit_requests_per_second)

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
                raise NetworkError("Request timeout", {"url": url})
            except httpx.NetworkError as e:
                logger.warning("http_fetch_network_error", url=url, error=str(e))
                raise NetworkError(str(e), {"url": url})

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.NetworkError)),
        reraise=True,
    )
    async def fetch_json(self, url: str) -> tuple[str, int, dict[str, str]]:
        """Fetch URL with Accept: application/json for API endpoints."""
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await asyncio.sleep(1 / self._settings.rate_limit_requests_per_second)

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
                raise NetworkError("Request timeout", {"url": url})
            except httpx.NetworkError as e:
                logger.warning("http_fetch_network_error", url=url, error=str(e))
                raise NetworkError(str(e), {"url": url})

    async def fetch_with_redirect_chain(self, url: str) -> tuple[str, str, int]:
        if not _client or not _semaphore:
            raise NetworkError("HTTP client not initialized")

        async with _semaphore:
            await asyncio.sleep(1 / self._settings.rate_limit_requests_per_second)

            headers = get_random_headers()
            response = await _client.get(url, headers=headers)
            response.raise_for_status()
            final_url = str(response.url)
            return response.text, final_url, response.status_code
