from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from pydantic import field_validator
from functools import lru_cache
from typing import Literal


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Job Description Scraper"
    app_version: str = "1.0.0"
    debug: bool = True
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    database_url: str = Field(default="")
    database_pool_size: int = 20
    database_max_overflow: int = 10

    @field_validator("database_url")
    @classmethod
    def _validate_database_url(cls, v: str) -> str:
        if not v:
            raise ValueError("DATABASE_URL is required and must be PostgreSQL (postgresql+asyncpg://...)")

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
    return Settings()
