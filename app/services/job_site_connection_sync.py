"""Per-user job-site connections: pluginable boards synced into the pipeline.

Users connect a catalog plugin (API key, session cookies, or enable-only public
feed). Periodic sync fetches listings through the plugin and feeds URLs into
the same extract → analyze path as ATS job sources.

Each connection carries a lifecycle status. A rejected session or key stops
polling until the user reconnects; throttles and quotas wait for the board's
reset time; transient failures back off exponentially.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import or_, select

from app.core.logging import get_logger
from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.errors import (
    ConnectionConfigError,
    QuotaExhausted,
    RateLimited,
    SessionExpired,
)
from app.job_sites.registry import get_plugin
from app.models.database import User, UserJobSiteConnection
from app.services.country_catalog import normalize_country_preferences
from app.services.job_pipeline_mode import (
    manual_submit_enqueue_flags,
    normalize_manual_submit_pipeline,
)
from app.services.job_source_sync import MAX_NEW_JOBS_PER_SYNC, ingest_board_jobs
from app.services.signup_approval_service import can_use_app
from app.storage.database import get_session
from app.utils.secret_encryption import decrypt_secret, encrypt_secret

logger = get_logger(__name__)

SYNC_INTERVAL_HOURS = 6
MAX_BACKOFF_HOURS = 48
# Consecutive transient failures before the card shows "needs attention".
ERROR_AFTER_FAILURES = 3
DEFAULT_RATE_LIMIT_WAIT = timedelta(minutes=30)

STATUS_CONNECTED = "connected"
STATUS_NEEDS_REAUTH = "needs_reauth"
STATUS_RATE_LIMITED = "rate_limited"
STATUS_QUOTA_EXHAUSTED = "quota_exhausted"
STATUS_ERROR = "error"
# Statuses the scheduler keeps polling once next_sync_at is reached.
RUNNABLE_STATUSES = (STATUS_CONNECTED, STATUS_RATE_LIMITED, STATUS_QUOTA_EXHAUSTED, STATUS_ERROR)

FAILURE_AUTH = "auth"
FAILURE_RATE_LIMITED = "rate_limited"
FAILURE_QUOTA = "quota"
FAILURE_CONFIG = "config"
FAILURE_TRANSIENT = "transient"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def sync_interval(plugin: JobSitePlugin | None) -> timedelta:
    hours = max(SYNC_INTERVAL_HOURS, plugin.min_sync_hours) if plugin else SYNC_INTERVAL_HOURS
    return timedelta(hours=hours)


def classify_failure(exc: Exception) -> str:
    if isinstance(exc, SessionExpired):
        return FAILURE_AUTH
    if isinstance(exc, QuotaExhausted):
        return FAILURE_QUOTA
    if isinstance(exc, RateLimited):
        return FAILURE_RATE_LIMITED
    if isinstance(exc, ConnectionConfigError):
        return FAILURE_CONFIG
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403):
            return FAILURE_AUTH
        if code == 429:
            return FAILURE_RATE_LIMITED
        if code in (400, 404, 405, 410):
            return FAILURE_CONFIG
        return FAILURE_TRANSIENT
    if isinstance(exc, PermissionError):
        return FAILURE_AUTH
    if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError):
        return FAILURE_CONFIG
    return FAILURE_TRANSIENT


def _retry_after_seconds(exc: Exception) -> float | None:
    if isinstance(exc, RateLimited):
        return exc.retry_after_seconds
    if isinstance(exc, httpx.HTTPStatusError):
        raw = exc.response.headers.get("retry-after")
        try:
            return max(0.0, float(raw)) if raw else None
        except ValueError:
            return None
    return None


def failure_schedule(
    kind: str,
    exc: Exception,
    *,
    failures: int,
    interval: timedelta,
    now: datetime,
) -> tuple[str, datetime | None]:
    """(status, next_sync_at) after a failed fetch. ``failures`` includes this one."""
    if kind == FAILURE_AUTH:
        return STATUS_NEEDS_REAUTH, None
    if kind == FAILURE_CONFIG:
        return STATUS_ERROR, None
    if kind == FAILURE_QUOTA:
        resets_at = exc.resets_at if isinstance(exc, QuotaExhausted) else None
        return STATUS_QUOTA_EXHAUSTED, resets_at
    if kind == FAILURE_RATE_LIMITED:
        wait = _retry_after_seconds(exc)
        delay = timedelta(seconds=wait) if wait else DEFAULT_RATE_LIMIT_WAIT
        return STATUS_RATE_LIMITED, now + min(delay, timedelta(hours=MAX_BACKOFF_HOURS))
    backoff = min(interval * (2 ** max(0, failures - 1)), timedelta(hours=MAX_BACKOFF_HOURS))
    status = STATUS_ERROR if failures >= ERROR_AFTER_FAILURES else STATUS_CONNECTED
    return status, now + backoff


def lifetime_cap_reached(plugin: JobSitePlugin | None, request_count: int) -> bool:
    cap = plugin.lifetime_request_cap if plugin else 0
    return bool(cap) and request_count >= cap


def _lifetime_cap_error(plugin: JobSitePlugin) -> QuotaExhausted:
    return QuotaExhausted(
        f"This {plugin.name} key has used all {plugin.lifetime_request_cap} requests its free plan "
        "allows. Request a new key from the site, then reconnect."
    )


# Public feeds return the same listing for everyone with the same filters, so
# one fetch per TTL serves every user and keeps us inside the board's poll limits.
_public_feed_cache: dict[tuple, tuple[float, list]] = {}


async def _fetch_public_cached(plugin: JobSitePlugin, credentials: dict, ctx: FetchContext):
    key = (plugin.slug, ctx.country_codes, ctx.max_jobs)
    ttl = max(SYNC_INTERVAL_HOURS, plugin.min_sync_hours) * 3600
    hit = _public_feed_cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return list(hit[1])
    listing = await plugin.fetch(credentials, ctx)
    _public_feed_cache[key] = (time.monotonic(), list(listing))
    return listing


async def _publish_status(user_id: str, plugin: JobSitePlugin | None, slug: str, status: str, message: str) -> None:
    from app.api.websocket import publish_ws_event

    try:
        await publish_ws_event({
            "type": "job_site_status",
            "user_id": user_id,
            "plugin_slug": slug,
            "plugin_name": plugin.name if plugin else slug,
            "status": status,
            "message": message,
        })
    except Exception as e:
        logger.warning("job_site_status_publish_failed", plugin_slug=slug, error=str(e))


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
        cookies = credentials.get("cookies")
        n = len(cookies) if isinstance(cookies, list) else 0
        if n:
            hints["cookies"] = f"{n} cookies"
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
        raise ConnectionConfigError(reason)
    if plugin.fetch is None:
        raise ConnectionConfigError(f"{plugin.name} cannot fetch listings.")
    if plugin.auth_type == AuthType.API_KEY:
        missing = [
            field.label
            for field in plugin.credential_fields
            if field.required
            and not str(credentials.get(field.key) or "").strip()
            and not (field.key == "email" and ctx.user_email)
        ]
        if missing:
            raise ConnectionConfigError(f"Missing: {', '.join(missing)}")
    if plugin.auth_type == AuthType.NONE:
        return await _fetch_public_cached(plugin, credentials, ctx)
    return await plugin.fetch(credentials, ctx)


async def _load_row(session, connection_id: str) -> UserJobSiteConnection | None:
    return (
        await session.execute(
            select(UserJobSiteConnection).where(UserJobSiteConnection.id == connection_id)
        )
    ).scalar_one_or_none()


async def _record_failure(
    connection_id: str,
    plugin: JobSitePlugin | None,
    exc: Exception,
    *,
    counted_request: bool,
) -> dict:
    kind = classify_failure(exc)
    error_text = describe_fetch_error(exc)[:500]
    now = _now()
    notify: tuple[str, str] | None = None
    async with get_session() as session:
        row = await _load_row(session, connection_id)
        if row is None:
            return {"connection_id": connection_id, "status": "missing"}
        previous = row.status
        failures = (row.consecutive_failures or 0) + 1
        status, next_at = failure_schedule(
            kind, exc, failures=failures, interval=sync_interval(plugin), now=now
        )
        row.last_synced_at = now
        row.last_error = error_text
        row.consecutive_failures = failures
        row.status = status
        row.next_sync_at = next_at
        if counted_request:
            row.request_count = (row.request_count or 0) + 1
        # Alert once per transition into a state only the user can fix.
        if status != previous and (
            status == STATUS_NEEDS_REAUTH or (status == STATUS_QUOTA_EXHAUSTED and next_at is None)
        ):
            notify = (row.user_id, row.plugin_slug)
    if notify:
        await _publish_status(notify[0], plugin, notify[1], status, error_text)
    logger.warning(
        "job_site_connection_fetch_failed",
        connection_id=connection_id,
        plugin_slug=plugin.slug if plugin else None,
        failure=kind,
        status=status,
        next_sync_at=next_at.isoformat() if next_at else None,
        error=error_text,
    )
    return {
        "connection_id": connection_id,
        "status": "fetch_failed",
        "failure": kind,
        "connection_status": status,
        "error": error_text,
    }


async def sync_user_job_site_connection(connection_id: str) -> dict:
    async with get_session() as session:
        row = await _load_row(session, connection_id)
        if row is None:
            return {"connection_id": connection_id, "status": "missing"}
        user = (
            await session.execute(select(User).where(User.id == row.user_id))
        ).scalar_one_or_none()
        if not can_use_app(user):
            return {"connection_id": connection_id, "status": "user_inactive"}
        plugin_slug = row.plugin_slug
        user_id = row.user_id
        request_count = row.request_count or 0
        try:
            credentials = decrypt_credentials(row.credentials_encrypted)
        except Exception as e:
            row.last_synced_at = _now()
            row.last_error = f"Could not decrypt credentials: {e}"[:500]
            row.status = STATUS_NEEDS_REAUTH
            row.next_sync_at = None
            return {"connection_id": connection_id, "status": "decrypt_failed"}
        pipeline = normalize_manual_submit_pipeline(
            getattr(user, "manual_submit_pipeline", None)
        )
        ctx = fetch_context_for_user(user)

    _uid, chain_analysis, skip_phase_b = manual_submit_enqueue_flags(
        pipeline, is_admin=False, user_id=user_id
    )

    plugin = get_plugin(plugin_slug)
    if lifetime_cap_reached(plugin, request_count):
        return await _record_failure(
            connection_id, plugin, _lifetime_cap_error(plugin), counted_request=False
        )
    counts_request = bool(plugin and plugin.lifetime_request_cap)
    try:
        listing = await verify_and_fetch(plugin_slug, credentials, ctx)
    except Exception as e:
        return await _record_failure(connection_id, plugin, e, counted_request=counts_request)

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

    now = _now()
    async with get_session() as session:
        row = await _load_row(session, connection_id)
        if row is not None:
            row.last_synced_at = now
            row.last_success_at = now
            row.last_error = None
            row.status = STATUS_CONNECTED
            row.consecutive_failures = 0
            row.next_sync_at = now + sync_interval(plugin)
            row.last_listing_count = len(listing)
            row.last_new_jobs = counts["created"]
            if counts_request:
                row.request_count = (row.request_count or 0) + 1

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
    now = _now()
    async with get_session() as session:
        rows = await session.execute(
            select(UserJobSiteConnection.id)
            .where(
                UserJobSiteConnection.enabled.is_(True),
                UserJobSiteConnection.status.in_(RUNNABLE_STATUSES),
                or_(
                    UserJobSiteConnection.next_sync_at <= now,
                    (UserJobSiteConnection.next_sync_at.is_(None))
                    & (UserJobSiteConnection.status == STATUS_CONNECTED),
                ),
            )
            .order_by(UserJobSiteConnection.next_sync_at.asc().nulls_first())
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
