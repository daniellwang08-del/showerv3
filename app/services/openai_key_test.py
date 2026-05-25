"""Validate an OpenAI API key with a lightweight API call."""

from __future__ import annotations

import httpx
from openai import AsyncOpenAI

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


async def test_openai_api_key(api_key: str) -> tuple[bool, str]:
    """Return (ok, message). Does not persist the key."""
    key = (api_key or "").strip()
    if len(key) < 20:
        return False, "API key looks too short."

    settings = get_settings()
    t = min(30.0, settings.openai_timeout_seconds)
    timeout = httpx.Timeout(t, connect=min(15.0, t))
    client = AsyncOpenAI(api_key=key, max_retries=0, timeout=timeout)

    try:
        await client.models.list(limit=1)
        logger.info("openai_key_test_ok")
        return True, "API key is valid and connected."
    except Exception as e:
        msg = str(e).strip() or "OpenAI rejected this API key."
        logger.warning("openai_key_test_failed", error=msg[:200])
        return False, msg[:300]
