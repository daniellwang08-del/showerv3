"""DB-backed overrides for allowlisted Settings fields (admin System Settings)."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.logging import get_logger
from app.models.database import SystemSetting

logger = get_logger(__name__)

# Keys that admins may override via system_settings. Must match Settings fields.
ALLOWLISTED_KEYS: frozenset[str] = frozenset(
    {
        # LLM
        "default_llm_provider",
        "openai_model",
        "anthropic_model",
        "gemini_model",
        "openai_reasoning_effort",
        "openai_timeout_seconds",
        "anthropic_timeout_seconds",
        "gemini_timeout_seconds",
        "phase_a_max_tokens",
        "phase_b_max_tokens",
        "extraction_worker_max_jobs",
        "analysis_worker_max_jobs",
        "tailoring_worker_max_jobs",
        "save_worker_max_jobs",
        "autopost_worker_max_jobs",
        "resume_worker_max_jobs",
        "scraper_worker_max_jobs",
        "llm_fallback_enabled",
        "llm_circuit_breaker_threshold",
        "llm_circuit_breaker_cooldown_seconds",
        "auto_generate_tailored_content",
        # Defaults
        "default_min_match_score",
        "default_dedup_recycle_days",
        # Dedup toggles
        "dedup_rule_location_unknown_enabled",
        "dedup_rule_applied_company_enabled",
        "dedup_rule_score_comparison_enabled",
        # Auth gate
        "auth_password",
        "extension_token_expire_days",
    }
)

# Server secrets shown as configured/not (never returned as values).
MASKED_PRESENCE_KEYS: tuple[str, ...] = (
    "openai_api_key",
    "anthropic_api_key",
    "gemini_api_key",
    "auth_secret_key",
    "database_url",
    "redis_url",
    "redis_cache_url",
    "redis_pubsub_url",
)

_BOOL_KEYS = frozenset(
    {
        "llm_fallback_enabled",
        "auto_generate_tailored_content",
        "dedup_rule_location_unknown_enabled",
        "dedup_rule_applied_company_enabled",
        "dedup_rule_score_comparison_enabled",
    }
)
_INT_KEYS = frozenset(
    {
        "phase_a_max_tokens",
        "phase_b_max_tokens",
        "extraction_worker_max_jobs",
        "analysis_worker_max_jobs",
        "tailoring_worker_max_jobs",
        "save_worker_max_jobs",
        "autopost_worker_max_jobs",
        "resume_worker_max_jobs",
        "scraper_worker_max_jobs",
        "llm_circuit_breaker_threshold",
        "default_min_match_score",
        "default_dedup_recycle_days",
        "extension_token_expire_days",
    }
)
_FLOAT_KEYS = frozenset(
    {
        "openai_timeout_seconds",
        "anthropic_timeout_seconds",
        "gemini_timeout_seconds",
        "llm_circuit_breaker_cooldown_seconds",
    }
)

_cache_lock_ts = 0.0
_cache_ttl_seconds = 5.0
_cached_overrides: dict[str, str] | None = None


def invalidate_system_settings_cache() -> None:
    global _cached_overrides, _cache_lock_ts
    _cached_overrides = None
    _cache_lock_ts = 0.0


def get_effective_value_sync(key: str) -> Any:
    """Sync read of an allowlisted key using the in-process override cache.

    Falls back to ``get_settings()`` when the cache is cold. Prefer the async
    ``get_effective_value`` when a DB session is available.
    """
    if key not in ALLOWLISTED_KEYS:
        raise KeyError(f"Key not allowlisted: {key}")
    settings = get_settings()
    base = _base_value(settings, key)
    overrides = _cached_overrides
    if overrides is None or key not in overrides:
        return base
    try:
        return _parse_value(key, overrides[key])
    except (TypeError, ValueError):
        return base


def _parse_value(key: str, raw: str) -> Any:
    text = raw.strip()
    if key in _BOOL_KEYS:
        return text.lower() in ("1", "true", "yes", "on")
    if key in _INT_KEYS:
        return int(text)
    if key in _FLOAT_KEYS:
        return float(text)
    return text


def _serialize_value(key: str, value: Any) -> str:
    if key in _BOOL_KEYS:
        return "true" if bool(value) else "false"
    return str(value)


def _base_value(settings: Settings, key: str) -> Any:
    return getattr(settings, key)


async def _load_overrides(session: AsyncSession) -> dict[str, str]:
    result = await session.execute(select(SystemSetting))
    rows = result.scalars().all()
    return {row.key: row.value for row in rows if row.key in ALLOWLISTED_KEYS}


async def get_overrides_map(session: AsyncSession | None = None) -> dict[str, str]:
    """Return allowlisted DB overrides (short TTL in-process cache)."""
    global _cached_overrides, _cache_lock_ts
    now = time.monotonic()
    if _cached_overrides is not None and (now - _cache_lock_ts) < _cache_ttl_seconds:
        return dict(_cached_overrides)

    if session is not None:
        overrides = await _load_overrides(session)
    else:
        from app.storage.database import get_session

        async with get_session() as sess:
            overrides = await _load_overrides(sess)

    _cached_overrides = overrides
    _cache_lock_ts = now
    return dict(overrides)


async def get_effective_settings(session: AsyncSession | None = None) -> dict[str, Any]:
    """Merge .env Settings with DB overrides for allowlisted keys."""
    settings = get_settings()
    overrides = await get_overrides_map(session)
    effective: dict[str, Any] = {}
    for key in sorted(ALLOWLISTED_KEYS):
        if key in overrides:
            try:
                effective[key] = _parse_value(key, overrides[key])
            except (TypeError, ValueError):
                effective[key] = _base_value(settings, key)
        else:
            effective[key] = _base_value(settings, key)
    return effective


async def get_effective_value(key: str, session: AsyncSession | None = None) -> Any:
    if key not in ALLOWLISTED_KEYS:
        raise KeyError(f"Key not allowlisted: {key}")
    effective = await get_effective_settings(session)
    return effective[key]


async def get_system_settings_payload(session: AsyncSession) -> dict[str, Any]:
    """Payload for GET /admin/system-settings."""
    settings = get_settings()
    overrides = await get_overrides_map(session)
    items: list[dict[str, Any]] = []
    for key in sorted(ALLOWLISTED_KEYS):
        base = _base_value(settings, key)
        overridden = key in overrides
        if overridden:
            try:
                value = _parse_value(key, overrides[key])
            except (TypeError, ValueError):
                value = base
        else:
            value = base
        # Mask auth_password in responses (show presence only when set).
        display_value: Any = value
        if key == "auth_password":
            display_value = "***" if value else ""
        items.append(
            {
                "key": key,
                "value": display_value,
                "env_default": ("***" if key == "auth_password" and base else base)
                if key == "auth_password"
                else base,
                "overridden": overridden,
            }
        )

    secrets_presence = {
        key: bool(getattr(settings, key, None)) for key in MASKED_PRESENCE_KEYS
    }
    return {"settings": items, "secrets_presence": secrets_presence}


async def upsert_settings(
    session: AsyncSession,
    updates: dict[str, Any],
    *,
    updated_by_user_id: str | None,
) -> dict[str, Any]:
    """Upsert allowlisted keys. Returns updated effective payload."""
    settings = get_settings()
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    for key, value in updates.items():
        if key not in ALLOWLISTED_KEYS:
            raise ValueError(f"Key not allowlisted: {key}")
        # Validate by parsing against type
        serialized = _serialize_value(key, value)
        try:
            parsed = _parse_value(key, serialized)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid value for {key}: {exc}") from exc

        # Extra range checks for known fields
        if key == "default_min_match_score" and not (0 <= int(parsed) <= 100):
            raise ValueError("default_min_match_score must be 0-100")
        if key == "default_dedup_recycle_days" and not (1 <= int(parsed) <= 3650):
            raise ValueError("default_dedup_recycle_days must be 1-3650")
        if key == "extension_token_expire_days" and not (1 <= int(parsed) <= 365):
            raise ValueError("extension_token_expire_days must be 1-365")
        if key == "default_llm_provider" and parsed not in ("openai", "anthropic", "gemini"):
            raise ValueError("default_llm_provider must be openai, anthropic, or gemini")
        if key == "openai_reasoning_effort" and parsed not in ("low", "medium", "high"):
            raise ValueError("openai_reasoning_effort must be low, medium, or high")

        # Skip write if equal to env default (optional cleanup) — still store override
        # so admin intent is explicit.
        _ = settings  # keep for future env-equality checks

        result = await session.execute(select(SystemSetting).where(SystemSetting.key == key))
        row = result.scalar_one_or_none()
        if row:
            row.value = serialized
            row.updated_at = now
            row.updated_by_user_id = updated_by_user_id
        else:
            session.add(
                SystemSetting(
                    key=key,
                    value=serialized,
                    updated_at=now,
                    updated_by_user_id=updated_by_user_id,
                )
            )
        logger.info("system_setting_upserted", key=key, updated_by=updated_by_user_id)

    await session.flush()
    invalidate_system_settings_cache()
    return await get_system_settings_payload(session)


async def clear_override(session: AsyncSession, key: str) -> dict[str, Any]:
    if key not in ALLOWLISTED_KEYS:
        raise ValueError(f"Key not allowlisted: {key}")
    result = await session.execute(select(SystemSetting).where(SystemSetting.key == key))
    row = result.scalar_one_or_none()
    if row:
        await session.delete(row)
        await session.flush()
        logger.info("system_setting_cleared", key=key)
    invalidate_system_settings_cache()
    return await get_system_settings_payload(session)
