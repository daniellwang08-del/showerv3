"""
Shared async OpenAI client for AI-powered features.
Supports server default key or per-user custom keys from Settings.
"""

from __future__ import annotations

import hashlib

import httpx
from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger

try:
    from langfuse.openai import AsyncOpenAI  # type: ignore[import-unresolved]

    _LANGFUSE_AVAILABLE = True
except ImportError:
    from openai import AsyncOpenAI

    _LANGFUSE_AVAILABLE = False

logger = get_logger(__name__)

_clients: dict[str, AsyncOpenAI] = {}


def _cache_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()[:24]


def get_openai_client(*, api_key: str | None = None) -> AsyncOpenAI:
    """Get or create AsyncOpenAI client for the given API key (server default if omitted)."""
    settings = get_settings()
    key = (api_key or settings.openai_api_key or "").strip()
    if not key:
        raise AIParsingError("OpenAI API key not configured")

    ck = _cache_key(key)
    if ck not in _clients:
        t = settings.openai_timeout_seconds
        timeout = httpx.Timeout(t, connect=min(30.0, t))
        _clients[ck] = AsyncOpenAI(
            api_key=key,
            max_retries=0,
            timeout=timeout,
        )
        logger.info(
            "openai_client_initialized",
            timeout_seconds=t,
            langfuse_tracing=_LANGFUSE_AVAILABLE and settings.langfuse_enabled,
            custom_key=bool(api_key),
        )
    return _clients[ck]


async def get_openai_client_for_user(user_id: str | None) -> AsyncOpenAI:
    """Resolve the OpenAI client for a user (custom key or system default)."""
    if not user_id:
        return get_openai_client()
    from app.storage.database import get_session
    from app.storage.user_repository import UserRepository

    async with get_session() as session:
        repo = UserRepository(session)
        api_key = await repo.resolve_openai_api_key(user_id)
    return get_openai_client(api_key=api_key)
