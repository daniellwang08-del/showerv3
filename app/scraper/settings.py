"""Scrapy settings for the integrated scraper module.

Reads DATABASE_URL from the shared app config so spiders write to the
same PostgreSQL instance as the rest of the application.
"""

import os
from pathlib import Path

BOT_NAME = "scraper"

SPIDER_MODULES = ["app.scraper.spiders"]
NEWSPIDER_MODULE = "app.scraper.spiders"

# --- Politeness -----------------------------------------------------------
ROBOTSTXT_OBEY = True
CONCURRENT_REQUESTS = 8
CONCURRENT_REQUESTS_PER_DOMAIN = 2
DOWNLOAD_DELAY = 1.5
RANDOMIZE_DOWNLOAD_DELAY = True

AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 2
AUTOTHROTTLE_MAX_DELAY = 30
AUTOTHROTTLE_TARGET_CONCURRENCY = 2.0

# --- Retry -----------------------------------------------------------------
RETRY_ENABLED = True
RETRY_TIMES = 3
RETRY_HTTP_CODES = [403, 429, 500, 502, 503, 504]

# --- Playwright (scrapy-playwright) ----------------------------------------
DOWNLOAD_HANDLERS = {
    "http": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
    "https": "scrapy_playwright.handler.ScrapyPlaywrightDownloadHandler",
}

PLAYWRIGHT_BROWSER_TYPE = "chromium"
PLAYWRIGHT_LAUNCH_OPTIONS = {
    "headless": True,
    "args": [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
    ],
}
PLAYWRIGHT_MAX_CONTEXTS = 3
PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT = 30_000

TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"

# --- Middlewares -----------------------------------------------------------
DOWNLOADER_MIDDLEWARES = {
    "app.scraper.middlewares.stealth.StealthMiddleware": 100,
    "app.scraper.middlewares.proxy.ProxyMiddleware": 200,
    "app.scraper.middlewares.retry_smart.SmartRetryMiddleware": 300,
    "scrapy.downloadermiddlewares.httpcompression.HttpCompressionMiddleware": 810,
}

# --- Pipelines -------------------------------------------------------------
ITEM_PIPELINES = {
    "app.scraper.pipelines.validation.ValidationPipeline": 100,
    "app.scraper.pipelines.cleaning.CleaningPipeline": 200,
    "app.scraper.pipelines.dedup.DedupPipeline": 300,
    "app.scraper.pipelines.posted_date_filter.PostedDateFilterPipeline": 350,
    "app.scraper.pipelines.postgres.PostgresPipeline": 400,
}

# --- Logging ---------------------------------------------------------------
LOG_LEVEL = "INFO"
LOG_FORMAT = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"

# --- Database (shared PostgreSQL from main app config) ---------------------
def _get_database_url() -> str:
    """Resolve DATABASE_URL: prefer env var, fall back to app config."""
    url = os.environ.get("DATABASE_URL", "")
    if url:
        return url.replace("postgresql+asyncpg://", "postgresql://")

    try:
        from app.core.config import get_settings
        return get_settings().database_url.replace("postgresql+asyncpg://", "postgresql://")
    except Exception:
        return ""


DATABASE_URL = _get_database_url()


def _get_proxy_list_path() -> str:
    """Resolve residential proxy list path for spiders (esp. RRS CloudflareSession)."""
    path = os.environ.get("SCRAPER_PROXY_LIST_PATH", "")
    if not path:
        try:
            from app.core.config import get_settings
            path = get_settings().scraper_proxy_list_path or ""
        except Exception:
            path = ""
    if not path:
        return ""
    p = Path(path)
    if not p.is_absolute():
        from app.scraper.config import PROJECT_ROOT
        p = PROJECT_ROOT / p
    return str(p) if p.exists() else str(p)


def _get_scraper_proxies() -> list[str]:
    """Inline + file proxies resolved at settings import (also re-resolved in session)."""
    try:
        from app.scraper.utils.proxies import resolve_scraper_proxies_from_settings
        return resolve_scraper_proxies_from_settings()
    except Exception:
        return []


# Imported by remoterocketship spider → CloudflareSession(proxy_path=..., proxies=...).
PROXY_LIST_PATH = _get_proxy_list_path()
SCRAPER_PROXIES = _get_scraper_proxies()

REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
