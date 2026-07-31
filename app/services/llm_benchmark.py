"""Admin LLM response-time benchmarks for comparing models.

Issues a fixed tiny completion per (provider, model) and records wall-clock
latency. Keys are resolved from an optional pool key, else the server .env key.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.config import get_settings
from app.core.llm_client import _normalize_openai_chat_kwargs
from app.core.logging import get_logger

logger = get_logger(__name__)

SUPPORTED_PROVIDERS = ("openai", "anthropic", "gemini")
DEFAULT_PROMPT = "Reply with exactly: ok"
MAX_MODELS_PER_REQUEST = 40
MAX_RUNS_PER_REQUEST = 10
BENCHMARK_MAX_TOKENS = 16


@dataclass(frozen=True)
class BenchmarkTarget:
    provider: str
    model: str
    provider_key_id: str | None = None


@dataclass
class BenchmarkResult:
    provider: str
    model: str
    provider_key_id: str | None
    ok: bool
    latency_ms: float | None
    error: str | None
    ran_at: str
    response_preview: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "provider_key_id": self.provider_key_id,
            "ok": self.ok,
            "latency_ms": self.latency_ms,
            "error": self.error,
            "ran_at": self.ran_at,
            "response_preview": self.response_preview,
        }


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def format_provider_error(exc: BaseException | str, *, model: str = "") -> str:
    """Turn LiteLLM / OpenAI / Gemini exception text into a short admin message."""
    raw = str(exc).strip() if not isinstance(exc, str) else exc.strip()
    low = raw.lower()
    model_label = (model or "").strip() or "model"

    if "429" in raw or "rate limit" in low or "exceeded your current quota" in low:
        return (
            f"{model_label}: provider quota / rate limit exceeded (HTTP 429). "
            "Wait and retry, lower concurrency, or check Gemini/OpenAI billing — "
            "this is not an application bug."
        )

    if "404" in raw or "not found" in low or "not_found" in low:
        if "gemini" in low or model_label.lower().startswith("gemini"):
            return (
                f"{model_label}: retired or unavailable on Gemini (HTTP 404). "
                "Gateways often still list old ids (e.g. gemini-1.5-*, gemini-2.0-*); "
                "use a current model such as gemini-2.5-flash / gemini-2.5-pro."
            )
        return (
            f"{model_label}: model not found on the provider (HTTP 404). "
            "It may be retired or mistyped in the gateway catalogue."
        )

    # Prefer the innermost "message" field when LiteLLM nests JSON.
    for marker in ('"message": "', "message': '"):
        idx = raw.find(marker)
        if idx >= 0:
            start = idx + len(marker)
            end = raw.find('"', start) if marker.endswith('"') else raw.find("'", start)
            if end > start:
                inner = raw[start:end].strip()
                if inner and len(inner) < 280:
                    return f"{model_label}: {inner}"

    cleaned = " ".join(raw.split())
    if len(cleaned) > 320:
        cleaned = cleaned[:317] + "..."
    return f"{model_label}: {cleaned}" if model_label != "model" else cleaned


def _timeout_for_provider(provider: str) -> float:
    from app.services.system_settings_service import get_effective_value_sync

    settings = get_settings()
    if provider == "anthropic":
        raw = get_effective_value_sync("anthropic_timeout_seconds")
        base = float(raw if raw is not None else settings.anthropic_timeout_seconds)
    elif provider == "gemini":
        raw = get_effective_value_sync("gemini_timeout_seconds")
        base = float(raw if raw is not None else settings.gemini_timeout_seconds)
    else:
        raw = get_effective_value_sync("openai_timeout_seconds")
        base = float(raw if raw is not None else settings.openai_timeout_seconds)
    return min(45.0, max(5.0, base))


def _env_api_key(provider: str) -> str:
    settings = get_settings()
    if provider == "anthropic":
        return (settings.anthropic_api_key or "").strip()
    if provider == "gemini":
        return (settings.gemini_api_key or "").strip()
    return (settings.openai_api_key or "").strip()


async def resolve_benchmark_api_key(
    session,
    *,
    provider: str,
    provider_key_id: str | None,
) -> str:
    """Return plaintext API key for the benchmark call."""
    provider = provider.strip().lower()
    if provider_key_id:
        from app.services import llm_provider_keys_service

        creds = await llm_provider_keys_service.get_provider_key_plaintext(
            session, provider_key_id
        )
        if not creds:
            raise ValueError("Provider key not found or disabled.")
        key_provider, api_key = creds
        if key_provider != provider:
            raise ValueError(
                f"Key is for '{key_provider}' but target provider is '{provider}'."
            )
        return api_key

    api_key = _env_api_key(provider)
    if not api_key:
        # Common gateway setup: all catalogue models ride the OpenAI-compatible key.
        if provider != "openai":
            fallback = _env_api_key("openai")
            if fallback:
                return fallback
        raise ValueError(f"No {provider} API key configured (pool or server .env).")
    return api_key


async def _benchmark_openai_compatible(
    *,
    provider: str,
    model: str,
    api_key: str,
    prompt: str,
) -> tuple[str, float]:
    from openai import AsyncOpenAI

    settings = get_settings()
    t = _timeout_for_provider(provider if provider != "anthropic" else "openai")
    kwargs: dict[str, Any] = {
        "api_key": api_key,
        "max_retries": 0,
        "timeout": httpx.Timeout(t, connect=min(15.0, t)),
    }
    if provider == "gemini":
        kwargs["base_url"] = settings.gemini_base_url
    else:
        base = (settings.openai_api_base or "").strip().rstrip("/")
        if base:
            if not base.endswith("/v1"):
                base = f"{base}/v1"
            kwargs["base_url"] = base

    client = AsyncOpenAI(**kwargs)
    call_kwargs = _normalize_openai_chat_kwargs(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": BENCHMARK_MAX_TOKENS,
            "temperature": 0,
        },
        model=model,
    )
    started = time.perf_counter()
    resp = await client.chat.completions.create(**call_kwargs)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    text = ""
    try:
        text = (resp.choices[0].message.content or "").strip()
    except Exception:  # noqa: BLE001
        text = ""
    return text[:120], elapsed_ms


async def _benchmark_anthropic(
    *,
    model: str,
    api_key: str,
    prompt: str,
) -> tuple[str, float]:
    from anthropic import AsyncAnthropic

    t = _timeout_for_provider("anthropic")
    client = AsyncAnthropic(
        api_key=api_key,
        max_retries=0,
        timeout=httpx.Timeout(t, connect=min(15.0, t)),
    )
    started = time.perf_counter()
    resp = await client.messages.create(
        model=model,
        max_tokens=BENCHMARK_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    text = ""
    try:
        blocks = getattr(resp, "content", None) or []
        if blocks:
            text = (getattr(blocks[0], "text", None) or "").strip()
    except Exception:  # noqa: BLE001
        text = ""
    return text[:120], elapsed_ms


async def benchmark_one(
    session,
    target: BenchmarkTarget,
    *,
    prompt: str = DEFAULT_PROMPT,
) -> BenchmarkResult:
    """Run a single timed completion for one model."""
    provider = (target.provider or "").strip().lower()
    model = (target.model or "").strip()
    ran_at = _utcnow_iso()

    if provider not in SUPPORTED_PROVIDERS:
        return BenchmarkResult(
            provider=provider or "unknown",
            model=model,
            provider_key_id=target.provider_key_id,
            ok=False,
            latency_ms=None,
            error=f"Unknown provider '{provider}'.",
            ran_at=ran_at,
        )
    if not model:
        return BenchmarkResult(
            provider=provider,
            model=model,
            provider_key_id=target.provider_key_id,
            ok=False,
            latency_ms=None,
            error="Model id is required.",
            ran_at=ran_at,
        )

    from app.services.llm_model_discovery import is_retired_gemini_model

    if is_retired_gemini_model(model):
        return BenchmarkResult(
            provider=provider,
            model=model,
            provider_key_id=target.provider_key_id,
            ok=False,
            latency_ms=None,
            error=(
                f"{model}: retired on Gemini (filtered before call). "
                "Use gemini-2.5-flash / gemini-2.5-pro or newer — not a code bug."
            ),
            ran_at=ran_at,
        )

    try:
        api_key = await resolve_benchmark_api_key(
            session,
            provider=provider,
            provider_key_id=target.provider_key_id,
        )
    except ValueError as exc:
        return BenchmarkResult(
            provider=provider,
            model=model,
            provider_key_id=target.provider_key_id,
            ok=False,
            latency_ms=None,
            error=str(exc),
            ran_at=ran_at,
        )

    env_openai = _env_api_key("openai")
    env_anthropic = _env_api_key("anthropic")
    # Native Anthropic when the resolved key is an Anthropic key; otherwise the
    # shared OpenAI-compatible gateway (OPENAI_API_BASE) serves the catalogue.
    use_native_anthropic = provider == "anthropic" and (
        bool(target.provider_key_id) or (bool(env_anthropic) and api_key == env_anthropic)
    )
    # Gemini native base URL unless we fell back to the OpenAI gateway key.
    use_gemini_transport = provider == "gemini" and not (
        bool(env_openai) and api_key == env_openai and api_key != _env_api_key("gemini")
    )

    try:
        if use_native_anthropic:
            preview, latency_ms = await _benchmark_anthropic(
                model=model, api_key=api_key, prompt=prompt
            )
        else:
            transport = "gemini" if use_gemini_transport else "openai"
            preview, latency_ms = await _benchmark_openai_compatible(
                provider=transport, model=model, api_key=api_key, prompt=prompt
            )

        logger.info(
            "llm_benchmark_ok",
            provider=provider,
            model=model,
            latency_ms=round(latency_ms, 1),
        )
        return BenchmarkResult(
            provider=provider,
            model=model,
            provider_key_id=target.provider_key_id,
            ok=True,
            latency_ms=round(latency_ms, 1),
            error=None,
            ran_at=ran_at,
            response_preview=preview or None,
        )
    except Exception as exc:  # noqa: BLE001 - surface provider error to admin UI
        msg = format_provider_error(exc, model=model)
        logger.warning(
            "llm_benchmark_failed",
            provider=provider,
            model=model,
            error=msg[:200],
        )
        return BenchmarkResult(
            provider=provider,
            model=model,
            provider_key_id=target.provider_key_id,
            ok=False,
            latency_ms=None,
            error=msg[:400],
            ran_at=ran_at,
        )


async def benchmark_models(
    session,
    targets: list[BenchmarkTarget],
    *,
    prompt: str = DEFAULT_PROMPT,
    runs: int = 1,
    concurrency: int = 1,
) -> list[BenchmarkResult]:
    """Benchmark multiple models. Runs are sequential rounds; within a round
    models may run with limited concurrency (default 1 to respect rate limits).
    """
    if not targets:
        return []
    if len(targets) > MAX_MODELS_PER_REQUEST:
        raise ValueError(f"At most {MAX_MODELS_PER_REQUEST} models per request.")
    runs = max(1, min(int(runs), MAX_RUNS_PER_REQUEST))
    concurrency = max(1, min(int(concurrency), 4))

    prompt = (prompt or DEFAULT_PROMPT).strip() or DEFAULT_PROMPT
    if len(prompt) > 500:
        raise ValueError("Prompt must be at most 500 characters.")

    results: list[BenchmarkResult] = []
    sem = asyncio.Semaphore(concurrency)

    async def _one(target: BenchmarkTarget) -> BenchmarkResult:
        async with sem:
            return await benchmark_one(session, target, prompt=prompt)

    for _ in range(runs):
        batch = await asyncio.gather(*[_one(t) for t in targets])
        results.extend(batch)

    return results
