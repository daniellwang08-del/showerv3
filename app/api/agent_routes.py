"""Conversational agent API.

A single streaming endpoint powers the in-app AI assistant. It runs an agentic
loop (plan → call tools → observe → answer) and streams progress as Server-Sent
Events so the UI can show tool activity, results, confirmation prompts and the
final reply in real time.

Events (JSON per ``data:`` line):
- {"type":"tool_call","tool","title","args"}        a tool is about to run
- {"type":"progress","tool","label","steps"?,"expected_seconds"?} a long tool's stage
- {"type":"tool_result","tool","ok","summary","data"} a tool finished
- {"type":"refresh","targets":[...]}                 client caches to reload
- {"type":"confirm","tool","args","summary","title"} a change needs approval
- {"type":"message","text"}                          final assistant reply
- {"type":"done"}                                    turn complete
- {"type":"error","message"}                         turn failed

The chat endpoint is stateless: the client sends the conversation history.
Conversations are saved separately under /agent/sessions (the rendered
timeline per chat) and kept until the user deletes them.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import defer

from app.api.routes import require_applicant
from app.core.llm_client import llm_failure_message
from app.core.logging import get_logger
from app.models.database import AgentChatSession
from app.services.agent import run_agent_turn
from app.services.agent.base import visible_tools
from app.storage.database import get_session

agent_router = APIRouter(prefix="/agent", tags=["agent"])
logger = get_logger(__name__)

# Large enough for a full pasted job description (same cap as /documents/tailor).
MAX_MESSAGE_CHARS = 40_000
MAX_HISTORY_TURNS = 24

MAX_SESSION_ITEMS = 1000
MAX_SESSION_BYTES = 2_000_000
MAX_TITLE_CHARS = 80
SESSION_ITEM_KINDS = {"user", "assistant", "tool", "confirm", "error"}
DEFAULT_TITLE = "New chat"


class AgentTurn(BaseModel):
    role: str
    content: str


class ConfirmedAction(BaseModel):
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)


class AgentChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)
    history: list[AgentTurn] = Field(default_factory=list)
    timezone: str | None = None
    confirmed: ConfirmedAction | None = None
    # Tool the user picked in the composer's tools menu; the planner acts with it.
    tool: str | None = Field(default=None, max_length=64)


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False, default=str)}\n\n"


@agent_router.post("/chat")
async def agent_chat(req: AgentChatRequest, current_user: dict = Depends(require_applicant)):
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    history = [{"role": t.role, "content": t.content} for t in req.history[-MAX_HISTORY_TURNS:]]
    confirmed = req.confirmed.model_dump() if req.confirmed else None

    async def event_stream():
        saw_terminal = False
        try:
            async for event in run_agent_turn(
                user_id=user_id,
                message=req.message,
                history=history,
                timezone=req.timezone,
                confirmed=confirmed,
                is_admin=False,
                selected_tool=req.tool,
            ):
                if event.get("type") in {"done", "error"}:
                    saw_terminal = True
                yield _sse(event)
        except Exception as exc:  # noqa: BLE001 - surface a clean SSE error
            logger.warning("agent_chat_failed", user_id=user_id, error=str(exc)[:300])
            yield _sse({"type": "error", "message": llm_failure_message(exc)})
            saw_terminal = True
        if not saw_terminal:
            yield _sse({"type": "done"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


class AgentToolInfo(BaseModel):
    name: str
    label: str
    category: str
    description: str
    example: str
    requires_confirmation: bool


@agent_router.get("/tools", response_model=list[AgentToolInfo])
async def list_agent_tools(current_user: dict = Depends(require_applicant)) -> list[AgentToolInfo]:
    """What the assistant can do for this user, for the composer's tools menu."""
    return [
        AgentToolInfo(
            name=spec.name,
            label=spec.label or spec.running_title,
            category=spec.category,
            description=spec.description,
            example=spec.example,
            requires_confirmation=spec.requires_confirmation,
        )
        for spec in visible_tools(is_admin=False)
    ]


# ---------------------------------------------------------------------------
# Saved chats
# ---------------------------------------------------------------------------


class AgentSessionSummary(BaseModel):
    id: str
    title: str
    item_count: int
    created_at: datetime
    updated_at: datetime


class AgentSessionDetail(AgentSessionSummary):
    items: list[dict[str, Any]]


class AgentSessionSave(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list)
    title: str | None = Field(default=None, max_length=200)


class AgentSessionRename(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _user_id(current_user: dict) -> str:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return str(user_id)


def _session_id(raw: str) -> str:
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found") from None


def _clean_title(text: str) -> str:
    title = re.sub(r"\s+", " ", text or "").strip()
    if len(title) > MAX_TITLE_CHARS:
        title = title[: MAX_TITLE_CHARS - 3].rstrip() + "..."
    return title


def _title_from_items(items: list[dict[str, Any]]) -> str:
    for item in items:
        if item.get("kind") == "user" and isinstance(item.get("text"), str):
            title = _clean_title(item["text"])
            if title:
                return title
    return DEFAULT_TITLE


def _validate_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(items) > MAX_SESSION_ITEMS:
        items = items[-MAX_SESSION_ITEMS:]
    for item in items:
        if not isinstance(item.get("id"), str) or item.get("kind") not in SESSION_ITEM_KINDS:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid chat item")
    if len(json.dumps(items, ensure_ascii=False, default=str)) > MAX_SESSION_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Chat is too large to save")
    return items


def _summary(row: AgentChatSession) -> AgentSessionSummary:
    return AgentSessionSummary(
        id=row.id,
        title=row.title,
        item_count=row.item_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _owned_session(session, user_id: str, session_id: str) -> AgentChatSession:
    row = await session.get(AgentChatSession, session_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return row


@agent_router.get("/sessions", response_model=list[AgentSessionSummary])
async def list_agent_sessions(
    limit: int = Query(200, ge=1, le=500),
    current_user: dict = Depends(require_applicant),
) -> list[AgentSessionSummary]:
    user_id = _user_id(current_user)
    async with get_session() as session:
        rows = (
            await session.execute(
                select(AgentChatSession)
                .options(defer(AgentChatSession.items))
                .where(AgentChatSession.user_id == user_id)
                .order_by(AgentChatSession.updated_at.desc())
                .limit(limit)
            )
        ).scalars().all()
    return [_summary(r) for r in rows]


@agent_router.get("/sessions/{session_id}", response_model=AgentSessionDetail)
async def get_agent_session(session_id: str, current_user: dict = Depends(require_applicant)) -> AgentSessionDetail:
    user_id = _user_id(current_user)
    async with get_session() as session:
        row = await _owned_session(session, user_id, _session_id(session_id))
        return AgentSessionDetail(**_summary(row).model_dump(), items=list(row.items or []))


@agent_router.put("/sessions/{session_id}", response_model=AgentSessionSummary)
async def save_agent_session(
    session_id: str,
    body: AgentSessionSave,
    current_user: dict = Depends(require_applicant),
) -> AgentSessionSummary:
    """Create or replace a chat. The client picks the id so it can save the
    first turn without waiting for a round trip."""
    user_id = _user_id(current_user)
    sid = _session_id(session_id)
    items = _validate_items(body.items)
    explicit_title = _clean_title(body.title) if body.title else ""
    now = _utcnow()
    async with get_session() as session:
        existing = await session.get(AgentChatSession, sid)
        if existing is not None and existing.user_id != user_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
        if explicit_title:
            title = explicit_title
        elif existing is not None and existing.title != DEFAULT_TITLE:
            title = existing.title
        else:
            title = _title_from_items(items)
        stmt = pg_insert(AgentChatSession).values(
            id=sid,
            user_id=user_id,
            title=title,
            items=items,
            item_count=len(items),
            created_at=now,
            updated_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[AgentChatSession.id],
            set_={"title": title, "items": items, "item_count": len(items), "updated_at": now},
            where=AgentChatSession.user_id == user_id,
        )
        await session.execute(stmt)
        await session.commit()
        row = await _owned_session(session, user_id, sid)
        await session.refresh(row)
        return _summary(row)


@agent_router.patch("/sessions/{session_id}", response_model=AgentSessionSummary)
async def rename_agent_session(
    session_id: str,
    body: AgentSessionRename,
    current_user: dict = Depends(require_applicant),
) -> AgentSessionSummary:
    user_id = _user_id(current_user)
    title = _clean_title(body.title)
    if not title:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Title is required")
    async with get_session() as session:
        row = await _owned_session(session, user_id, _session_id(session_id))
        row.title = title
        await session.commit()
        await session.refresh(row)
        return _summary(row)


@agent_router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent_session(session_id: str, current_user: dict = Depends(require_applicant)) -> Response:
    user_id = _user_id(current_user)
    sid = _session_id(session_id)
    async with get_session() as session:
        result = await session.execute(
            sa_delete(AgentChatSession).where(AgentChatSession.id == sid, AgentChatSession.user_id == user_id)
        )
        await session.commit()
    if not result.rowcount:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
