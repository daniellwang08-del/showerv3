"""Aggregated endpoints for the Chrome extension side panel.

The side panel used to fan out to counts, weekly progress, sessions, scraper
stats and Pumble config on every refresh. ``GET /extension/home`` answers all of
that in one round trip, and ``revision`` lets the panel skip refetching lists
when nothing changed.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.assistant_routes import in_progress_sessions_query
from app.api.routes import (
    DashboardCountsResponse,
    WeeklyProgressResponse,
    _dashboard_revision_for_user,
    get_current_user,
    get_dashboard_counts,
    get_weekly_progress,
)
from app.core.logging import get_logger
from app.models.database import ApplicationSession
from app.storage.database import get_session

logger = get_logger(__name__)

extension_router = APIRouter(tags=["extension"])

IN_PROGRESS_PREVIEW = 20


class InProgressSession(BaseModel):
    job_id: str
    title: str | None = None
    company: str | None = None
    url: str | None = None
    updated_at: str | None = None


class ExtensionHomeResponse(BaseModel):
    revision: str
    counts: DashboardCountsResponse
    weekly: WeeklyProgressResponse | None = None
    in_progress_count: int = 0
    in_progress: list[InProgressSession] = Field(default_factory=list)
    pumble_configured: bool = False
    pumble_destinations: int = 0


async def _in_progress(user_id: str) -> tuple[int, list[InProgressSession]]:
    async with get_session() as session:
        base = in_progress_sessions_query(user_id)
        total = (
            await session.execute(select(func.count()).select_from(base.subquery()))
        ).scalar_one()
        rows = (
            await session.execute(
                base.order_by(ApplicationSession.updated_at.desc()).limit(IN_PROGRESS_PREVIEW)
            )
        ).scalars().all()
    items = [
        InProgressSession(
            job_id=s.job_id,
            title=s.job_title,
            company=s.company,
            url=s.job_url,
            updated_at=s.updated_at.isoformat() if s.updated_at else None,
        )
        for s in rows
    ]
    return int(total or 0), items


async def _revision(user_id: str) -> str:
    async with get_session() as session:
        revision, _total, _now = await _dashboard_revision_for_user(session, user_id)
    return revision


async def _pumble(user_id: str) -> int:
    from app.services.pumble_service import list_user_configs

    try:
        return len(await list_user_configs(user_id) or [])
    except Exception as e:
        logger.warning("extension_home_pumble_failed", user_id=user_id, error=str(e))
        return 0


@extension_router.get("/extension/home", response_model=ExtensionHomeResponse)
async def extension_home(
    timezone: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
) -> ExtensionHomeResponse:
    user_id = current_user["user_id"]
    counts, weekly, (in_progress_count, in_progress), revision, pumble = await asyncio.gather(
        get_dashboard_counts(
            q=None,
            title=None,
            company=None,
            source=None,
            remote_only=False,
            min_match_score=None,
            timezone=timezone,
            current_user=current_user,
        ),
        get_weekly_progress(timezone=timezone, days=7, current_user=current_user),
        _in_progress(user_id),
        _revision(user_id),
        _pumble(user_id),
    )
    return ExtensionHomeResponse(
        revision=revision,
        counts=counts,
        weekly=weekly,
        in_progress_count=in_progress_count,
        in_progress=in_progress,
        pumble_configured=pumble > 0,
        pumble_destinations=pumble,
    )


@extension_router.get("/extension/revision")
async def extension_revision(current_user: dict = Depends(get_current_user)) -> dict:
    """Cheap change fingerprint for the fallback poll when the WebSocket is down."""
    return {"revision": await _revision(current_user["user_id"])}
