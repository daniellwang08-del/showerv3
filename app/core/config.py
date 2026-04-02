from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from pydantic import field_validator
from functools import lru_cache
from typing import Literal
from pathlib import Path
import os

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

def _resolve_env_files() -> tuple[str, ...]:
    """Return env files to load in priority order (last wins in pydantic-settings).

    Resolution:
      1. Always load `.env` as the base (fallback defaults).
      2. If APP_ENV is set (e.g. "local", "production"), also load `.env.{APP_ENV}`
         which overrides values from `.env`.

    On Render / production the env vars are injected directly, so the files
    are optional — real env vars always take highest precedence.
    """
    env = os.environ.get("APP_ENV", "").strip().lower()
    base = _PROJECT_ROOT / ".env"
    files: list[str] = [str(base)]
    if env:
        overlay = _PROJECT_ROOT / f".env.{env}"
        if overlay.exists():
            files.append(str(overlay))
    return tuple(files)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_resolve_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = Field(default="local")

    app_name: str = "Job Description Scraper"
    app_version: str = "1.0.0"
    debug: bool = True
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    # When True, SQLAlchemy logs every SQL statement (very noisy). Not tied to `debug`.
    sqlalchemy_echo: bool = False

    database_url: str = Field(default="")
    database_pool_size: int = 20
    database_max_overflow: int = 10

    @field_validator("database_url")
    @classmethod
    def _validate_database_url(cls, v: str) -> str:
        if not v:
            raise ValueError("DATABASE_URL is required and must be PostgreSQL (postgresql+asyncpg://...)")

        # Render (and many PaaS) provide postgres:// — auto-convert to the
        # asyncpg dialect SQLAlchemy requires.
        if v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        elif v.startswith("postgresql://") and "+asyncpg" not in v:
            v = v.replace("postgresql://", "postgresql+asyncpg://", 1)

        # asyncpg does not recognise the standard libpq query params that
        # hosted providers like Neon append.  Rewrite them so the driver
        # connects correctly:
        #   sslmode=require  ->  ssl=require   (asyncpg's spelling)
        #   channel_binding=*  removed         (not supported by asyncpg)
        from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
        parsed = urlparse(v)
        if parsed.query:
            params = parse_qs(parsed.query, keep_blank_values=True)
            changed = False
            if "sslmode" in params and "ssl" not in params:
                params["ssl"] = params.pop("sslmode")
                changed = True
            elif "sslmode" in params:
                del params["sslmode"]
                changed = True
            if "channel_binding" in params:
                del params["channel_binding"]
                changed = True
            if changed:
                flat = {k: vs[0] for k, vs in params.items()}
                v = urlunparse(parsed._replace(query=urlencode(flat)))

        lower_v = v.lower()
        if not lower_v.startswith("postgresql"):
            raise ValueError("Only PostgreSQL is supported. DATABASE_URL must start with postgresql+asyncpg://")

        if "+asyncpg" not in lower_v:
            raise ValueError("DATABASE_URL must use asyncpg driver: postgresql+asyncpg://")

        return v

    redis_url: str = Field(default="redis://localhost:6379/0")
    redis_pool_size: int = 10

    openai_api_key: str = Field(default="")
    openai_model: str = "gpt-4.1"
    openai_max_tokens: int = 4096
    openai_temperature: float = 0.1
    # HTTP timeout for each OpenAI request (stay below worker job_timeout so jobs fail cleanly).
    openai_timeout_seconds: float = 240.0

    browser_pool_size: int = 5
    browser_timeout_ms: int = 30000
    browser_headless: bool = True

    http_timeout_seconds: float = 30.0
    http_max_retries: int = 3
    http_retry_delay_seconds: float = 1.0

    rate_limit_requests_per_second: float = 2.0
    rate_limit_burst: int = 5

    extraction_cache_ttl_seconds: int = 86400
    dedup_window_hours: int = 24

    proxy_enabled: bool = False
    proxy_url: str | None = None

    auth_password: str = "qwe123"
    auth_secret_key: str = "super-secret-key-change-me"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    env_label = settings.app_env or os.environ.get("APP_ENV", "local")
    import logging
    logging.getLogger("app.config").info(
        "Loaded settings for APP_ENV=%s  (debug=%s, db_host=%s)",
        env_label,
        settings.debug,
        settings.database_url.split("@")[-1].split("/")[0] if "@" in settings.database_url else "local",
    )
    return settings
