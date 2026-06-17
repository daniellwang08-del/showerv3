"""
Shared async LLM client for AI-powered features.

Historically this module returned a raw ``AsyncOpenAI`` instance. It now
returns ``LLMFallbackClient`` from :mod:`app.core.llm_client`, which has the
same public surface (``client.chat.completions.create(...)``) but
automatically falls back to Anthropic Claude when an OpenAI call fails with
a quota / rate-limit / auth / connection / 5xx error.

Existing call sites do not need to change — duck typing keeps them working,
and they gain transparent multi-provider resilience.
"""

from __future__ import annotations

from app.core.llm_client import (
    LLMFallbackClient,
    get_llm_client,
    get_llm_client_for_user,
)
from app.core.logging import get_logger

logger = get_logger(__name__)


def get_openai_client(*, api_key: str | None = None) -> LLMFallbackClient:
    """Get the shared LLM client (OpenAI primary, Anthropic fallback).

    *api_key* — when provided, used as the OpenAI key. Anthropic fallback
    is still sourced from the server's ``ANTHROPIC_API_KEY``.
    """
    return get_llm_client(openai_api_key=api_key)


async def get_openai_client_for_user(user_id: str | None) -> LLMFallbackClient:
    """Resolve the LLM client for a user (per-user OpenAI key + server Anthropic)."""
    return await get_llm_client_for_user(user_id)
