"""Discover models available to an OpenAI-compatible (or Gemini) API key.

OpenAI-compatible gateways (LiteLLM, private proxies, etc.) expose many model
IDs on GET /v1/models for a single key. Native Anthropic keys do not use this
path; we return an empty list with a clear message for that provider.

Gateways often keep listing **retired** Gemini IDs after Google shuts them
down for ``generateContent``. Those still appear in /v1/models but return
404 at call time, we filter them from ``usable_for_chat`` so admins do not
bind or benchmark dead models.
"""

from __future__ import annotations

import re

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# IDs / substrings that are not useful for chat-completions job bindings.
_NON_CHAT_MARKERS = (
    "embedding",
    "embed",
    "dall-e",
    "gpt-image",
    "image-1",
    "whisper",
    "tts",
    "transcribe",
    "realtime",
    "audio",
    "moderation",
    "titan-embed",
)

# Google Gemini models shut down for generateContent but often still listed by
# LiteLLM / Models.list. Patterns match full aliases and dated variants.
# See: https://ai.google.dev/gemini-api/docs/deprecations
_RETIRED_GEMINI_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        r"^gemini-1\.0($|-)",
        r"^gemini-1\.5($|-)",
        r"^gemini-2\.0($|-)",
        r"^gemini-pro($|-)",
        r"^gemini-pro-vision($|-)",
        r"^gemini-ultra($|-)",
        r"^models/gemini-1\.0",
        r"^models/gemini-1\.5",
        r"^models/gemini-2\.0",
        r"^models/gemini-pro",
    )
)


def _normalize_openai_compatible_base_url(raw: str) -> str | None:
    base = (raw or "").strip().rstrip("/")
    if not base:
        return None
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return base


def is_retired_gemini_model(model_id: str) -> bool:
    """True when Google no longer supports this Gemini id for generateContent."""
    mid = (model_id or "").strip().lower()
    if mid.startswith("models/"):
        mid = mid[len("models/") :]
    # Strip LiteLLM provider prefixes: gemini/gemini-1.5-pro → gemini-1.5-pro
    if "/" in mid:
        mid = mid.rsplit("/", 1)[-1]
    return any(p.search(mid) for p in _RETIRED_GEMINI_PATTERNS)


def model_usable_for_chat(model_id: str) -> bool:
    mid = (model_id or "").strip().lower()
    if not mid:
        return False
    if any(marker in mid for marker in _NON_CHAT_MARKERS):
        return False
    if is_retired_gemini_model(mid):
        return False
    return True


def _timeout_seconds(provider: str) -> float:
    settings = get_settings()
    if provider == "gemini":
        return min(30.0, float(settings.gemini_timeout_seconds))
    return min(30.0, float(settings.openai_timeout_seconds))


async def list_models_for_api_key(
    *,
    provider: str,
    api_key: str,
) -> dict:
    """Return discovered models for a provider key.

    Shape:
      {
        "provider": "openai",
        "base_url": "https://…/v1" | null,
        "models": [{"id": "…", "owned_by": "…", "usable_for_chat": bool}, …],
        "chat_models": [{"id": "…", …}, …],
        "count": int,
        "message": str | None,
      }
    """
    provider = (provider or "").strip().lower()
    key = (api_key or "").strip()
    if provider not in ("openai", "anthropic", "gemini"):
        raise ValueError(f"Unknown provider '{provider}'")
    if len(key) < 8:
        raise ValueError("API key looks too short")

    settings = get_settings()
    t = _timeout_seconds(provider)
    timeout = httpx.Timeout(t, connect=min(15.0, t))

    if provider == "anthropic":
        # Anthropic does not expose the OpenAI /v1/models catalogue used by
        # OpenAI-compatible gateways. Job bindings for Anthropic should use the
        # system anthropic_model setting (or a manually typed model later).
        return {
            "provider": provider,
            "base_url": None,
            "models": [],
            "chat_models": [],
            "count": 0,
            "message": (
                "Model discovery via /v1/models is only available for OpenAI-compatible "
                "and Gemini keys. Use the Anthropic model system setting, or bind an "
                "OpenAI-compatible key that proxies Anthropic models."
            ),
        }

    from openai import AsyncOpenAI

    kwargs: dict = {
        "api_key": key,
        "max_retries": 0,
        "timeout": timeout,
    }
    base_url: str | None
    if provider == "gemini":
        base_url = (settings.gemini_base_url or "").strip().rstrip("/") or None
        if base_url:
            kwargs["base_url"] = base_url
    else:
        base_url = _normalize_openai_compatible_base_url(settings.openai_api_base)
        if base_url:
            kwargs["base_url"] = base_url

    client = AsyncOpenAI(**kwargs)
    try:
        page = await client.models.list()
    except Exception as exc:  # noqa: BLE001 - surface provider error to admin UI
        msg = str(exc).strip() or "Failed to list models"
        logger.warning(
            "llm_model_discovery_failed",
            provider=provider,
            base_url=base_url,
            error=msg[:200],
        )
        raise RuntimeError(msg[:300]) from exc

    items = getattr(page, "data", None) or []
    models: list[dict] = []
    seen: set[str] = set()
    retired_skipped = 0
    for item in items:
        mid = str(getattr(item, "id", "") or "").strip()
        if not mid or mid in seen:
            continue
        seen.add(mid)
        owned = getattr(item, "owned_by", None)
        usable = model_usable_for_chat(mid)
        if is_retired_gemini_model(mid):
            retired_skipped += 1
        models.append(
            {
                "id": mid,
                "owned_by": str(owned) if owned is not None else None,
                "usable_for_chat": usable,
            }
        )
    models.sort(key=lambda m: m["id"].lower())
    chat_models = [m for m in models if m["usable_for_chat"]]
    logger.info(
        "llm_model_discovery_ok",
        provider=provider,
        base_url=base_url,
        count=len(models),
        chat_count=len(chat_models),
        retired_gemini_skipped=retired_skipped,
    )
    return {
        "provider": provider,
        "base_url": base_url,
        "models": models,
        "chat_models": chat_models,
        "count": len(models),
        "message": None,
    }
