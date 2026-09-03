"""Per-user job sources API: register ATS boards to auto-pull postings from.

Users add a Greenhouse/Lever/Ashby/Workable board URL; the scraper worker
syncs it periodically (and on demand) into their pipeline.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.routes import get_current_user
from app.core.logging import get_logger
from app.models.database import UserJobSource
from app.services.job_source_boards import SUPPORTED_ATS, detect_board
from app.services.job_source_sync import MAX_SOURCES_PER_USER
from app.storage.database import get_session

logger = get_logger(__name__)

router = APIRouter(prefix="/job-sources", tags=["job-sources"])


class JobSourceCreateRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2000)
    name: str | None = Field(default=None, max_length=200)


class JobSourceUpdateRequest(BaseModel):
    enabled: bool | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)


class JobSourceResponse(BaseModel):
    id: str
    url: str
    name: str
    ats_type: str
    board_token: str
    enabled: bool
    last_synced_at: str | None
    last_error: str | None
    last_listing_count: int | None
    last_new_jobs: int | None
    created_at: str | None


class JobSourceListResponse(BaseModel):
    sources: list[JobSourceResponse]
    supported_ats: list[str]
    max_sources: int


def _to_response(row: UserJobSource) -> JobSourceResponse:
    return JobSourceResponse(
        id=row.id,
        url=row.url,
        name=row.name,
        ats_type=row.ats_type,
        board_token=row.board_token,
        enabled=bool(row.enabled),
        last_synced_at=row.last_synced_at.isoformat() if row.last_synced_at else None,
        last_error=row.last_error,
        last_listing_count=row.last_listing_count,
        last_new_jobs=row.last_new_jobs,
        created_at=row.created_at.isoformat() if row.created_at else None,
    )


def _require_user_id(current_user: dict) -> str:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    return user_id


async def _enqueue_source_sync(source_id: str) -> bool:
    try:
        from app.core.redis_support import pipeline_job_id
        from app.tasks.worker import get_scraper_pool

        pool = await get_scraper_pool()
        await pool.enqueue_job(
            "sync_user_job_sources_task",
            source_id,
            _job_id=pipeline_job_id("srcsync", source_id, "one"),
        )
        return True
    except Exception as e:
        logger.warning(
            "job_source_sync_enqueue_failed", source_id=source_id, error=str(e)
        )
        return False


@router.get("", response_model=JobSourceListResponse)
async def list_job_sources(
    current_user: dict = Depends(get_current_user),
) -> JobSourceListResponse:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        rows = (
            (
                await session.execute(
                    select(UserJobSource)
                    .where(UserJobSource.user_id == user_id)
                    .order_by(UserJobSource.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        return JobSourceListResponse(
            sources=[_to_response(row) for row in rows],
            supported_ats=list(SUPPORTED_ATS),
            max_sources=MAX_SOURCES_PER_USER,
        )


@router.post("", response_model=JobSourceResponse, status_code=status.HTTP_201_CREATED)
async def create_job_source(
    body: JobSourceCreateRequest,
    current_user: dict = Depends(get_current_user),
) -> JobSourceResponse:
    user_id = _require_user_id(current_user)

    board = detect_board(body.url)
    if board is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Unsupported job board URL. Supported: Greenhouse "
                "(boards.greenhouse.io/company), Lever (jobs.lever.co/company), "
                "Ashby (jobs.ashbyhq.com/company), and Workable "
                "(apply.workable.com/company)."
            ),
        )

    async with get_session() as session:
        count = (
            await session.execute(
                select(func.count(UserJobSource.id)).where(
                    UserJobSource.user_id == user_id
                )
            )
        ).scalar_one()
        if int(count or 0) >= MAX_SOURCES_PER_USER:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"You can register at most {MAX_SOURCES_PER_USER} job sources.",
            )

        duplicate = (
            await session.execute(
                select(UserJobSource).where(
                    UserJobSource.user_id == user_id,
                    UserJobSource.ats_type == board.ats_type,
                    UserJobSource.board_token == board.token,
                )
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"This board is already registered as \"{duplicate.name}\".",
            )

        name = (body.name or "").strip() or board.token.replace("-", " ").title()
        row = UserJobSource(
            user_id=user_id,
            url=body.url.strip(),
            name=name,
            ats_type=board.ats_type,
            board_token=board.token,
            enabled=True,
        )
        session.add(row)
        await session.flush()
        response = _to_response(row)
        source_id = row.id

    # First sync right away so the user sees jobs without waiting for cron.
    await _enqueue_source_sync(source_id)
    logger.info(
        "job_source_created",
        user_id=user_id,
        source_id=source_id,
        ats_type=board.ats_type,
        token=board.token,
    )
    return response


@router.patch("/{source_id}", response_model=JobSourceResponse)
async def update_job_source(
    source_id: str,
    body: JobSourceUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> JobSourceResponse:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSource).where(
                    UserJobSource.id == source_id,
                    UserJobSource.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Job source not found")
        if body.enabled is not None:
            row.enabled = bool(body.enabled)
        if body.name is not None and body.name.strip():
            row.name = body.name.strip()
        await session.flush()
        return _to_response(row)


@router.delete("/{source_id}")
async def delete_job_source(
    source_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSource).where(
                    UserJobSource.id == source_id,
                    UserJobSource.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Job source not found")
        await session.delete(row)
    logger.info("job_source_deleted", user_id=user_id, source_id=source_id)
    return {"deleted": True}


@router.post("/{source_id}/sync")
async def sync_job_source_now(
    source_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = _require_user_id(current_user)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSource).where(
                    UserJobSource.id == source_id,
                    UserJobSource.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Job source not found")
        if not row.enabled:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Enable the source before syncing.",
            )

    enqueued = await _enqueue_source_sync(source_id)
    if not enqueued:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Job queue unavailable. Retry when Redis and workers are healthy.",
        )
    return {"enqueued": True}
