"""User job-site connections: pluginable boards (API keys / account / public feeds)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.routes import get_current_user
from app.core.logging import get_logger
from app.job_sites.base import AuthType, FetchContext
from app.job_sites.registry import get_plugin, list_plugins
from app.models.database import User, UserJobSiteConnection
from app.services.job_site_connection_sync import (
    credential_hints,
    decrypt_credentials,
    encrypt_credentials,
    fetch_context_for_user,
    verify_and_fetch,
)
from app.storage.database import get_session

logger = get_logger(__name__)

router = APIRouter(prefix="/job-sites", tags=["job-sites"])


class JobSiteConnectRequest(BaseModel):
    credentials: dict = Field(default_factory=dict)
    cookies: list[dict] | None = None


class JobSiteUpdateRequest(BaseModel):
    enabled: bool | None = None


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


def _to_response(row: UserJobSiteConnection, hints: dict[str, str] | None = None) -> JobSiteConnectionResponse:
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
        return False


def _merge_credentials(plugin, body: JobSiteConnectRequest) -> dict:
    creds = dict(body.credentials or {})
    if body.cookies is not None:
        creds["cookies"] = body.cookies
    if plugin.auth_type == AuthType.NONE:
        return {}
    return creds


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
        connections = [_to_response(row) for row in rows]
    return JobSiteCatalogResponse(
        plugins=[p.catalog_dict() for p in list_plugins()],
        connections=connections,
    )


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
    try:
        listing = await verify_and_fetch(plugin.slug, credentials, ctx)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(e)) from e
    except Exception as e:
        logger.warning("job_site_connect_verify_failed", slug=plugin.slug, error=str(e))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not fetch jobs from {plugin.name}: {e}",
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
        existing.last_listing_count = len(listing)
        await session.flush()
        response = _to_response(existing, hints)
        connection_id = existing.id

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
            row.enabled = bool(body.enabled)
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
        connection_id = row.id

    enqueued = await _enqueue_connection_sync(connection_id)
    if not enqueued:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Job queue unavailable. Retry when Redis and workers are healthy.",
        )
    return {"enqueued": True}
