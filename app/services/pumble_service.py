"""
Pumble integration service.

Posts job URLs to a user-configured Pumble channel as thread replies under a
daily parent message (e.g. "7/9/2026 (NAO post)").

Uses the Pumble API Keys addon:
https://pumble-api-keys.addons.marketplace.cake.com
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import Job, PumbleConfig
from app.services.auto_post_filters import (
    job_matches_auto_post_filters,
    normalize_auto_post_filters,
)
from app.storage.database import get_session
from app.utils.secret_encryption import decrypt_secret, encrypt_secret, mask_api_key

logger = get_logger(__name__)

_BASE_URL = "https://pumble-api-keys.addons.marketplace.cake.com"
_BRAND_NAME = "NAO"
_REPLY_GAP = 0.05  # seconds between thread replies


class PumbleApiError(Exception):
    """Raised when a Pumble API call fails."""

    def __init__(self, message: str, *, code: str = "api_error", status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _daily_parent_text(posted_date: date) -> str:
    return f"{posted_date.month}/{posted_date.day}/{posted_date.year} ({_BRAND_NAME} post)"


def _today_utc() -> date:
    return datetime.utcnow().date()


def _clamp_auto_post_threshold(value: int) -> int:
    return max(0, min(100, int(value)))


def _extract_message_id(payload: dict[str, Any]) -> str | None:
    for key in ("messageId", "id"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    message = payload.get("message")
    if isinstance(message, dict):
        for key in ("id", "messageId"):
            val = message.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None


def _message_text(payload: dict[str, Any]) -> str:
    for key in ("text", "messageText", "body"):
        val = payload.get(key)
        if isinstance(val, str):
            return val.strip()
    message = payload.get("message")
    if isinstance(message, dict):
        for key in ("text", "messageText", "body"):
            val = message.get(key)
            if isinstance(val, str):
                return val.strip()
    return ""


def _normalize_url(url: str) -> str:
    return url.strip().rstrip("/")


def _url_from_message_text(text: str) -> str | None:
    candidate = (text or "").strip()
    if candidate.startswith("http://") or candidate.startswith("https://"):
        return _normalize_url(candidate)
    return None


def _parse_channels(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        raw_items = payload
    elif isinstance(payload, dict):
        raw_items = payload.get("channels", payload.get("items", []))
        if not isinstance(raw_items, list):
            raw_items = [payload]
    else:
        return []

    channels: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        ch = item.get("channel", item)
        if not isinstance(ch, dict):
            continue
        channel_type = str(ch.get("channelType") or "").upper()
        if channel_type == "DIRECT":
            continue
        channel_id = ch.get("id")
        name = (ch.get("name") or "").strip()
        if not channel_id:
            continue
        if not name:
            name = channel_id
        channels.append(
            {
                "id": str(channel_id),
                "name": name,
                "channel_type": channel_type or "PUBLIC",
                "is_private": channel_type == "PRIVATE",
            }
        )
    channels.sort(key=lambda c: c["name"].lower())
    return channels


def _sync_request(
    api_key: str,
    method: str,
    endpoint: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> Any:
    headers = {
        "ApiKey": api_key.strip(),
        "Content-Type": "application/json",
    }
    url = f"{_BASE_URL}{endpoint}"
    with httpx.Client(timeout=30.0) as client:
        response = client.request(method, url, headers=headers, json=json_body, params=params)

    if response.status_code >= 400:
        detail = response.text[:500]
        try:
            data = response.json()
            if isinstance(data, dict):
                detail = str(data.get("error") or data.get("message") or detail)
        except Exception:
            pass
        code = "permission_denied" if response.status_code == 403 else "api_error"
        if response.status_code == 401:
            code = "invalid_api_key"
        raise PumbleApiError(detail or f"Pumble API error ({response.status_code})", code=code, status_code=response.status_code)

    if response.status_code == 204 or not response.content:
        return {}
    try:
        return response.json()
    except Exception:
        return {"raw": response.text}


async def _api_request(
    api_key: str,
    method: str,
    endpoint: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> Any:
    return await asyncio.to_thread(
        _sync_request,
        api_key,
        method,
        endpoint,
        json_body=json_body,
        params=params,
    )


async def verify_api_key(api_key: str) -> dict[str, Any]:
    """Validate API key via /myInfo."""
    key = (api_key or "").strip()
    if not key:
        raise ValueError("API key is required")
    try:
        data = await _api_request(key, "GET", "/myInfo")
    except PumbleApiError as e:
        if e.code == "invalid_api_key":
            raise ValueError("Invalid Pumble API key. Generate a new key in your workspace.") from e
        raise ValueError(str(e)) from e

    if not isinstance(data, dict):
        return {"valid": True}

    workspace_id = data.get("workspaceId") or data.get("workspace_id")
    user_name = data.get("name") or data.get("displayName") or data.get("username")
    return {
        "valid": True,
        "workspace_id": workspace_id,
        "user_name": user_name,
        "api_key_hint": mask_api_key(key),
    }


async def list_channels(api_key: str) -> list[dict[str, Any]]:
    """List non-DM channels visible to the API key owner."""
    key = (api_key or "").strip()
    if not key:
        raise ValueError("API key is required")
    try:
        data = await _api_request(key, "GET", "/listChannels")
    except PumbleApiError as e:
        raise ValueError(str(e)) from e
    return _parse_channels(data)


def _default_label(channel_name: str, workspace_id: str | None = None) -> str:
    ch = (channel_name or "channel").strip()
    if workspace_id:
        return f"{workspace_id} · #{ch}"
    return f"#{ch}"


def _serialize_integration(config: PumbleConfig, *, api_key_hint: str | None = None) -> dict[str, Any]:
    return {
        "id": config.id,
        "label": config.label or _default_label(config.channel_name, config.workspace_id),
        "channel_id": config.channel_id,
        "channel_name": config.channel_name,
        "workspace_id": config.workspace_id,
        "api_key_hint": api_key_hint,
        "is_enabled": bool(config.is_enabled),
        "auto_post_threshold": config.auto_post_threshold,
        "auto_post_filters": normalize_auto_post_filters(getattr(config, "auto_post_filters", None)),
        "parent_posted_date": config.parent_posted_date.isoformat() if config.parent_posted_date else None,
    }


async def list_user_configs(
    user_id: str,
    session: AsyncSession | None = None,
    *,
    enabled_only: bool = False,
) -> list[PumbleConfig]:
    async def _fetch(s: AsyncSession) -> list[PumbleConfig]:
        q = select(PumbleConfig).where(PumbleConfig.user_id == user_id).order_by(PumbleConfig.created_at)
        if enabled_only:
            q = q.where(PumbleConfig.is_enabled.is_(True))
        r = await s.execute(q)
        return list(r.scalars().all())

    if session:
        return await _fetch(session)
    async with get_session() as s:
        return await _fetch(s)


async def get_user_config(user_id: str, session: AsyncSession | None = None) -> PumbleConfig | None:
    """Backward-compatible: return the first enabled integration, else any."""
    configs = await list_user_configs(user_id, session)
    if not configs:
        return None
    for cfg in configs:
        if cfg.is_enabled:
            return cfg
    return configs[0]


async def get_config_by_id(
    user_id: str,
    config_id: str,
    session: AsyncSession | None = None,
) -> PumbleConfig | None:
    async def _fetch(s: AsyncSession) -> PumbleConfig | None:
        r = await s.execute(
            select(PumbleConfig).where(
                PumbleConfig.user_id == user_id,
                PumbleConfig.id == config_id,
            )
        )
        return r.scalar_one_or_none()

    if session:
        return await _fetch(session)
    async with get_session() as s:
        return await _fetch(s)


async def delete_user_config(user_id: str) -> bool:
    """Remove all Pumble integrations for the user."""
    async with get_session() as session:
        configs = await list_user_configs(user_id, session)
        if not configs:
            return False
        for config in configs:
            await session.delete(config)
        return True


async def delete_config_by_id(user_id: str, config_id: str) -> bool:
    async with get_session() as session:
        config = await get_config_by_id(user_id, config_id, session)
        if not config:
            return False
        await session.delete(config)
        return True


async def create_config(
    user_id: str,
    api_key: str,
    channel_id: str,
    channel_name: str,
    *,
    workspace_id: str | None = None,
    label: str | None = None,
    auto_post_threshold: int = 75,
) -> PumbleConfig:
    key = (api_key or "").strip()
    if not key:
        raise ValueError("API key is required")
    if not channel_id.strip():
        raise ValueError("Channel is required")

    await verify_api_key(key)
    channels = await list_channels(key)
    allowed_ids = {c["id"] for c in channels}
    if channel_id not in allowed_ids:
        raise ValueError("Selected channel is not accessible with this API key.")

    resolved_name = channel_name.strip()
    for ch in channels:
        if ch["id"] == channel_id:
            resolved_name = ch["name"]
            break

    async with get_session() as session:
        existing = await session.execute(
            select(PumbleConfig).where(
                PumbleConfig.user_id == user_id,
                PumbleConfig.channel_id == channel_id,
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError(f"Pumble destination for #{resolved_name} is already connected.")

        threshold = _clamp_auto_post_threshold(auto_post_threshold)
        config = PumbleConfig(
            id=str(uuid.uuid4()),
            user_id=user_id,
            label=(label or "").strip() or _default_label(resolved_name, workspace_id),
            api_key_encrypted=encrypt_secret(key),
            workspace_id=workspace_id,
            channel_id=channel_id,
            channel_name=resolved_name,
            is_enabled=True,
            auto_post_threshold=threshold,
        )
        session.add(config)
        await session.flush()
        return config


async def save_config(
    user_id: str,
    api_key: str,
    channel_id: str,
    channel_name: str,
    *,
    workspace_id: str | None = None,
    auto_post_threshold: int = 75,
) -> PumbleConfig:
    """Create a new Pumble destination (alias for create_config)."""
    return await create_config(
        user_id,
        api_key,
        channel_id,
        channel_name,
        workspace_id=workspace_id,
        auto_post_threshold=auto_post_threshold,
    )


async def update_auto_post_threshold(user_id: str, auto_post_threshold: int) -> list[PumbleConfig]:
    """Update auto-post threshold on all user integrations."""
    threshold = _clamp_auto_post_threshold(auto_post_threshold)
    async with get_session() as session:
        configs = await list_user_configs(user_id, session)
        if not configs:
            raise ValueError("Pumble integration is not configured")
        for config in configs:
            config.auto_post_threshold = threshold
        await session.flush()
        return configs


async def update_auto_post_settings(
    user_id: str,
    *,
    auto_post_threshold: int,
    auto_post_filters: dict | None = None,
) -> list[PumbleConfig]:
    """Update threshold + filters on every Pumble destination for the user."""
    threshold = _clamp_auto_post_threshold(auto_post_threshold)
    filters = normalize_auto_post_filters(auto_post_filters)
    async with get_session() as session:
        configs = await list_user_configs(user_id, session)
        if not configs:
            raise ValueError("Pumble integration is not configured")
        for config in configs:
            config.auto_post_threshold = threshold
            config.auto_post_filters = filters
        await session.flush()
        return configs


async def set_integration_enabled(user_id: str, integration_id: str, is_enabled: bool) -> PumbleConfig:
    """Soft-toggle one destination without deleting credentials / channel."""
    async with get_session() as session:
        config = await get_config_by_id(user_id, integration_id, session)
        if not config:
            raise ValueError("Pumble destination not found")
        config.is_enabled = bool(is_enabled)
        await session.flush()
        return config


async def set_all_enabled(user_id: str, is_enabled: bool) -> list[PumbleConfig]:
    """Soft-toggle auto-post on every destination without deleting connections."""
    async with get_session() as session:
        configs = await list_user_configs(user_id, session)
        if not configs:
            raise ValueError("Pumble integration is not configured")
        for config in configs:
            config.is_enabled = bool(is_enabled)
        await session.flush()
        return configs


def _decrypt_api_key(config: PumbleConfig) -> str:
    try:
        return decrypt_secret(config.api_key_encrypted)
    except ValueError as e:
        raise PumbleApiError("Stored Pumble API key could not be decrypted", code="config_error") from e


async def _fetch_thread_urls(api_key: str, channel_id: str, parent_message_id: str) -> set[str]:
    urls: set[str] = set()
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {
            "channelId": channel_id,
            "rootMessageId": parent_message_id,
            "limit": 100,
        }
        if cursor:
            params["cursor"] = cursor
        try:
            data = await _api_request(api_key, "GET", "/fetchThreadReplies", params=params)
        except PumbleApiError:
            break

        messages = data.get("messages", data) if isinstance(data, dict) else data
        if not isinstance(messages, list):
            break
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            url = _url_from_message_text(_message_text(msg))
            if url:
                urls.add(url)

        cursor = data.get("nextCursor") if isinstance(data, dict) else None
        if not cursor:
            break
    return urls


async def _create_parent_message(
    api_key: str,
    channel_id: str,
    posted_date: date,
) -> str:
    payload = {
        "channelId": channel_id,
        "text": _daily_parent_text(posted_date),
        "asBot": False,
    }
    data = await _api_request(api_key, "POST", "/sendMessage", json_body=payload)
    if not isinstance(data, dict):
        raise PumbleApiError("Unexpected response when creating daily parent message")
    message_id = _extract_message_id(data)
    if not message_id:
        raise PumbleApiError("Pumble did not return a message id for the daily parent message")
    return message_id


async def _ensure_daily_parent(
    config: PumbleConfig,
    api_key: str,
    session: AsyncSession,
) -> str:
    today = _today_utc()
    if config.parent_posted_date == today and config.parent_message_id:
        return config.parent_message_id

    message_id = await _create_parent_message(api_key, config.channel_id, today)
    config.parent_message_id = message_id
    config.parent_posted_date = today
    await session.flush()
    return message_id


async def _send_thread_reply(api_key: str, channel_id: str, parent_message_id: str, text: str) -> None:
    payload = {
        "channelId": channel_id,
        "messageId": parent_message_id,
        "text": text,
        "asBot": False,
    }
    await _api_request(api_key, "POST", "/sendReply", json_body=payload)


async def _distribute_jobs_to_config(
    session: AsyncSession,
    config: PumbleConfig,
    job_ids: list[str],
) -> dict:
    summary: dict = {
        "integration_id": config.id,
        "channel_id": config.channel_id,
        "channel_name": config.channel_name,
        "label": config.label or _default_label(config.channel_name, config.workspace_id),
        "posted": [],
        "failed": [],
        "skipped_already_in_thread": 0,
        "skipped_not_found": 0,
    }

    try:
        api_key = _decrypt_api_key(config)
    except PumbleApiError as e:
        logger.error("pumble_decrypt_failed", integration_id=config.id, error=str(e))
        summary["failed"].append({"error": str(e)})
        return summary

    try:
        parent_id = await _ensure_daily_parent(config, api_key, session)
    except PumbleApiError as e:
        logger.error("pumble_parent_message_failed", integration_id=config.id, error=str(e))
        summary["failed"].append({"error": str(e)})
        return summary

    existing_urls: set[str] = set()
    try:
        existing_urls = await _fetch_thread_urls(api_key, config.channel_id, parent_id)
    except Exception as e:
        logger.warning("pumble_fetch_thread_failed", integration_id=config.id, error=str(e))

    for job_id in job_ids:
        r = await session.execute(select(Job).where(Job.id == job_id))
        job = r.scalar_one_or_none()
        if not job:
            summary["skipped_not_found"] += 1
            continue

        url = _normalize_url(job.source_url or "")
        if not url:
            summary["skipped_not_found"] += 1
            continue

        if url in existing_urls:
            summary["skipped_already_in_thread"] += 1
            continue

        try:
            await _send_thread_reply(api_key, config.channel_id, parent_id, url)
        except PumbleApiError as e:
            if e.status_code in (403, 404):
                config.parent_message_id = None
                config.parent_posted_date = None
                await session.flush()
                try:
                    parent_id = await _ensure_daily_parent(config, api_key, session)
                    await _send_thread_reply(api_key, config.channel_id, parent_id, url)
                except PumbleApiError as retry_err:
                    summary["failed"].append({"job_id": job_id, "error": str(retry_err)})
                    logger.error(
                        "pumble_reply_retry_failed",
                        job_id=job_id,
                        integration_id=config.id,
                        error=str(retry_err),
                    )
                    continue
            else:
                summary["failed"].append({"job_id": job_id, "error": str(e)})
                logger.error(
                    "pumble_reply_failed",
                    job_id=job_id,
                    integration_id=config.id,
                    error=str(e),
                )
                continue

        existing_urls.add(url)
        summary["posted"].append({"job_id": job_id, "url": url, "parent_message_id": parent_id})
        logger.info(
            "pumble_job_posted",
            job_id=job_id,
            integration_id=config.id,
            channel_id=config.channel_id,
        )
        await asyncio.sleep(_REPLY_GAP)

    return summary


async def distribute_jobs(
    user_id: str,
    job_ids: list[str],
    integration_ids: list[str] | None = None,
) -> dict:
    """Post job URLs to one or more Pumble destinations."""
    aggregate: dict = {
        "posted": [],
        "failed": [],
        "skipped_already_in_thread": 0,
        "skipped_not_found": 0,
        "integrations": [],
    }

    async with get_session() as session:
        configs = await list_user_configs(user_id, session, enabled_only=True)
        if not configs:
            logger.warning("pumble_no_config", user_id=user_id)
            return aggregate

        if integration_ids:
            id_set = set(integration_ids)
            configs = [c for c in configs if c.id in id_set]
            if not configs:
                raise ValueError("No matching Pumble destinations found.")

        posted_job_ids: set[str] = set()

        for config in configs:
            result = await _distribute_jobs_to_config(session, config, job_ids)
            aggregate["integrations"].append(result)
            aggregate["skipped_already_in_thread"] += result["skipped_already_in_thread"]
            aggregate["skipped_not_found"] += result["skipped_not_found"]
            aggregate["posted"].extend(
                {**row, "integration_id": config.id, "channel_name": config.channel_name}
                for row in result["posted"]
            )
            aggregate["failed"].extend(
                {**row, "integration_id": config.id, "channel_name": config.channel_name}
                for row in result["failed"]
            )
            for row in result["posted"]:
                posted_job_ids.add(row["job_id"])

        if posted_job_ids:
            now = datetime.utcnow()
            for job_id in posted_job_ids:
                r = await session.execute(select(Job).where(Job.id == job_id))
                job = r.scalar_one_or_none()
                if job and not job.pumble_posted_at:
                    job.pumble_posted_at = now

        return aggregate


async def auto_post_if_eligible(user_id: str, job_id: str, match_score: int) -> None:
    """After match analysis, auto-post to all enabled Pumble destinations meeting threshold + filters."""
    try:
        configs = await list_user_configs(user_id, enabled_only=True)
        if not configs:
            return

        async with get_session() as session:
            job = (
                await session.execute(select(Job).where(Job.id == job_id))
            ).scalar_one_or_none()
            if not job:
                return

            eligible_ids: list[str] = []
            for c in configs:
                if match_score < (c.auto_post_threshold or 75):
                    continue
                filters = normalize_auto_post_filters(getattr(c, "auto_post_filters", None))
                if not job_matches_auto_post_filters(job, filters):
                    continue
                eligible_ids.append(c.id)

        if not eligible_ids:
            logger.info(
                "pumble_auto_post_no_eligible_destinations",
                job_id=job_id,
                score=match_score,
            )
            return
        result = await distribute_jobs(user_id, [job_id], integration_ids=eligible_ids)
        if result["posted"]:
            logger.info("pumble_auto_posted", job_id=job_id, destinations=len(eligible_ids))
    except Exception as e:
        logger.warning("pumble_auto_post_failed", job_id=job_id, error=str(e))
