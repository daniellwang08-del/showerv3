"""Admin system logs API — query persisted structured logs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.routes import require_admin
from app.core.logging import get_logger
from app.models.database import SystemLogEvent
from app.services.log_sink import purge_old_logs
from app.storage.database import get_session

logger = get_logger(__name__)

router = APIRouter(prefix="/admin/logs", tags=["admin-logs"])


class LogEventOut(BaseModel):
    id: str
    created_at: str | None
    level: str
    event: str
    logger_name: str | None = None
    category: str
    service: str
    request_id: str | None = None
    user_id: str | None = None
    job_id: str | None = None
    extraction_id: str | None = None
    worker_job_type: str | None = None
    method: str | None = None
    path: str | None = None
    status_code: int | None = None
    duration_ms: float | None = None
    client_ip: str | None = None
    message: str | None = None
    payload: dict | None = None


class LogListResponse(BaseModel):
    items: list[LogEventOut]
    total: int
    page: int
    per_page: int
    pages: int


class LogStatsResponse(BaseModel):
    window_hours: int
    total: int
    by_level: dict[str, int]
    by_category: dict[str, int]
    by_service: dict[str, int]
    error_rate: float
    top_paths: list[dict]
    retention_days: int


def _iso(dt: datetime | None) -> str | None:
    if not dt:
        return None
    return dt.isoformat()


def _to_out(row: SystemLogEvent) -> LogEventOut:
    return LogEventOut(
        id=row.id,
        created_at=_iso(row.created_at),
        level=row.level,
        event=row.event,
        logger_name=row.logger_name,
        category=row.category,
        service=row.service,
        request_id=row.request_id,
        user_id=row.user_id,
        job_id=row.job_id,
        extraction_id=row.extraction_id,
        worker_job_type=row.worker_job_type,
        method=row.method,
        path=row.path,
        status_code=row.status_code,
        duration_ms=row.duration_ms,
        client_ip=row.client_ip,
        message=row.message,
        payload=row.payload if isinstance(row.payload, dict) else None,
    )


def _parse_since(since: str | None, hours: int) -> datetime:
    if since:
        try:
            return datetime.fromisoformat(since.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Invalid since timestamp: {e}") from e
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=max(1, min(hours, 24 * 30)))


@router.get("", response_model=LogListResponse)
async def list_logs(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    level: str | None = None,
    category: str | None = None,
    service: str | None = None,
    request_id: str | None = None,
    path_contains: str | None = None,
    event_contains: str | None = None,
    user_id: str | None = None,
    job_id: str | None = None,
    hours: int = Query(24, ge=1, le=720),
    since: str | None = None,
    current_user: dict = Depends(require_admin),
) -> LogListResponse:
    cutoff = _parse_since(since, hours)
    filters = [SystemLogEvent.created_at >= cutoff]
    if level:
        filters.append(SystemLogEvent.level == level.strip().lower())
    if category:
        filters.append(SystemLogEvent.category == category.strip().lower())
    if service:
        filters.append(SystemLogEvent.service == service.strip().lower())
    if request_id:
        filters.append(SystemLogEvent.request_id == request_id.strip())
    if user_id:
        filters.append(SystemLogEvent.user_id == user_id.strip())
    if job_id:
        filters.append(SystemLogEvent.job_id == job_id.strip())
    if path_contains:
        filters.append(SystemLogEvent.path.ilike(f"%{path_contains.strip()}%"))
    if event_contains:
        filters.append(SystemLogEvent.event.ilike(f"%{event_contains.strip()}%"))

    async with get_session() as session:
        total = (
            await session.execute(select(func.count(SystemLogEvent.id)).where(*filters))
        ).scalar_one()
        pages = max(1, (int(total) + per_page - 1) // per_page)
        page = min(page, pages)
        rows = (
            (
                await session.execute(
                    select(SystemLogEvent)
                    .where(*filters)
                    .order_by(SystemLogEvent.created_at.desc())
                    .offset((page - 1) * per_page)
                    .limit(per_page)
                )
            )
            .scalars()
            .all()
        )
        return LogListResponse(
            items=[_to_out(r) for r in rows],
            total=int(total or 0),
            page=page,
            per_page=per_page,
            pages=pages,
        )


@router.get("/request/{request_id}", response_model=list[LogEventOut])
async def request_timeline(
    request_id: str,
    current_user: dict = Depends(require_admin),
) -> list[LogEventOut]:
    rid = request_id.strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with get_session() as session:
        rows = (
            (
                await session.execute(
                    select(SystemLogEvent)
                    .where(SystemLogEvent.request_id == rid)
                    .order_by(SystemLogEvent.created_at.asc())
                    .limit(500)
                )
            )
            .scalars()
            .all()
        )
        return [_to_out(r) for r in rows]


@router.get("/job/{job_id}", response_model=list[LogEventOut])
async def job_timeline(
    job_id: str,
    hours: int = Query(72, ge=1, le=720),
    current_user: dict = Depends(require_admin),
) -> list[LogEventOut]:
    """Chronological log timeline for one job (match analysis, extract, encode, …)."""
    jid = job_id.strip()
    if not jid:
        raise HTTPException(status_code=400, detail="job_id required")
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        hours=max(1, min(hours, 720))
    )
    async with get_session() as session:
        rows = (
            (
                await session.execute(
                    select(SystemLogEvent)
                    .where(
                        SystemLogEvent.job_id == jid,
                        SystemLogEvent.created_at >= cutoff,
                    )
                    .order_by(SystemLogEvent.created_at.asc())
                    .limit(500)
                )
            )
            .scalars()
            .all()
        )
        return [_to_out(r) for r in rows]


@router.get("/stats", response_model=LogStatsResponse)
async def log_stats(
    hours: int = Query(24, ge=1, le=720),
    current_user: dict = Depends(require_admin),
) -> LogStatsResponse:
    from app.core.config import get_settings

    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
    async with get_session() as session:
        total = (
            await session.execute(
                select(func.count(SystemLogEvent.id)).where(SystemLogEvent.created_at >= cutoff)
            )
        ).scalar_one()

        by_level_rows = (
            await session.execute(
                select(SystemLogEvent.level, func.count(SystemLogEvent.id))
                .where(SystemLogEvent.created_at >= cutoff)
                .group_by(SystemLogEvent.level)
            )
        ).all()
        by_cat_rows = (
            await session.execute(
                select(SystemLogEvent.category, func.count(SystemLogEvent.id))
                .where(SystemLogEvent.created_at >= cutoff)
                .group_by(SystemLogEvent.category)
            )
        ).all()
        by_svc_rows = (
            await session.execute(
                select(SystemLogEvent.service, func.count(SystemLogEvent.id))
                .where(SystemLogEvent.created_at >= cutoff)
                .group_by(SystemLogEvent.service)
            )
        ).all()
        top_paths = (
            await session.execute(
                select(SystemLogEvent.path, func.count(SystemLogEvent.id).label("n"))
                .where(
                    SystemLogEvent.created_at >= cutoff,
                    SystemLogEvent.path.is_not(None),
                    SystemLogEvent.category == "http",
                )
                .group_by(SystemLogEvent.path)
                .order_by(func.count(SystemLogEvent.id).desc())
                .limit(10)
            )
        ).all()

        errors = sum(n for lvl, n in by_level_rows if lvl in ("error", "critical"))
        total_i = int(total or 0)
        return LogStatsResponse(
            window_hours=hours,
            total=total_i,
            by_level={str(k): int(v) for k, v in by_level_rows},
            by_category={str(k): int(v) for k, v in by_cat_rows},
            by_service={str(k): int(v) for k, v in by_svc_rows},
            error_rate=round((errors / total_i) * 100, 2) if total_i else 0.0,
            top_paths=[{"path": p, "count": int(n)} for p, n in top_paths if p],
            retention_days=int(get_settings().log_retention_days or 14),
        )


class PurgeRequest(BaseModel):
    days: int | None = Field(default=None, ge=1, le=365)


@router.post("/purge")
async def purge_logs(
    body: PurgeRequest | None = None,
    current_user: dict = Depends(require_admin),
) -> dict:
    days = body.days if body else None
    deleted = await purge_old_logs(days=days)
    logger.info(
        "system_logs_purged",
        deleted=deleted,
        days=days,
        by=current_user.get("user_id"),
        category="system",
    )
    return {"deleted": deleted}
