"""Interview pipeline API. Every route except the overview needs a connected mailbox."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app.api.routes import get_current_user, require_applicant
from app.services import interview_service, mail_applications, nylas_service
from app.storage.database import get_session

router = APIRouter(prefix="/interviews", tags=["interviews"], dependencies=[Depends(require_applicant)])

Stage = Literal["applied", "screening", "assessment", "interviewing", "final", "offer", "rejected", "withdrawn"]
EventKind = Literal[
    "recruiter_screen",
    "assessment",
    "technical",
    "behavioral",
    "hiring_manager",
    "onsite",
    "final",
    "offer",
    "rejection",
    "scheduling",
    "application_received",
    "other",
]
EventStatus = Literal["scheduled", "needs_scheduling", "action_required", "completed", "cancelled", "info"]


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class SyncRequest(BaseModel):
    timezone: str | None = Field(default=None, max_length=64)


class ProcessCreate(BaseModel):
    company: str = Field(..., min_length=1, max_length=300)
    role_title: str | None = Field(default=None, max_length=300)
    stage: Stage = "screening"
    notes: str | None = Field(default=None, max_length=4000)


class ProcessUpdate(BaseModel):
    company: str | None = Field(default=None, min_length=1, max_length=300)
    role_title: str | None = Field(default=None, max_length=300)
    stage: Stage | None = None
    status: Literal["active", "closed"] | None = None
    next_step: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=4000)


class EventCreate(BaseModel):
    kind: EventKind
    status: EventStatus | None = None
    title: str | None = Field(default=None, max_length=300)
    scheduled_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=5, le=600)
    meeting_url: str | None = Field(default=None, max_length=1000)
    location: str | None = Field(default=None, max_length=500)
    summary: str | None = Field(default=None, max_length=1000)

    @field_validator("scheduled_at")
    @classmethod
    def _utc(cls, v: datetime | None) -> datetime | None:
        return _naive_utc(v)


class EventUpdate(BaseModel):
    kind: EventKind | None = None
    status: EventStatus | None = None
    title: str | None = Field(default=None, max_length=300)
    scheduled_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=5, le=600)
    meeting_url: str | None = Field(default=None, max_length=1000)
    location: str | None = Field(default=None, max_length=500)

    @field_validator("scheduled_at")
    @classmethod
    def _utc(cls, v: datetime | None) -> datetime | None:
        return _naive_utc(v)


async def _require_connection(session, user_id: str):
    conn = await nylas_service.get_connection(session, user_id)
    if conn is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect your email first")
    return conn


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")


@router.get("")
async def get_interviews(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        conn = await nylas_service.get_connection(session, user_id)
        processes = await interview_service.list_processes(session, user_id, conn) if conn else []
    return {
        "server": nylas_service.server_status(),
        "connection": nylas_service.connection_public(conn),
        "processes": processes,
        "summary": interview_service.summarize(processes),
    }


@router.get("/applications")
async def get_mail_applications(
    days: int = Query(30, ge=1, le=31),
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
    current_user: dict = Depends(get_current_user),
):
    """Applications counted from confirmation emails, for the Insights chart."""
    user_id = current_user["user_id"]
    async with get_session() as session:
        conn = await nylas_service.get_connection(session, user_id)
        data = await mail_applications.overview(session, user_id, conn, tz_name=timezone_name, days=days)
    data["server"] = nylas_service.server_status()
    return data


@router.post("/sync", status_code=status.HTTP_202_ACCEPTED)
async def sync_interviews(
    body: SyncRequest, background: BackgroundTasks, current_user: dict = Depends(get_current_user)
):
    user_id = current_user["user_id"]
    async with get_session() as session:
        conn = await _require_connection(session, user_id)
        if conn.status == nylas_service.STATUS_NEEDS_REAUTH:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Reconnect your email to sync")
        started = await interview_service.mark_sync_started(session, conn)
    if started:
        background.add_task(interview_service.run_sync, user_id, body.timezone)
    return {"started": started}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_interview(body: ProcessCreate, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        await _require_connection(session, user_id)
        row = await interview_service.create_process(session, user_id, **body.model_dump())
    return {"id": row.id}


@router.patch("/{process_id}")
async def update_interview(process_id: str, body: ProcessUpdate, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        await _require_connection(session, user_id)
        try:
            await interview_service.update_process(session, user_id, process_id, body.model_dump(exclude_unset=True))
        except interview_service.InterviewNotFound as e:
            raise _not_found() from e
    return {"success": True}


@router.delete("/{process_id}")
async def delete_interview(process_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        await _require_connection(session, user_id)
        try:
            await interview_service.delete_process(session, user_id, process_id)
        except interview_service.InterviewNotFound as e:
            raise _not_found() from e
    return {"success": True}


@router.post("/{process_id}/events", status_code=status.HTTP_201_CREATED)
async def add_interview_event(process_id: str, body: EventCreate, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        await _require_connection(session, user_id)
        try:
            row = await interview_service.add_event(session, user_id, process_id, body.model_dump())
        except interview_service.InterviewNotFound as e:
            raise _not_found() from e
    return {"id": row.id}


@router.patch("/events/{event_id}")
async def update_interview_event(event_id: str, body: EventUpdate, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        await _require_connection(session, user_id)
        try:
            await interview_service.update_event(session, user_id, event_id, body.model_dump(exclude_unset=True))
        except interview_service.InterviewNotFound as e:
            raise _not_found() from e
    return {"success": True}


@router.delete("/events/{event_id}")
async def delete_interview_event(event_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        await _require_connection(session, user_id)
        try:
            await interview_service.delete_event(session, user_id, event_id)
        except interview_service.InterviewNotFound as e:
            raise _not_found() from e
    return {"success": True}
