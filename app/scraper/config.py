"""Scraper configuration bridge.

Reads all settings from the main app config (app.core.config) so the
scraper module shares the same .env file and DATABASE_URL as the rest
of the application.
"""

import os
from pathlib import Path
from pydantic_settings import BaseSettings

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"


class ScraperSettings(BaseSettings):
    DATABASE_URL: str = ""
    PROXY_LIST_PATH: str = ""
    PLAYWRIGHT_DEBUG: bool = False

    ADZUNA_APP_ID: str = ""
    ADZUNA_APP_KEY: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


def _build_sync_database_url() -> str:
    """Convert the async DATABASE_URL to a sync one for Scrapy/SQLAlchemy sync engine."""
    try:
        from app.core.config import get_settings
        main_settings = get_settings()
        url = main_settings.database_url
    except Exception:
        url = os.environ.get("DATABASE_URL", "")

    if not url:
        return ""

    url = url.replace("postgresql+asyncpg://", "postgresql://")
    return url


def get_scraper_settings() -> ScraperSettings:
    sync_url = _build_sync_database_url()

    try:
        from app.core.config import get_settings
        main_settings = get_settings()
        return ScraperSettings(
            DATABASE_URL=sync_url,
            ADZUNA_APP_ID=getattr(main_settings, "adzuna_app_id", ""),
            ADZUNA_APP_KEY=getattr(main_settings, "adzuna_app_key", ""),
            PROXY_LIST_PATH=getattr(main_settings, "scraper_proxy_list_path", ""),
        )
    except Exception:
        s = ScraperSettings()
        if sync_url:
            s.DATABASE_URL = sync_url
        return s


settings = get_scraper_settings()

os.makedirs(DATA_DIR, exist_ok=True)
