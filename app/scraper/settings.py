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
    "app.scraper.pipelines.postgres.PostgresPipeline": 400,
}

# --- Feeds (JSON backup alongside DB) -------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
os.makedirs(_PROJECT_ROOT / "data", exist_ok=True)

FEEDS = {
    str(_PROJECT_ROOT / "data" / "%(name)s_%(time)s.jsonl"): {
        "format": "jsonlines",
        "encoding": "utf-8",
        "overwrite": False,
    },
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

REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
