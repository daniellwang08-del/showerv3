"""Conversational agent API.

A single streaming endpoint powers the in-app AI assistant. It runs an agentic
loop (plan → call tools → observe → answer) and streams progress as Server-Sent
Events so the UI can show tool activity, results, confirmation prompts and the
final reply in real time.

Events (JSON per ``data:`` line):
- {"type":"tool_call","tool","title","args"}        a tool is about to run
- {"type":"tool_result","tool","ok","summary","data"} a tool finished
- {"type":"refresh","targets":[...]}                 client caches to reload
- {"type":"confirm","tool","args","summary","title"} a change needs approval
- {"type":"message","text"}                          final assistant reply
- {"type":"done"}                                    turn complete
- {"type":"error","message"}                         turn failed

Conversation history is supplied by the client (kept client-side), so the
endpoint is stateless and requires no schema changes.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.routes import get_current_user
from app.core.logging import get_logger
from app.services.agent import run_agent_turn

agent_router = APIRouter(prefix="/agent", tags=["agent"])
logger = get_logger(__name__)

MAX_MESSAGE_CHARS = 4000
MAX_HISTORY_TURNS = 24


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


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False, default=str)}\n\n"


@agent_router.post("/chat")
async def agent_chat(req: AgentChatRequest, current_user: dict = Depends(get_current_user)):
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
            ):
                if event.get("type") in {"done", "error"}:
                    saw_terminal = True
                yield _sse(event)
        except Exception as exc:  # noqa: BLE001 - surface a clean SSE error
            logger.warning("agent_chat_failed", user_id=user_id, error=str(exc)[:300])
            yield _sse({"type": "error", "message": "The assistant is temporarily unavailable. Please try again."})
            saw_terminal = True
        if not saw_terminal:
            yield _sse({"type": "done"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
