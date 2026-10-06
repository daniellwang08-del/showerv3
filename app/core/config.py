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
    are optional - real env vars always take highest precedence.
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
    # uvicorn watches app/ when True (see app.core.dev_reload.api_reload_enabled).
    reload: bool = True
    # arq workers watch app/ when True (independent of reload; default off).
    worker_reload: bool = False

    app_name: str = "NAO"
    app_version: str = "1.0.0"
    # Secure by default: debug must be explicitly enabled (DEBUG=true) for local
    # dev. Leaving it off in production keeps /docs closed and the permissive
    # private-LAN/extension CORS regex disabled. Interactive docs stay available
    # in any non-production environment regardless of this flag (see main.py).
    debug: bool = False
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    # Persist structured logs to system_log_events for the admin logs dashboard.
    log_persist_enabled: bool = True
    log_persist_min_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_retention_days: int = 14

    @field_validator("app_env")
    @classmethod
    def _strip_app_env(cls, v: str) -> str:
        return v.strip()
    # When True, SQLAlchemy logs every SQL statement (very noisy). Not tied to `debug`.
    sqlalchemy_echo: bool = False

    database_url: str = Field(default="")
    # Sized for a shared API+workers box (~CPX51). Keep pool×process_count under
    # Postgres max_connections (production tuned to 300).
    database_pool_size: int = 12
    database_max_overflow: int = 8
    # A runaway query or a leaked open transaction should fail, not pin a
    # connection and its locks. 0 disables either guard.
    database_statement_timeout_ms: int = Field(default=60_000, ge=0)
    database_idle_in_transaction_timeout_ms: int = Field(default=120_000, ge=0)

    @field_validator("database_url")
    @classmethod
    def _validate_database_url(cls, v: str) -> str:
        if not v:
            raise ValueError("DATABASE_URL is required and must be PostgreSQL (postgresql+asyncpg://...)")

        # Render (and many PaaS) provide postgres:// - auto-convert to the
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

    # Broker for arq job queues (logical DB /0 locally). Managed Redis that only
    # exposes DB 0: leave cache/pubsub URLs unset so they reuse this URL.
    redis_url: str = Field(default="redis://localhost:6379/0")
    # Optional role-specific URLs (extraction cache, WS pub/sub). Empty = redis_url.
    redis_cache_url: str | None = Field(default=None)
    redis_pubsub_url: str | None = Field(default=None)
    # Connection pool sizes per role (redis.asyncio clients).
    redis_pool_size: int = 20  # extraction cache
    redis_broker_pool_size: int = 20  # admin queue depth / health
    redis_pubsub_pool_size: int = 10
    # When True, API refuses in-process BackgroundTasks job fallback.
    # None = auto (True for APP_ENV=production|prod, False otherwise).
    redis_require_for_jobs: bool | None = Field(default=None)
    # arq: seconds to retain job results (0 = do not keep; frees _job_id for re-runs).
    arq_keep_result_seconds: int = Field(default=0, ge=0)
    # arq max_tries: extraction/analysis/tailoring retry transient failures;
    # save/resume/scraper stay at 1 (idempotency / side effects).
    extraction_worker_max_tries: int = Field(default=3, ge=1, le=10)
    analysis_worker_max_tries: int = Field(default=3, ge=1, le=10)
    tailoring_worker_max_tries: int = Field(default=3, ge=1, le=10)

    openai_api_key: str = Field(default="")
    # OpenAI-compatible base URL (Azure, LiteLLM, private gateway, …).
    # Empty = official OpenAI. Accepts with or without trailing `/v1`.
    # One key may expose many models via GET {base}/models, bind per job in admin.
    openai_api_base: str = Field(default="")
    # Default chat model when a job binding does not select one. GPT-5 reasoning
    # models (e.g. gpt-5.1) use max_completion_tokens and ignore custom
    # temperature; the LLM client normalizes API kwargs automatically.
    openai_model: str = "gpt-5.6-luna"
    openai_max_tokens: int = 4096
    openai_temperature: float = 0.1
    # Reasoning depth for o-series / GPT-5 non-chat models (low | medium | high).
    # Ignored for legacy chat models (gpt-4.x, gpt-5-chat-latest, …).
    openai_reasoning_effort: Literal["low", "medium", "high"] = "low"
    # HTTP timeout for each OpenAI request (stay below worker job_timeout so jobs fail cleanly).
    openai_timeout_seconds: float = 240.0
    # Concurrent arq jobs per worker process (overridable via System Settings).
    # Applied at worker process start from DB overrides when present.
    # Defaults target a 16-vCPU / 32GB shared production host (CPX51-class).
    extraction_worker_max_jobs: int = 12
    analysis_worker_max_jobs: int = 10
    tailoring_worker_max_jobs: int = 10
    save_worker_max_jobs: int = 16
    resume_worker_max_jobs: int = 8
    scraper_worker_max_jobs: int = 4
    # Queue poll interval for the match path (extraction, encoding, analysis,
    # save). arq's 0.5 s default adds ~0.25 s idle per hop.
    match_worker_poll_delay_seconds: float = Field(default=0.05, ge=0.01, le=0.5)
    # Spiders in one sync plan run as parallel Scrapy subprocesses (different
    # hosts), bounded by this. A per-spider Redis lock prevents overlap.
    scraper_parallel_spiders: int = Field(default=3, ge=1, le=8)
    # Hard kill for one spider subprocess. Must stay below the scraper job_timeout.
    scraper_spider_timeout_seconds: int = Field(default=5400, ge=300, le=14000)
    # Sheets/Pumble auto-post (low priority; must not hold save slots).
    autopost_worker_max_jobs: int = 6
    # Max parallel OpenAI calls when attachment text is split into chunks.
    openai_attachment_max_concurrent: int = 8
    phase_a_max_tokens: int = 16384
    phase_b_max_tokens: int = 16384
    # Reasoning effort for resume tailoring + cover letter calls only. Empty = use
    # openai_reasoning_effort. "none" is accepted by gpt-5.1+ only, and on gpt-5.1 it
    # lists JD technologies the profile does not contain, so keep it unset by default.
    phase_b_reasoning_effort: Literal["", "none", "minimal", "low", "medium", "high"] = ""
    auto_generate_tailored_content: bool = True
    # Global kill-switch for auto-prepare fan-out / backfill (manual Run unaffected).
    auto_prepare_enabled: bool = True
    # Soft per-user daily cap on auto-prepare analyze enqueues (UTC day).
    # 0 = unlimited (default). Manual Run is never counted toward this cap.
    auto_prepare_daily_cap_per_user: int = Field(default=0, ge=0, le=100_000)
    # Soft pending-in-progress cap before auto-prepare stops enqueueing for a user.
    auto_prepare_pending_cap_per_user: int = Field(default=100, ge=1, le=2000)
    # Free-engine catch-up when a user opens Jobs: at most this many unscored
    # visible jobs per visit, and at most one sweep per user per cooldown.
    auto_score_on_visit_limit: int = Field(default=100, ge=0, le=1000)
    auto_score_on_visit_cooldown_seconds: int = Field(default=300, ge=30, le=86_400)

    # LLM quality check of free vector scores (user rescore, or automatic for top
    # matches when the user opts in). An admin job binding for
    # "match_quality_check" overrides this model.
    match_quality_check_model: str = "gpt-5.6-luna"
    # Per-user UTC-day cap on quality-check LLM calls (0 = unlimited).
    match_quality_check_daily_cap_per_user: int = Field(default=200, ge=0, le=100_000)

    # Anthropic Claude - used as automatic fallback when OpenAI is unavailable
    # (insufficient_quota, rate-limit, auth failure, connection/timeout error).
    # Leave anthropic_api_key empty to disable fallback entirely.
    anthropic_api_key: str = Field(default="")
    anthropic_model: str = "claude-sonnet-4-5-20250929"
    anthropic_max_tokens: int = 4096
    # Per-request HTTP timeout for Anthropic calls (mirrors openai_timeout_seconds).
    anthropic_timeout_seconds: float = 240.0
    # Google Gemini - selectable as a primary provider or as a fallback. Uses
    # Google's OpenAI-compatible endpoint so the existing OpenAI SDK is reused
    # (no extra dependency). Leave gemini_api_key empty to disable Gemini.
    gemini_api_key: str = Field(default="")
    gemini_model: str = "gemini-2.5-flash"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    gemini_timeout_seconds: float = 240.0

    # Provider used when a user hasn't explicitly chosen one ("openai" | "anthropic" | "gemini").
    default_llm_provider: Literal["openai", "anthropic", "gemini"] = "openai"

    # When true, the shared LLM client transparently retries the user's chosen
    # provider against the other configured providers on a recoverable error.
    # Disable to use only the selected provider (no cross-provider fallback).
    llm_fallback_enabled: bool = True
    # Circuit breaker: after this many consecutive OpenAI failures, skip OpenAI
    # entirely and go straight to Anthropic for `llm_circuit_breaker_cooldown_seconds`.
    llm_circuit_breaker_threshold: int = Field(default=3, ge=1, le=100)
    llm_circuit_breaker_cooldown_seconds: float = Field(default=300.0, ge=10.0)

    # Match extraction_worker_max_jobs so concurrent extract jobs are not
    # serialized on a smaller Playwright semaphore.
    browser_pool_size: int = 12
    browser_timeout_ms: int = 30000
    browser_headless: bool = True
    # When False (default), Chromium launches with --disable-gpu.
    browser_use_gpu: bool = False
    # API lifespan pre-launches Chromium in the background. Turn off when the
    # extraction worker owns the pool; the API then launches lazily on first use.
    browser_pool_warmup: bool = True

    http_timeout_seconds: float = 30.0
    http_max_retries: int = 3
    http_retry_delay_seconds: float = 1.0

    # Align with extraction concurrency (token bucket + burst semaphore).
    rate_limit_requests_per_second: float = 12.0
    rate_limit_burst: int = 20
    # Total in-flight outbound HTTP requests per process (rate limits are per host).
    http_max_concurrency: int = Field(default=24, ge=1, le=256)

    extraction_cache_ttl_seconds: int = 3600
    default_dedup_recycle_days: int = Field(default=60, ge=1, le=3650)
    default_min_match_score: int = Field(default=0, ge=0, le=100)

    # Post-analysis dedup rule toggles, platform defaults for per-user prefs
    # (applied company / score comparison). Always-on rules (below_min_score,
    # non_us, same_url, strict_similarity) are not toggleable here.
    # Unknown/missing locations are always kept (treated as US).
    # Legacy unused key kept for env/back-compat only; never read at runtime.
    dedup_rule_location_unknown_enabled: bool = False
    dedup_rule_applied_company_enabled: bool = False
    dedup_rule_score_comparison_enabled: bool = False

    # ── Non-LLM vector match engine ─────────────────────────────────────
    # llm    = Phase A scoring via LLM only (legacy behavior).
    # shadow = LLM stays authoritative; vector scorer runs alongside and the
    #          comparison is stored for calibration (no user-visible change).
    # vector = vector scorer is authoritative; Phase A never calls the LLM
    #          (raw extraction text + encodings). Phase B tailoring unchanged.
    match_engine: Literal["llm", "shadow", "vector"] = "vector"
    # Vector scorer generation. v5 = learned dimension models over requirement
    # coverage (falls back to v4 when its model files are missing); v4 = the
    # hand-fitted linear models.
    match_vector_scorer: Literal["v5", "v4"] = "v5"
    # Cross-encoder stage of scorer v5, run in the analysis worker.
    # auto = on when CUDA is available and the weights exist; off = trees only.
    match_cross_encoder: Literal["auto", "on", "off"] = "auto"
    # Directory written by the cross-encoder export (weights, tokenizer, meta).
    match_cross_encoder_dir: str = Field(default="./model_cache/nao-match-ce-v5")
    match_cross_encoder_batch_window_ms: float = Field(default=3.0, ge=0.0, le=50.0)
    match_cross_encoder_max_batch: int = Field(default=16, ge=1, le=128)
    # Sentence-transformers model for section embeddings.
    # MiniLM-L6 (~90 MB, 384-dim) fits small VPS hosts; upgrade to
    # all-mpnet-base-v2 (~420 MB, 768-dim) via env on larger machines.
    embedding_model_name: str = "sentence-transformers/all-MiniLM-L6-v2"
    # Where model weights are cached on disk (persists across deploys).
    embedding_model_cache_dir: str = Field(default="./model_cache")
    # auto = CUDA when torch reports it available, else CPU. An explicit
    # "cuda" without a usable GPU falls back to CPU with a warning.
    embedding_device: Literal["auto", "cpu", "cuda"] = "auto"
    # When unset, the effective batch size is 64 on CUDA and 16 on CPU.
    embedding_batch_size: int = Field(default=16, ge=1, le=256)
    # Half-precision weights on CUDA: about 2x throughput on large batches with
    # cosine drift around 1e-3, well inside match-score rounding.
    embedding_fp16: bool = True
    # Concurrent encode requests are merged into one model call. The batcher
    # waits this long for more requests once the first one arrives.
    embedding_batch_window_ms: float = Field(default=4.0, ge=0.0, le=50.0)
    embedding_max_batch_texts: int = Field(default=256, ge=1, le=1024)
    # Encode inline in extraction/analysis processes (True) or always defer to
    # the encoding worker (False) so only that process loads torch.
    # None = auto (False for APP_ENV=local|dev|development, True otherwise).
    embedding_inline: bool | None = Field(default=None)
    # Concurrent arq jobs for the encoding worker. Model calls are merged by
    # the micro-batcher, so more slots means bigger GPU batches, not contention.
    encoding_worker_max_jobs: int = 16

    proxy_enabled: bool = False
    proxy_url: str | None = None

    auth_password: str = Field(default="")
    auth_secret_key: str = Field(default="")
    # Dedicated key for encrypting user secrets at rest (custom LLM/Pumble keys).
    # Empty = derive from auth_secret_key (back-compat). Set this to rotate the
    # JWT signing secret WITHOUT re-encrypting every stored secret, and to avoid
    # coupling token forgery risk to secret-at-rest confidentiality.
    settings_encryption_key: str = Field(default="")
    # Lifetime (days) of the long-lived bearer token issued to non-cookie clients
    # (e.g. the browser extension) when they request `long_lived` at login.
    extension_token_expire_days: int = Field(default=30, ge=1, le=365)

    # Production CORS. FRONTEND_URL is the public SPA origin; CORS_EXTRA_ORIGINS
    # is a comma-separated list (chrome-extension://…, https://www.…, etc.).
    frontend_url: str = Field(default="")
    cors_extra_origins: str = Field(default="")
    # Cookie Domain for access_token so apex + logs subdomain share the session
    # (e.g. ".nao.it.com"). Empty = host-only (local/dev default).
    auth_cookie_domain: str = Field(default="")

    # ── Stripe billing / subscriptions ───────────────────────────────────
    # Master switch for the whole subscription feature. Set BILLING_ENABLED=false
    # to disable payments (checkout/portal return 503, the pricing page reports
    # "not available") WITHOUT discarding the Stripe keys below, so it can be
    # flipped back on later with a single env change + restart.
    billing_enabled: bool = Field(default=True)
    # Server-side secret key (sk_live_… / sk_test_…). Empty = billing disabled;
    # the /billing endpoints report "not configured" instead of erroring.
    stripe_secret_key: str = Field(default="")
    # Publishable key (pk_…). Not required for hosted Checkout (we redirect to the
    # session URL) but exposed to the SPA for completeness / future Elements use.
    stripe_publishable_key: str = Field(default="")
    # Webhook signing secret (whsec_…) for POST /billing/webhook. Without it the
    # webhook refuses every event so forged subscription updates are impossible.
    stripe_webhook_secret: str = Field(default="")
    # Recurring Price IDs (price_…) created in the Stripe dashboard, one per plan.
    stripe_price_trial: str = Field(default="")
    stripe_price_monthly: str = Field(default="")
    stripe_price_quarterly: str = Field(default="")
    stripe_price_yearly: str = Field(default="")
    # Where Stripe Checkout / Customer Portal returns the user. Empty = derive
    # from frontend_url (…/billing), falling back to the local dev SPA origin.
    stripe_billing_return_url: str = Field(default="")

    google_sheets_credentials_path: str = Field(default="google_credentials.json")

    # Default GPA written to optional "Overall Result (GPA)" application fields when
    # the profile has no stored value (Workday). Applied only when the field exists
    # and is empty; a stored profile GPA always takes precedence. Blank disables it.
    autofill_default_gpa: str = Field(default="3.7")

    # Default Field of Study written to the optional Workday "Field of Study" prompt
    # when it cannot be derived from the candidate's degree text. The candidate can
    # change it manually on the form. Blank disables the fallback.
    autofill_default_field_of_study: str = Field(default="Computer Engineering")

    resume_output_root: str = Field(default="./resume_output")
    # DOCX -> PDF is always pure-Python via the ``dxpdf`` package (see requirements.txt).
    resume_template_path: str = Field(default="app/templates/resume_template.docx")
    cover_letter_template_path: str = Field(default="app/templates/cover_letter_template.docx")
    user_templates_root: str = Field(default="./user_templates")
    resume_template_max_bytes: int = Field(default=5_000_000, ge=100_000, le=20_000_000)

    # Scraper module settings (scrapy joblinks integration)
    adzuna_app_id: str = Field(default="")
    adzuna_app_key: str = Field(default="")
    # Kept for optional manual scrapy crawl ziprecruiter (not in sync platform list).
    ziprecruiter_api_key: str = Field(default="")
    # Residential proxies for RemoteRocketship Cloudflare bypass.
    # Prefer SCRAPER_PROXY_URL (or HOST/PORT/USER/PASSWORD). File path still supported.
    scraper_proxy_list_path: str = Field(default="")
    scraper_proxy_url: str = Field(default="")
    scraper_proxy_urls: str = Field(default="")
    scraper_proxy_host: str = Field(default="")
    scraper_proxy_port: str = Field(default="")
    scraper_proxy_user: str = Field(default="")
    scraper_proxy_password: str = Field(default="")


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
