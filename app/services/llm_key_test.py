"""Validate an LLM provider API key with a lightweight request.

Supports OpenAI, Gemini (via the OpenAI-compatible endpoint), and Anthropic.
Keys are never persisted by these helpers.
"""

from __future__ import annotations

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

SUPPORTED_PROVIDERS = ("openai", "anthropic", "gemini")


async def test_provider_api_key(provider: str, api_key: str) -> tuple[bool, str]:
    """Return (ok, message) for a provider key. Does not persist the key."""
    provider = (provider or "").strip().lower()
    key = (api_key or "").strip()

    if provider not in SUPPORTED_PROVIDERS:
        return False, f"Unknown provider '{provider}'."
    if len(key) < 20:
        return False, "API key looks too short."

    settings = get_settings()

    try:
        if provider == "openai":
            from openai import AsyncOpenAI

            t = min(30.0, settings.openai_timeout_seconds)
            client = AsyncOpenAI(
                api_key=key,
                max_retries=0,
                timeout=httpx.Timeout(t, connect=min(15.0, t)),
            )
            await client.models.list()

        elif provider == "gemini":
            from openai import AsyncOpenAI

            t = min(30.0, settings.gemini_timeout_seconds)
            client = AsyncOpenAI(
                api_key=key,
                base_url=settings.gemini_base_url,
                max_retries=0,
                timeout=httpx.Timeout(t, connect=min(15.0, t)),
            )
            await client.models.list()

        else:  # anthropic
            from anthropic import AsyncAnthropic

            t = min(30.0, settings.anthropic_timeout_seconds)
            client = AsyncAnthropic(
                api_key=key,
                max_retries=0,
                timeout=httpx.Timeout(t, connect=min(15.0, t)),
            )
            await client.messages.create(
                model=settings.anthropic_model,
                max_tokens=1,
                messages=[{"role": "user", "content": "ping"}],
            )

        logger.info("llm_key_test_ok", provider=provider)
        return True, "API key is valid and connected."
    except Exception as e:  # noqa: BLE001 - surface provider error to the user
        msg = str(e).strip() or f"{provider} rejected this API key."
        logger.warning("llm_key_test_failed", provider=provider, error=msg[:200])
        return False, msg[:300]
