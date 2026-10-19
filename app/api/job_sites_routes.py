"""User job-site connections: pluginable boards (API keys / account / public feeds)."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.routes import get_current_user
from app.core.logging import get_logger
from app.job_sites.base import AuthType, FetchContext
from app.job_sites.registry import get_plugin, list_plugins
from app.models.database import User, UserJobSiteConnection
from app.services.job_source_boards import BoardJob
from app.services.job_site_connection_sync import (
    STATUS_CONNECTED,
    STATUS_NEEDS_REAUTH,
    STATUS_QUOTA_EXHAUSTED,
    STATUS_RATE_LIMITED,
    claim_browser_sync_tasks,
    credential_hints,
    decrypt_credentials,
    connection_sync_activity,
    describe_fetch_error,
    encrypt_credentials,
    fetch_context_for_user,
    ingest_browser_results,
    lifetime_cap_reached,
    verify_and_fetch,
)
from app.storage.database import get_session

logger = get_logger(__name__)

router = APIRouter(prefix="/job-sites", tags=["job-sites"])

VERIFY_MAX_JOBS = 3


class JobSiteConnectRequest(BaseModel):
    credentials: dict = Field(default_factory=dict)
    cookies: list[dict] | None = None
    # Browser-session connect (extension capture): localStorage / sessionStorage
    # snapshot from the signed-in page. Boards that keep a bearer token outside
    # cookies need it; it is encrypted alongside the cookies.
    storage: dict | None = None


class JobSiteUpdateRequest(BaseModel):
    enabled: bool | None = None


class JobSiteSyncActivity(BaseModel):
    plugin_slug: str
    plugin_name: str
    # queued | fetching | analyzing
    phase: str
    total: int = 0
    done: int = 0
    started_at: str | None = None


class JobSiteConnectionResponse(BaseModel):
    id: str
    plugin_slug: str
    enabled: bool
    last_synced_at: str | None
    last_error: str | None
    last_listing_count: int | None
    last_new_jobs: int | None
    credential_hints: dict[str, str]
    created_at: str | None
    status: str = "connected"
    consecutive_failures: int = 0
    next_sync_at: str | None = None
    last_success_at: str | None = None
    request_count: int = 0
    sync: JobSiteSyncActivity | None = None


class JobSiteCatalogResponse(BaseModel):
    plugins: list[dict]
    connections: list[JobSiteConnectionResponse]


def _require_user_id(current_user: dict) -> str:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    return user_id


def _activity_response(row: UserJobSiteConnection, activity: dict | None) -> JobSiteSyncActivity | None:
    if not activity:
        return None
    plugin = get_plugin(row.plugin_slug)
    started = activity.get("started_at")
    return JobSiteSyncActivity(
        plugin_slug=row.plugin_slug,
        plugin_name=plugin.name if plugin else row.plugin_slug,
        phase=activity["phase"],
        total=activity.get("total", 0),
        done=activity.get("done", 0),
        started_at=started.isoformat() if started else None,
    )


def _to_response(
    row: UserJobSiteConnection,
    hints: dict[str, str] | None = None,
    activity: dict | None = None,
) -> JobSiteConnectionResponse:
    if hints is None:
        try:
            hints = credential_hints(row.plugin_slug, decrypt_credentials(row.credentials_encrypted))
        except Exception:
            hints = {}
    return JobSiteConnectionResponse(
        id=row.id,
        plugin_slug=row.plugin_slug,
        enabled=bool(row.enabled),
        last_synced_at=row.last_synced_at.isoformat() if row.last_synced_at else None,
        last_error=row.last_error,
        last_listing_count=row.last_listing_count,
        last_new_jobs=row.last_new_jobs,
        credential_hints=hints,
        created_at=row.created_at.isoformat() if row.created_at else None,
        status=row.status or STATUS_CONNECTED,
        consecutive_failures=row.consecutive_failures or 0,
        next_sync_at=row.next_sync_at.isoformat() if row.next_sync_at else None,
        last_success_at=row.last_success_at.isoformat() if row.last_success_at else None,
        request_count=row.request_count or 0,
        sync=_activity_response(row, activity),
    )


async def _user_fetch_context(user_id: str) -> FetchContext:
    async with get_session() as session:
        user = (
            await session.execute(select(User).where(User.id == user_id))
        ).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=404, detail="User not found")
        return fetch_context_for_user(user)


async def _enqueue_connection_sync(connection_id: str) -> bool:
    await _mark_queued(connection_id, True)
    try:
        from app.core.redis_support import pipeline_job_id
        from app.tasks.worker import get_scraper_pool

        pool = await get_scraper_pool()
        await pool.enqueue_job(
            "sync_user_job_site_connections_task",
            connection_id,
            _job_id=pipeline_job_id("jsitesync", connection_id, "one"),
        )
        return True
    except Exception as e:
        logger.warning(
            "job_site_connection_enqueue_failed",
            connection_id=connection_id,
            error=str(e),
        )
        await _mark_queued(connection_id, False)
        return False


def _merge_credentials(plugin, body: JobSiteConnectRequest) -> dict:
    creds = dict(body.credentials or {})
    if body.cookies is not None:
        creds["cookies"] = body.cookies
    if body.storage:
        creds["storage"] = _trim_storage(body.storage)
    if plugin.auth_type in (AuthType.NONE, AuthType.BROWSER):
        return plugin.settings_from(creds)
    return creds


async def _prior_request_count(user_id: str, plugin, credentials: dict) -> int:
    """Lifetime requests already spent by this exact key; a new key starts at 0."""
    if not plugin.lifetime_request_cap:
        return 0
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.user_id == user_id,
                    UserJobSiteConnection.plugin_slug == plugin.slug,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return 0
        try:
            stored = decrypt_credentials(row.credentials_encrypted)
        except Exception:
            return 0
    same_key = all(
        str(stored.get(f.key) or "").strip() == str(credentials.get(f.key) or "").strip()
        for f in plugin.credential_fields
        if f.secret
    )
    return (row.request_count or 0) if same_key else 0


MAX_STORAGE_CHARS = 100_000


def _trim_storage(storage: dict) -> dict:
    """Keep the captured web-storage snapshot small enough to encrypt/store."""
    out: dict[str, dict[str, str]] = {}
    budget = MAX_STORAGE_CHARS
    for bucket in ("localStorage", "sessionStorage"):
        items = storage.get(bucket)
        if not isinstance(items, dict):
            continue
        kept: dict[str, str] = {}
        for key, value in items.items():
            text = "" if value is None else str(value)
            cost = len(str(key)) + len(text)
            if cost > budget:
                continue
            budget -= cost
            kept[str(key)] = text
        if kept:
            out[bucket] = kept
    return out



@router.get("", response_model=JobSiteCatalogResponse)
async def list_job_sites(
    current_user: dict = Depends(get_current_user),
) -> JobSiteCatalogResponse:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        rows = (
            (
                await session.execute(
                    select(UserJobSiteConnection)
                    .where(UserJobSiteConnection.user_id == user_id)
                    .order_by(UserJobSiteConnection.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        activity = await connection_sync_activity(session, list(rows))
        connections = [_to_response(row, activity=activity.get(row.id)) for row in rows]
    return JobSiteCatalogResponse(
        plugins=[p.catalog_dict() for p in list_plugins()],
        connections=connections,
    )


@router.get("/activity", response_model=list[JobSiteSyncActivity])
async def job_site_sync_activity(
    current_user: dict = Depends(get_current_user),
) -> list[JobSiteSyncActivity]:
    """Syncs still running for this user (fetching listings or scoring new jobs)."""
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        rows = (
            (
                await session.execute(
                    select(UserJobSiteConnection).where(
                        UserJobSiteConnection.user_id == user_id,
                        UserJobSiteConnection.enabled.is_(True),
                    )
                )
            )
            .scalars()
            .all()
        )
        activity = await connection_sync_activity(session, list(rows))
        out = [_activity_response(row, activity.get(row.id)) for row in rows]
    return [item for item in out if item is not None]


async def _mark_queued(connection_id: str, queued: bool) -> None:
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(UserJobSiteConnection.id == connection_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return
        if queued and row.sync_phase == "fetching":
            return
        if queued:
            row.sync_phase = "queued"
            row.sync_started_at = datetime.now(timezone.utc).replace(tzinfo=None)
        elif row.sync_phase == "queued":
            row.sync_phase = None


@router.post("/{slug}/connect", response_model=JobSiteConnectionResponse)
async def connect_job_site(
    slug: str,
    body: JobSiteConnectRequest,
    current_user: dict = Depends(get_current_user),
) -> JobSiteConnectionResponse:
    user_id = _require_user_id(current_user)
    plugin = get_plugin(slug)
    if plugin is None:
        raise HTTPException(status_code=404, detail="Unknown job site")
    if not plugin.connectable:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=plugin.unavailable_reason or "This job site cannot be connected.",
        )

    ctx = await _user_fetch_context(user_id)
    credentials = _merge_credentials(plugin, body)
    prior_requests = await _prior_request_count(user_id, plugin, credentials)
    if lifetime_cap_reached(plugin, prior_requests):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"This {plugin.name} key has used all {plugin.lifetime_request_cap} requests "
                "its free plan allows. Request a new key from the site."
            ),
        )
    browser = plugin.auth_type == AuthType.BROWSER
    if plugin.auth_type == AuthType.NONE:
        # Public feeds only need proof the search works; the queued sync pulls the full listing.
        ctx = replace(ctx, max_jobs=VERIFY_MAX_JOBS)
    try:
        listing = [] if browser else await verify_and_fetch(plugin.slug, credentials, ctx)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    except PermissionError as e:
        # The *job board* rejected the captured session, this is NOT about the
        # user's NAO session. Returning 401 here made the dashboard's
        # global axios interceptor treat the caller as signed out and bounce
        # them to the NAO login page. Use 422 so a downstream auth failure
        # can never masquerade as an NAO auth failure.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)
        ) from e
    except Exception as e:
        reason = describe_fetch_error(e)
        logger.warning("job_site_connect_verify_failed", slug=plugin.slug, error=reason)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not fetch jobs from {plugin.name}: {reason}",
        ) from e

    encrypted = encrypt_credentials(credentials) if credentials else None
    hints = credential_hints(plugin.slug, credentials)

    async with get_session() as session:
        existing = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.user_id == user_id,
                    UserJobSiteConnection.plugin_slug == plugin.slug,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            existing = UserJobSiteConnection(
                user_id=user_id,
                plugin_slug=plugin.slug,
                enabled=True,
            )
            session.add(existing)
        existing.credentials_encrypted = encrypted
        existing.enabled = True
        existing.last_error = None
        existing.last_listing_count = None if browser else len(listing)
        existing.status = STATUS_CONNECTED
        existing.consecutive_failures = 0
        existing.next_sync_at = None
        existing.request_count = prior_requests + (1 if plugin.lifetime_request_cap else 0)
        if browser:
            existing.sync_phase = None
        await session.flush()
        response = _to_response(existing, hints)
        connection_id = existing.id

    if not browser:
        await _enqueue_connection_sync(connection_id)
    logger.info(
        "job_site_connected",
        user_id=user_id,
        plugin_slug=plugin.slug,
        connection_id=connection_id,
        listings=len(listing),
    )
    return response


@router.patch("/{slug}", response_model=JobSiteConnectionResponse)
async def update_job_site(
    slug: str,
    body: JobSiteUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> JobSiteConnectionResponse:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.user_id == user_id,
                    UserJobSiteConnection.plugin_slug == slug,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Not connected")
        if body.enabled is not None:
            turning_on = bool(body.enabled) and not row.enabled
            row.enabled = bool(body.enabled)
            if turning_on and row.status not in (STATUS_NEEDS_REAUTH, STATUS_QUOTA_EXHAUSTED):
                row.status = STATUS_CONNECTED
                row.next_sync_at = None
        await session.flush()
        return _to_response(row)


@router.delete("/{slug}")
async def disconnect_job_site(
    slug: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.user_id == user_id,
                    UserJobSiteConnection.plugin_slug == slug,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Not connected")
        await session.delete(row)
    logger.info("job_site_disconnected", user_id=user_id, plugin_slug=slug)
    return {"deleted": True}


@router.post("/{slug}/sync")
async def sync_job_site_now(
    slug: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSiteConnection).where(
                    UserJobSiteConnection.user_id == user_id,
                    UserJobSiteConnection.plugin_slug == slug,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Not connected")
        if not row.enabled:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Enable the connection before syncing.",
            )
        if row.status == STATUS_NEEDS_REAUTH:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Reconnect this site before syncing.",
            )
        plugin = get_plugin(slug)
        if plugin is not None and plugin.auth_type == AuthType.BROWSER:
            # The extension picks this up on its next poll; a manual run also
            # retries after a security check the user may have just passed.
            row.next_sync_at = None
            row.status = STATUS_CONNECTED
            if row.sync_phase != "fetching":
                row.sync_phase = None
            return {"enqueued": True, "browser": True}
        if row.status in (STATUS_RATE_LIMITED, STATUS_QUOTA_EXHAUSTED) and (
            row.next_sync_at is None or row.next_sync_at > datetime.now(timezone.utc).replace(tzinfo=None)
        ):
            when = f" until {row.next_sync_at.isoformat()}Z" if row.next_sync_at else ""
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"The site's request limit is reached; syncing is paused{when}.",
            )
        connection_id = row.id

    enqueued = await _enqueue_connection_sync(connection_id)
    if not enqueued:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Job queue unavailable. Retry when Redis and workers are healthy.",
        )
    return {"enqueued": True}


MAX_BROWSER_JOBS = 60


class BrowserJob(BaseModel):
    url: str = Field(max_length=2000)
    title: str = Field(default="", max_length=500)
    company: str = Field(default="", max_length=300)
    location: str = Field(default="", max_length=300)
    description: str = Field(default="", max_length=60_000)
    source_url: str = Field(default="", max_length=2000)


class BrowserResultsRequest(BaseModel):
    jobs: list[BrowserJob] = Field(default_factory=list, max_length=MAX_BROWSER_JOBS)
    error: str | None = Field(default=None, max_length=500)
    blocked: bool = False


@router.get("/browser-tasks")
async def job_site_browser_tasks(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Boards due for a sync that the extension reads in the user's browser."""
    user_id = _require_user_id(current_user)
    return {"tasks": await claim_browser_sync_tasks(user_id)}


@router.post("/{slug}/browser-results")
async def job_site_browser_results(
    slug: str,
    body: BrowserResultsRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = _require_user_id(current_user)
    jobs = [
        BoardJob(
            url=j.url.strip(),
            title=j.title.strip(),
            company=j.company.strip(),
            location=j.location.strip(),
            description=j.description.strip(),
            source_url=j.source_url.strip(),
        )
        for j in body.jobs
        if j.url.strip().startswith(("https://", "http://"))
    ]
    try:
        result = await ingest_browser_results(
            user_id, slug, jobs, error=body.error, blocked=body.blocked
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    if result.get("status") == "missing":
        raise HTTPException(status_code=404, detail="Not connected")
    return result
