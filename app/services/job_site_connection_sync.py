"""Per-user job-site connections: pluginable boards synced into the pipeline.

Users connect a catalog plugin (API key, session cookies, or enable-only public
feed). Periodic sync fetches listings through the plugin and feeds URLs into
the same extract → analyze path as ATS job sources.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select

from app.core.logging import get_logger
from app.job_sites.base import AuthType, FetchContext
from app.job_sites.registry import get_plugin
from app.models.database import User, UserJobSiteConnection
from app.services.country_catalog import normalize_country_preferences
from app.services.job_pipeline_mode import (
    manual_submit_enqueue_flags,
    normalize_manual_submit_pipeline,
)
from app.services.job_source_sync import MAX_NEW_JOBS_PER_SYNC, ingest_board_jobs
from app.storage.database import get_session
from app.utils.secret_encryption import decrypt_secret, encrypt_secret

logger = get_logger(__name__)

SYNC_INTERVAL_HOURS = 6


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def encrypt_credentials(payload: dict) -> str:
    return encrypt_secret(json.dumps(payload, separators=(",", ":")))


def decrypt_credentials(token: str | None) -> dict:
    if not token:
        return {}
    raw = decrypt_secret(token)
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


def describe_fetch_error(exc: Exception) -> str:
    """User-facing reason for a failed board fetch.

    httpx errors embed the request URL, which carries query-string API keys for
    some boards, so they must never be echoed to the client, stored, or logged.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403):
            return f"the site rejected these credentials ({code}). Check the values and try again."
        if code == 429:
            return "the site is rate limiting requests (429). Try again in a few minutes."
        return f"the site responded with HTTP {code}."
    if isinstance(exc, httpx.TimeoutException):
        return "the site took too long to respond."
    if isinstance(exc, httpx.RequestError):
        return "the site could not be reached."
    return str(exc) or type(exc).__name__


def credential_hints(plugin_slug: str, credentials: dict) -> dict[str, str]:
    """Non-secret labels so the UI can show that keys/cookies are stored."""
    from app.utils.secret_encryption import mask_api_key

    plugin = get_plugin(plugin_slug)
    hints: dict[str, str] = {}
    if not plugin:
        return hints
    if plugin.auth_type == AuthType.ACCOUNT:
        email = str(credentials.get("email") or "").strip()
        if email:
            hints["email"] = email
        if credentials.get("password"):
            hints["password"] = "••••••••"
        cookies = credentials.get("cookies")
        n = len(cookies) if isinstance(cookies, list) else 0
        if n:
            hints["cookies"] = f"{n} cookies"
        if credentials.get("cookie_header"):
            hints["cookie_header"] = "pasted"
        storage = credentials.get("storage")
        if isinstance(storage, dict) and storage:
            keys = sum(len(v) for v in storage.values() if isinstance(v, dict))
            if keys:
                hints["storage"] = f"{keys} keys"
        if n and not credentials.get("password"):
            hints["session"] = "captured from browser"
        return hints
    for field in plugin.credential_fields:
        value = str(credentials.get(field.key) or "").strip()
        if not value:
            continue
        hints[field.key] = mask_api_key(value) if field.secret else value
    return hints


def fetch_context_for_user(user: User) -> FetchContext:
    countries = normalize_country_preferences(getattr(user, "country_preferences", None) or [])
    return FetchContext(
        user_email=str(getattr(user, "email", "") or ""),
        country_codes=tuple(countries),
        max_jobs=MAX_NEW_JOBS_PER_SYNC + 10,
    )


async def verify_and_fetch(plugin_slug: str, credentials: dict, ctx: FetchContext):
    plugin = get_plugin(plugin_slug)
    if plugin is None or not plugin.connectable:
        reason = (
            plugin.unavailable_reason
            if plugin
            else f"Unknown job site: {plugin_slug}"
        )
        raise ValueError(reason)
    if plugin.fetch is None:
        raise ValueError(f"{plugin.name} cannot fetch listings.")
    if plugin.auth_type in (AuthType.API_KEY, AuthType.ACCOUNT):
        missing = []
        for field in plugin.credential_fields:
            if str(credentials.get(field.key) or "").strip():
                continue
            if field.key == "email" and ctx.user_email:
                continue
            # Account plugins may supply cookies from a prior connect instead of
            # the paste/password fields on every sync.
            if plugin.auth_type == AuthType.ACCOUNT and (
                isinstance(credentials.get("cookies"), list)
                and credentials.get("cookies")
            ):
                continue
            missing.append(field.label)
        if missing and plugin.auth_type == AuthType.API_KEY:
            raise ValueError(f"Missing: {', '.join(missing)}")
        if missing and plugin.auth_type == AuthType.ACCOUNT:
            # Only require fields when there is no usable session material yet.
            if not (
                isinstance(credentials.get("cookies"), list) and credentials.get("cookies")
            ):
                raise ValueError(f"Missing: {', '.join(missing)}")
    return await plugin.fetch(credentials, ctx)


async def sync_user_job_site_connection(connection_id: str) -> dict:
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.id == connection_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return {"connection_id": connection_id, "status": "missing"}
        user = (
            await session.execute(select(User).where(User.id == row.user_id))
        ).scalar_one_or_none()
        if user is None or not user.is_active:
            return {"connection_id": connection_id, "status": "user_inactive"}
        plugin_slug = row.plugin_slug
        user_id = row.user_id
        try:
            credentials = decrypt_credentials(row.credentials_encrypted)
        except Exception as e:
            row.last_synced_at = _now()
            row.last_error = f"Could not decrypt credentials: {e}"[:500]
            return {"connection_id": connection_id, "status": "decrypt_failed"}
        pipeline = normalize_manual_submit_pipeline(
            getattr(user, "manual_submit_pipeline", None)
        )
        ctx = fetch_context_for_user(user)

    _uid, chain_analysis, skip_phase_b = manual_submit_enqueue_flags(
        pipeline, is_admin=False, user_id=user_id
    )

    plugin = get_plugin(plugin_slug)
    try:
        listing = await verify_and_fetch(plugin_slug, credentials, ctx)
    except Exception as e:
        error_text = describe_fetch_error(e)[:500]
        async with get_session() as session:
            row = (
                await session.execute(
                    select(UserJobSiteConnection).where(
                        UserJobSiteConnection.id == connection_id
                    )
                )
            ).scalar_one_or_none()
            if row is not None:
                row.last_synced_at = _now()
                row.last_error = error_text
        logger.warning(
            "job_site_connection_fetch_failed",
            connection_id=connection_id,
            plugin_slug=plugin_slug,
            error=error_text,
        )
        return {
            "connection_id": connection_id,
            "status": "fetch_failed",
            "error": error_text,
        }

    counts = await ingest_board_jobs(
        listing,
        user_id=user_id,
        scraped_source=plugin_slug,
        company_fallback=plugin.name if plugin else plugin_slug,
        extra_meta={
            "user_job_site": {
                "connection_id": connection_id,
                "user_id": user_id,
                "plugin_slug": plugin_slug,
            },
        },
        chain_analysis=chain_analysis,
        skip_phase_b=skip_phase_b,
    )

    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.id == connection_id
                )
            )
        ).scalar_one_or_none()
        if row is not None:
            row.last_synced_at = _now()
            row.last_error = None
            row.last_listing_count = len(listing)
            row.last_new_jobs = counts["created"]
            # Account plugins may refresh cookies during fetch (Jobright re-login).
            try:
                row.credentials_encrypted = encrypt_credentials(credentials)
            except Exception:
                pass

    logger.info(
        "job_site_connection_synced",
        connection_id=connection_id,
        plugin_slug=plugin_slug,
        listings=len(listing),
        **counts,
    )
    return {
        "connection_id": connection_id,
        "status": "synced",
        "listings": len(listing),
        **counts,
    }


async def sync_due_job_site_connections() -> dict:
    cutoff = _now() - timedelta(hours=SYNC_INTERVAL_HOURS)
    async with get_session() as session:
        rows = await session.execute(
            select(UserJobSiteConnection.id).where(
                UserJobSiteConnection.enabled.is_(True),
                (UserJobSiteConnection.last_synced_at.is_(None))
                | (UserJobSiteConnection.last_synced_at < cutoff),
            )
        )
        due_ids = [row[0] for row in rows.all()]

    results = {"due": len(due_ids), "synced": 0, "failed": 0}
    for connection_id in due_ids:
        try:
            outcome = await sync_user_job_site_connection(connection_id)
            if outcome.get("status") == "synced":
                results["synced"] += 1
            else:
                results["failed"] += 1
        except Exception as e:
            results["failed"] += 1
            logger.warning(
                "job_site_connection_sync_failed",
                connection_id=connection_id,
                error=describe_fetch_error(e),
            )
    if due_ids:
        logger.info("job_site_connections_sync_pass_complete", **results)
    return results
