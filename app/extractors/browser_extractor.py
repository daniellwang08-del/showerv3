import asyncio
import re
from playwright.async_api import async_playwright, Browser, Page, Playwright
from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.job_content_cleaner import plain_text_from_document_html
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.exceptions import BrowserError
from contextlib import asynccontextmanager
from typing import AsyncGenerator
import random

logger = get_logger(__name__)

_COOKIE_CLICK_SELECTORS: tuple[str, ...] = (
    "#hs-eu-confirmation-button",
    "button#hs-eu-confirmation-button",
    "#onetrust-accept-btn-handler",
    "button.onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    ".cc-compliance .cc-btn-accept-all",
    "button[data-cy='accept-cookies']",
    "[aria-label='Accept cookies']",
    "[aria-label='Accept all cookies']",
    "[aria-label='accept cookies']",
    "button[id*='accept-all']",
    "button[class*='accept-all']",
)

_COOKIE_BUTTON_NAMES: tuple[str, ...] = (
    "Accept all cookies",
    "Accept All Cookies",
    "Accept all",
    "I Accept",
    "Agree to all",
    "Allow all",
    "Got it",
    "OK for me",
)

_ATS_EMBED_HOST_MARKERS: tuple[str, ...] = (
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "myworkdayjobs.com",
    "smartrecruiters.com",
    "icims.com",
    "jobvite.com",
    "taleo.net",
    "ultipro.com",
    "bamboohr.com",
    "applytojob.com",
    "recruitee.com",
)


async def _dismiss_cookie_consent(page: Page) -> bool:
    for sel in _COOKIE_CLICK_SELECTORS:
        try:
            loc = page.locator(sel).first
            if await loc.count() == 0:
                continue
            await loc.click(timeout=2200)
            await asyncio.sleep(0.35)
            logger.debug("cookie_banner_click", selector=sel)
            return True
        except Exception:
            continue

    for name in _COOKIE_BUTTON_NAMES:
        try:
            btn = page.get_by_role("button", name=name)
            if await btn.count() == 0:
                continue
            await btn.first.click(timeout=1800)
            await asyncio.sleep(0.35)
            logger.debug("cookie_banner_click", button_name=name)
            return True
        except Exception:
            continue

    for phrase in ("Accept all cookies", "accept all cookies", "ACCEPT ALL COOKIES"):
        try:
            loc = page.get_by_text(phrase, exact=True)
            if await loc.count() == 0:
                continue
            await loc.first.click(timeout=2000)
            await asyncio.sleep(0.35)
            logger.debug("cookie_banner_click", text_match=phrase)
            return True
        except Exception:
            continue

    try:
        rx = re.compile(r"^accept(\s+all)?(\s+cookies)?$", re.I)
        btn = page.get_by_role("button", name=rx)
        if await btn.count() > 0:
            await btn.first.click(timeout=1800)
            await asyncio.sleep(0.35)
            logger.debug("cookie_banner_click", button_name="regex_accept")
            return True
    except Exception:
        pass

    return False


VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1366, "height": 768},
    {"width": 1536, "height": 864},
    {"width": 1440, "height": 900},
]

BLOCKED_RESOURCE_TYPES = frozenset({"image", "media", "font"})
BLOCKED_RESOURCE_TYPES_STRICT = frozenset({"image", "media", "font", "stylesheet"})

WTTJ_HOST_MARKER = "welcometothejungle.com"

BLOCKED_URLS = [
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.com",
    "doubleclick.net",
    "googlesyndication.com",
    "hotjar.com",
    "intercom.io",
]

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
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
    async def acquire_page(self, target_url: str = "") -> AsyncGenerator[Page, None]:
        if not self._initialized or not self._browser or not self._semaphore:
            raise BrowserError("Browser pool not initialized")

        async with self._semaphore:
            viewport = random.choice(VIEWPORTS)
            context = await self._browser.new_context(
                viewport=viewport,
                user_agent=random.choice(USER_AGENTS),
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
            await page.route("**/*", self._make_route_handler(target_url))

            try:
                yield page
            finally:
                await context.close()

    def _make_route_handler(self, target_url: str):
        block_stylesheets = WTTJ_HOST_MARKER not in (target_url or "").lower()

        async def route_handler(route):
            request = route.request
            blocked_types = BLOCKED_RESOURCE_TYPES_STRICT if block_stylesheets else BLOCKED_RESOURCE_TYPES
            if request.resource_type in blocked_types:
                await route.abort()
                return
            if any(blocked in request.url for blocked in BLOCKED_URLS):
                await route.abort()
                return
            await route.continue_()

        return route_handler

    async def _route_handler(self, route):
        request = route.request
        if request.resource_type in BLOCKED_RESOURCE_TYPES_STRICT:
            await route.abort()
            return
        if any(blocked in request.url for blocked in BLOCKED_URLS):
            await route.abort()
            return
        await route.continue_()

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
    return _browser_pool


class BrowserExtractor(BaseExtractor):
    """Render page via Playwright and extract full plain text content."""

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
            async with pool.acquire_page(url) as page:
                is_wttj = WTTJ_HOST_MARKER in (url or "").lower()
                wait_until = "networkidle" if is_wttj else "domcontentloaded"
                await page.goto(
                    url,
                    wait_until=wait_until,
                    timeout=self._settings.browser_timeout_ms,
                )

                await _dismiss_cookie_consent(page)
                await self._wait_for_content(page, is_wttj=is_wttj)

                if "apply.workable.com" in (url or "").lower():
                    await _dismiss_cookie_consent(page)
                    await asyncio.sleep(2.5)

                plain_text = await self._extract_all_frames_text(page)

                if not plain_text or len(plain_text) < 50:
                    return ExtractionResult(
                        success=False,
                        method=self.method,
                        error="Insufficient text content from browser render",
                    )

                logger.info(
                    "browser_extraction_success",
                    url=url,
                    content_length=len(plain_text),
                )

                return ExtractionResult(
                    success=True,
                    method=self.method,
                    raw_content=plain_text,
                    structured_data=None,
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

    async def _wait_for_content(self, page: Page, *, is_wttj: bool = False) -> None:
        await _dismiss_cookie_consent(page)

        content_selectors = [
            "[data-testid='job-page']",
            "[data-testid='job-description']",
            "[data-automation='jobDescription']",
            "[data-ui='job-description']",
            "[class*='job-description']",
            "[class*='JobDescription']",
            ".job-description",
            "section.job-description",
            "div.job-content",
            "iframe[src*='greenhouse.io']",
            "iframe[id*='grnhse']",
            "iframe[src*='lever.co']",
            "article",
            "main",
        ]

        for selector in content_selectors:
            try:
                await page.wait_for_selector(selector, timeout=4000, state="attached")
                break
            except Exception:
                continue

        try:
            await page.wait_for_load_state("networkidle", timeout=4000)
        except Exception:
            pass

        min_chars = 200
        stable_rounds_needed = 2
        sample_interval_s = 0.6
        max_wait_s = 12.0
        spa_max_wait_s = 25.0 if not is_wttj else 35.0

        observed_last = -1
        stable_rounds = 0
        elapsed = 0.0
        mid_cookie_dismiss = False
        spa_extended = False

        while elapsed < max_wait_s:
            try:
                text_len = await self._page_text_length(page)
            except Exception:
                text_len = 0

            if not mid_cookie_dismiss and elapsed >= 4.0 and text_len < min_chars:
                await _dismiss_cookie_consent(page)
                mid_cookie_dismiss = True

            if not spa_extended and elapsed >= 3.0 and text_len < min_chars:
                if await self._is_spa_loading(page):
                    max_wait_s = spa_max_wait_s
                    spa_extended = True
                    logger.info("spa_loading_detected", extending_wait_s=spa_max_wait_s)

            if text_len >= min_chars:
                if text_len == observed_last:
                    stable_rounds += 1
                else:
                    stable_rounds = 0
                if stable_rounds >= stable_rounds_needed:
                    if spa_extended:
                        logger.info("spa_content_loaded", elapsed_s=round(elapsed, 1), text_len=text_len)
                    return

            observed_last = text_len
            await asyncio.sleep(sample_interval_s)
            elapsed += sample_interval_s

    async def _page_text_length(self, page: Page) -> int:
        """Quick text length check across main page and ATS iframes."""
        best = 0
        try:
            for frame in page.frames:
                try:
                    fu = frame.url or ""
                    if not fu or fu.startswith("about:") or "chrome-extension:" in fu:
                        continue
                    length = await frame.evaluate("() => document.body?.innerText?.length || 0")
                    if length > best:
                        best = length
                except Exception:
                    continue
        except Exception:
            pass
        return best

    async def _is_spa_loading(self, page: Page) -> bool:
        """Detect SPA skeleton/loading state that signals content will render later."""
        try:
            return await page.evaluate("""() => {
                const text = (document.body?.innerText || '').trim().toLowerCase();
                if (text.length > 150) return false;
                const hasLoadingText = /\\bloading\\b|\\bplease wait\\b|\\binitializing\\b/.test(text);
                const hasIndicator = !!document.querySelector(
                    '[class*="spinner"], [class*="Spinner"],'
                    + '[class*="loading"], [class*="Loading"],'
                    + '[class*="skeleton"], [class*="Skeleton"],'
                    + '[class*="shimmer"], [class*="Shimmer"],'
                    + '[role="progressbar"], .loader,'
                    + '[class*="loader"], [class*="Loader"]'
                );
                return hasLoadingText || hasIndicator;
            }""")
        except Exception:
            return False

    async def _extract_all_frames_text(self, page: Page) -> str:
        """
        Extract plain text from main page and all ATS-related child frames.

        Strategy:
        1. Collect text from the main page and from any non-application ATS
           iframes (real JD bodies).
        2. Collect text from ``/job_app`` iframes (Greenhouse application form
           shells) separately — these usually contain *only* the apply UI, but
           on careers pages that embed Greenhouse the JD itself is rendered
           inside the same iframe.
        3. Prefer non-application text.  Fall back to job_app text only when
           the main-page candidates are too thin to be a real JD.
        """
        primary: list[str] = []
        job_app_fallback: list[str] = []

        main_html = await page.content()
        main_text = plain_text_from_document_html(main_html)
        if main_text:
            primary.append(main_text)

        try:
            for frame in page.frames:
                if frame == page.main_frame:
                    continue
                try:
                    fu = frame.url or ""
                    if not fu or fu.startswith("about:") or "chrome-extension:" in fu:
                        continue
                    flow = fu.lower()
                    is_ats = any(m in flow for m in _ATS_EMBED_HOST_MARKERS)
                    if not is_ats:
                        continue
                    fh = await frame.content()
                    frame_text = plain_text_from_document_html(fh)
                    if not frame_text or len(frame_text) < 50:
                        continue
                    if "job_app" in flow or "/embed/job_app" in flow:
                        job_app_fallback.append(frame_text)
                    else:
                        primary.append(frame_text)
                except Exception as e:
                    logger.debug("browser_iframe_text_skip", error=str(e))
                    continue
        except Exception:
            pass

        if primary:
            best_primary = max(primary, key=len)
            if len(best_primary) >= 400 or not job_app_fallback:
                return best_primary
            # Primary text is thin — see if the job_app iframe has richer content.
            best_fallback = max(job_app_fallback, key=len)
            return best_fallback if len(best_fallback) > len(best_primary) else best_primary

        if job_app_fallback:
            return max(job_app_fallback, key=len)

        return ""
