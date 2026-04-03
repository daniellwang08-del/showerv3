import asyncio
from playwright.async_api import async_playwright, Browser, Page, Playwright
from app.extractors.base import BaseExtractor, ExtractionResult
from app.extractors.html_extractor import HTMLExtractor
from app.models.schemas import ExtractionMethod
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.exceptions import BrowserError
from contextlib import asynccontextmanager
from typing import AsyncGenerator
import random

logger = get_logger(__name__)

VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1366, "height": 768},
    {"width": 1536, "height": 864},
    {"width": 1440, "height": 900},
]

BLOCKED_RESOURCE_TYPES = frozenset({"image", "media", "font", "stylesheet"})

BLOCKED_URLS = [
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.com",
    "doubleclick.net",
    "googlesyndication.com",
    "hotjar.com",
    "intercom.io",
]


class BrowserPool:
    def __init__(self):
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._semaphore: asyncio.Semaphore | None = None
        self._settings = get_settings()
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return

        try:
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=self._settings.browser_headless,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-gpu",
                    "--disable-software-rasterizer",
                ],
            )
            self._semaphore = asyncio.Semaphore(self._settings.browser_pool_size)
            self._initialized = True
            logger.info("browser_pool_initialized", pool_size=self._settings.browser_pool_size)
        except Exception as e:
            err_msg = str(e) or f"{type(e).__name__}"
            logger.warning("browser_pool_init_failed", error=err_msg)
            # Don't raise exception, allow app to run without browser
            self._initialized = False

    async def close(self) -> None:
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
        self._initialized = False
        logger.info("browser_pool_closed")

    @asynccontextmanager
    async def acquire_page(self) -> AsyncGenerator[Page, None]:
        if not self._initialized or not self._browser or not self._semaphore:
            raise BrowserError("Browser pool not initialized")

        async with self._semaphore:
            viewport = random.choice(VIEWPORTS)
            context = await self._browser.new_context(
                viewport=viewport,
                user_agent=self._get_random_user_agent(),
                locale="en-US",
                timezone_id="America/New_York",
                java_script_enabled=True,
            )

            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                window.chrome = {runtime: {}};
            """)

            page = await context.new_page()
            await page.route("**/*", self._route_handler)

            try:
                yield page
            finally:
                await context.close()

    async def _route_handler(self, route):
        request = route.request
        if request.resource_type in BLOCKED_RESOURCE_TYPES:
            await route.abort()
            return
        if any(blocked in request.url for blocked in BLOCKED_URLS):
            await route.abort()
            return
        await route.continue_()

    def _get_random_user_agent(self) -> str:
        agents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
        ]
        return random.choice(agents)

    @property
    def available_slots(self) -> int:
        if not self._semaphore:
            return 0
        return self._semaphore._value


_browser_pool: BrowserPool | None = None


async def init_browser_pool() -> None:
    global _browser_pool
    _browser_pool = BrowserPool()
    await _browser_pool.initialize()
    # When init fails or is skipped (e.g. Windows Python 3.13), pool is unusable.
    # Set to None so get_browser_pool() raises and can_extract() returns False.
    if not _browser_pool._initialized:
        _browser_pool = None


async def close_browser_pool() -> None:
    global _browser_pool
    if _browser_pool:
        await _browser_pool.close()
        _browser_pool = None


def get_browser_pool() -> BrowserPool:
    if not _browser_pool:
        raise BrowserError("Browser pool not initialized")
    return _browser_pool


def get_browser_pool_safe() -> BrowserPool | None:
    """Get browser pool safely, return None if not initialized"""
    return _browser_pool


class BrowserExtractor(BaseExtractor):
    def __init__(self):
        self._settings = get_settings()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.BROWSER_RENDER

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        try:
            get_browser_pool()
            return True
        except BrowserError:
            return False

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        try:
            pool = get_browser_pool()
        except BrowserError:
            logger.warning("browser_extraction_skipped", url=url, reason="Browser pool not available")
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Browser extraction not available on this platform",
            )

        try:
            async with pool.acquire_page() as page:
                await page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=self._settings.browser_timeout_ms,
                )

                await self._wait_for_content(page)
                content = await page.content()

                # Attempt structured extraction from rendered content, using existing HTML extractor logic.
                structured_data = None
                structured_confidence = 0.0
                try:
                    html_extractor = HTMLExtractor()
                    html_result = await html_extractor.extract(url, content)
                    if html_result.success and html_result.structured_data:
                        structured_data = html_result.structured_data
                        structured_confidence = html_result.confidence or 0.0
                        logger.info(
                            "browser_extraction_structured_success",
                            url=url,
                            extracted_fields=list(structured_data.keys()),
                            confidence=structured_confidence,
                        )
                    else:
                        logger.info(
                            "browser_extraction_structured_not_found",
                            url=url,
                            error=html_result.error,
                        )
                except Exception as e:
                    logger.warning("browser_extraction_structured_error", url=url, error=str(e))

                overall_confidence = max(0.7, structured_confidence) if structured_data else 0.7

                logger.info(
                    "browser_extraction_success",
                    url=url,
                    content_length=len(content),
                    has_structured=structured_data is not None,
                )

                return ExtractionResult(
                    success=True,
                    method=self.method,
                    raw_content=content,
                    structured_data=structured_data,
                    confidence=overall_confidence,
                )

        except asyncio.TimeoutError:
            logger.error("browser_extraction_timeout", url=url)
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Page load timeout",
            )
        except Exception as e:
            logger.error("browser_extraction_failed", url=url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=str(e),
            )

    async def _wait_for_content(self, page: Page) -> None:
        # Prefer actual job-body containers; do not gate readiness on title-only nodes like h1.
        content_selectors = [
            "[data-automation='jobDescription']",
            ".job-description",
            "section.job-description",
            "div.job-content",
            "article",
            "main",
        ]

        # 1) Wait for at least one likely content container.
        found_selector: str | None = None
        for selector in content_selectors:
            try:
                await page.wait_for_selector(selector, timeout=4000, state="attached")
                found_selector = selector
                break
            except Exception:
                continue

        # 2) Give SPA pages a chance to complete post-mount requests.
        try:
            await page.wait_for_load_state("networkidle", timeout=4000)
        except Exception:
            # Many pages keep analytics/websocket traffic open; best-effort only.
            pass

        # 3) Wait until text is substantial and stable to avoid early shell snapshots.
        # Confidence and downstream parsing quality depend on this page snapshot quality.
        min_chars = 700
        stable_rounds_needed = 2
        sample_interval_s = 0.6
        max_wait_s = 12.0

        observed_last = -1
        stable_rounds = 0
        elapsed = 0.0

        target_selector = found_selector or "main, article, [data-automation='jobDescription'], .job-description, body"
        while elapsed < max_wait_s:
            try:
                text_len = await page.evaluate(
                    """(sel) => {
                        const root = document.querySelector(sel) || document.body;
                        const txt = (root && root.innerText) ? root.innerText : '';
                        return txt.trim().length;
                    }""",
                    target_selector,
                )
            except Exception:
                text_len = 0

            if text_len >= min_chars:
                if text_len == observed_last:
                    stable_rounds += 1
                else:
                    stable_rounds = 0
                if stable_rounds >= stable_rounds_needed:
                    logger.debug(
                        "browser_content_ready_stable",
                        selector=target_selector,
                        text_len=text_len,
                    )
                    return
            observed_last = text_len
            await asyncio.sleep(sample_interval_s)
            elapsed += sample_interval_s

        logger.debug(
            "browser_content_ready_timeout_fallback",
            selector=target_selector,
            last_text_len=max(0, observed_last),
            waited_seconds=round(elapsed, 1),
        )
