"""Agentic planning loop.

Uses the provider-agnostic LLM client in JSON mode to drive a ReAct-style loop:
the model emits a single JSON object that either calls a tool or returns a final
message. Tool results are fed back as observations until the model answers or the
iteration budget is exhausted.

The loop yields plain dict events; the API layer serialises them as SSE.

Confirmation flow
-----------------
When the planner picks a tool flagged ``requires_confirmation`` and the request
did not pre-approve it, the loop emits a ``confirm`` event and ends the turn. The
client renders a confirm/cancel card; on confirm it re-sends the turn with
``confirmed={"tool", "args"}`` so the loop executes that step directly (bypassing
the gate once) and then continues planning.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import re
from collections.abc import AsyncIterator
from typing import Any

from app.core.config import get_settings
from app.core.llm_client import (
    chat_completion_with_empty_retry,
    get_llm_client_for_user,
    llm_failure_message,
)
from app.core.logging import get_logger
from app.services.agent.base import ToolContext, catalog_prompt, get_tool

logger = get_logger(__name__)

MAX_ITERATIONS = 6
MAX_HISTORY_TURNS = 12
# Earlier turns can be whole pasted job descriptions; the tools read those from
# ToolContext, so the planner only needs the gist.
MAX_HISTORY_TURN_CHARS = 6000
PLANNER_MAX_TOKENS = 700
OBSERVATION_DATA_LIMIT = 1800
# nginx drops an upstream that sends nothing for 60 s; tailoring takes longer.
HEARTBEAT_SECONDS = 15.0


def _system_prompt(*, is_admin: bool = False) -> str:
    return (
        "You are the in-app AI assistant for a job-search platform. You help the "
        "signed-in user by calling tools to search their jobs and perform actions on "
        "their behalf. Every tool acts only for this authenticated user.\n\n"
        "AVAILABLE TOOLS:\n"
        f"{catalog_prompt(is_admin=is_admin)}\n\n"
        "RESPONSE FORMAT - reply with a SINGLE JSON object, no markdown fences, "
        "matching ONE of:\n"
        '  1. Call a tool:  {"thought": "...", "action": {"tool": "<name>", "args": {...}}}\n'
        '  2. Final answer: {"thought": "...", "message": "<reply to the user>"}\n\n'
        "RULES:\n"
        "- You ACT on the platform; you are not just a chat. When the user wants to SEE / DISPLAY / "
        "SHOW / FILTER / SORT / BROWSE jobs (e.g. 'display all remote jobs'), call update_dashboard so "
        "the results appear in the user's MAIN jobs table - do NOT dump job lists into the chat.\n"
        "- Use search_jobs only to answer a factual question in chat or to obtain job ids for a "
        "follow-up action; it does not change the dashboard.\n"
        "- Base every answer on tool results, never on assumptions.\n"
        "- To act on specific jobs (apply, re-run, details), FIRST call search_jobs to get their ids, "
        "then pass those ids to the action tool.\n"
        "- Tools marked [REQUIRES CONFIRMATION] change data; request them normally - the app asks the "
        "user to confirm before running, so do not ask for confirmation yourself in text.\n"
        "- Never invent job ids; only use ids returned by tools. Never show ids to the user; the app "
        "renders result cards with links.\n"
        "- The user's profile, work history, skills and personal details are ALREADY on file, and "
        "tailor_resume uses them with the user's own resume template. NEVER ask the user to paste "
        "their resume, experience or contact details.\n"
        "- When the user pastes a job description or asks to tailor their resume or write a cover "
        "letter for a role, call tailor_resume. Do NOT copy the job description into args; the app "
        "reads it from the user's messages. Set include_cover_letter=true only when they also want a "
        "cover letter. Put any extra wishes (tone, focus, length) in instructions. If no posting "
        "was pasted yet, ask only for the job description.\n"
        "- Keep the final message concise, friendly and specific (cite real counts/titles).\n"
        "- Never use em dashes in your messages; use a comma, period, or hyphen instead.\n"
        "- If a tool fails, briefly explain and suggest a next step."
    )


def _parse_planner_json(content: str) -> dict[str, Any] | None:
    text = (content or "").strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        # Best-effort: grab the first balanced object.
        start = text.find("{")
        end = text.rfind("}")
        if 0 <= start < end:
            try:
                obj = json.loads(text[start : end + 1])
                return obj if isinstance(obj, dict) else None
            except json.JSONDecodeError:
                return None
        return None


def _compact(data: Any) -> str:
    try:
        raw = json.dumps(data, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        raw = str(data)
    if len(raw) > OBSERVATION_DATA_LIMIT:
        return raw[:OBSERVATION_DATA_LIMIT] + " …(truncated)"
    return raw


def _selected_tool_rule(tool_name: str) -> str:
    spec = get_tool(tool_name)
    label = (spec.label if spec else "") or tool_name
    return (
        f"The user picked the '{label}' tool ({tool_name}) for this message. Act on the message "
        f"with {tool_name}, filling its args from what they wrote (call search_jobs first only "
        "when it needs job ids). Answer in text without a tool only when the message gives "
        "nothing to act on, and then say what you need."
    )


# Asking for a tailored resume or cover letter, in the user's words.
_TAILOR_INTENT_RE = re.compile(
    r"\b(tailor(?:ed|ing)?|customi[sz]e|rewrite|adapt|optimi[sz]e|generate|create|write|make|build|prepare|draft)\b"
    r"[^.\n]{0,60}\b(resume|r\u00e9sum\u00e9|cv|cover\s+letter)\b"
    r"|\b(resume|r\u00e9sum\u00e9|cv|cover\s+letter)\b[^.\n]{0,40}\b(for|to|based on)\b[^.\n]{0,30}"
    r"\b(this|the|following|below)\b[^.\n]{0,20}\b(job|role|position|posting|description|jd)\b",
    re.IGNORECASE,
)
_COVER_LETTER_RE = re.compile(r"\bcover\s+letters?\b", re.IGNORECASE)
_NO_COVER_LETTER_RE = re.compile(
    r"\b(no|without|skip|don'?t\s+(?:need|want|include))\b[^.\n]{0,20}\bcover\s+letters?\b",
    re.IGNORECASE,
)
_POSTING_HINT_RE = re.compile(
    r"\b(responsibilit|requirement|qualification|experience|skills?|about the (?:role|job|team)"
    r"|what you'?ll|you will|we are looking|benefits|salary|years)\w*",
    re.IGNORECASE,
)
# Request words plus a pasted posting; shorter text is a question, not a posting.
_HARD_ROUTE_MIN_CHARS = 400
_INTENT_WINDOW_CHARS = 400


def tailor_request_args(message: str) -> dict[str, Any] | None:
    """``tailor_resume`` args when the message is a tailoring request with a pasted posting.

    The request words must sit near the start or end of the message (around
    the pasted text), so a posting that merely mentions "resume" is not routed.
    """
    text = (message or "").strip()
    if len(text) < _HARD_ROUTE_MIN_CHARS:
        return None
    ends = f"{text[:_INTENT_WINDOW_CHARS]}\n{text[-_INTENT_WINDOW_CHARS:]}"
    if not _TAILOR_INTENT_RE.search(ends):
        return None
    if len(_POSTING_HINT_RE.findall(text)) < 2:
        return None
    return {"include_cover_letter": wants_cover_letter(text)}


def wants_cover_letter(message: str) -> bool:
    """The request (around the pasted posting, not inside it) asks for a cover letter."""
    text = (message or "").strip()
    ends = f"{text[:_INTENT_WINDOW_CHARS]}\n{text[-_INTENT_WINDOW_CHARS:]}"
    return bool(_COVER_LETTER_RE.search(ends)) and not _NO_COVER_LETTER_RE.search(ends)


def _build_messages(
    message: str,
    history: list[dict[str, str]],
    *,
    is_admin: bool = False,
    selected_tool: str | None = None,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": _system_prompt(is_admin=is_admin)}]
    if selected_tool:
        messages.append({"role": "system", "content": _selected_tool_rule(selected_tool)})
    for turn in history[-MAX_HISTORY_TURNS:]:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        text = str(turn.get("content") or "").strip()
        if len(text) > MAX_HISTORY_TURN_CHARS:
            text = text[:MAX_HISTORY_TURN_CHARS] + " …(truncated)"
        if text:
            messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": message.strip()})
    return messages


async def run_agent_turn(
    *,
    user_id: str,
    message: str,
    history: list[dict[str, str]] | None = None,
    timezone: str | None = None,
    confirmed: dict[str, Any] | None = None,
    is_admin: bool = False,
    selected_tool: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Drive one user turn, yielding SSE-ready event dicts.

    ``selected_tool`` is the tool the user picked in the composer; the planner
    is told to act with it. A tailoring request with a pasted posting runs
    ``tailor_resume`` directly, without asking the planner first.
    """
    spec_selected = get_tool(selected_tool) if selected_tool else None
    if spec_selected is None or (spec_selected.admin_only and not is_admin):
        selected_tool = None
    if not confirmed and selected_tool in (None, "tailor_resume"):
        routed = tailor_request_args(message)
        if routed is None and selected_tool == "tailor_resume":
            routed = {"include_cover_letter": wants_cover_letter(message)}
        if routed is not None:
            confirmed = {"tool": "tailor_resume", "args": routed}

    earlier = tuple(
        str(t.get("content") or "")
        for t in reversed(history or [])
        if t.get("role") != "assistant" and str(t.get("content") or "").strip()
    )
    ctx = ToolContext(
        user_id=user_id,
        timezone=timezone,
        is_admin=is_admin,
        user_message=message,
        earlier_user_messages=earlier,
    )
    settings = get_settings()
    messages = _build_messages(
        message,
        history or [],
        is_admin=is_admin,
        selected_tool=None if confirmed else selected_tool,
    )

    try:
        client = await get_llm_client_for_user(user_id, job_type="agent")
    except Exception as exc:  # noqa: BLE001 - surface a clean error
        logger.warning("agent_llm_unavailable", user_id=user_id, error=str(exc)[:200])
        yield {"type": "error", "message": "The AI assistant is not configured. Add an LLM API key in Settings."}
        return

    async def _execute(tool_name: str, args: dict[str, Any], tool_ctx: ToolContext) -> dict[str, Any] | None:
        """Run a tool, emit its events, and return an observation dict for the loop."""
        spec = get_tool(tool_name)
        if spec is None:
            return {"observation": f"Unknown tool '{tool_name}'. Choose one from the catalog."}
        if spec.admin_only and not ctx.is_admin:
            return {"observation": f"Tool '{tool_name}' is not available."}
        try:
            result = await spec.handler(tool_ctx, args or {})
        except Exception as exc:  # noqa: BLE001 - never crash the stream
            logger.warning("agent_tool_failed", tool=tool_name, error=str(exc)[:300])
            _emit_buffer.append(
                {"type": "tool_result", "tool": tool_name, "ok": False, "summary": "That action failed."}
            )
            return {"observation": f"Tool '{tool_name}' raised an error: {str(exc)[:200]}"}

        _emit_buffer.append(
            {
                "type": "tool_result",
                "tool": tool_name,
                "ok": result.ok,
                "summary": result.summary,
                "data": result.data,
            }
        )
        if result.ok and result.refresh:
            _emit_buffer.append({"type": "refresh", "targets": result.refresh})
        # A tool may drive the main app UI (e.g. update the dashboard table) by
        # returning a ``ui_action`` directive the client executes.
        if result.ok and isinstance(result.data, dict) and result.data.get("ui_action"):
            directive = result.data["ui_action"]
            if isinstance(directive, dict):
                _emit_buffer.append({"type": "ui_action", **directive})
        status = "ok" if result.ok else "error"
        return {"observation": f"[{status}] {result.summary}\nData: {_compact(result.data)}"}

    # Buffer lets the inner helper queue events that the generator then yields.
    _emit_buffer: list[dict[str, Any]] = []

    async def _run_streaming(
        tool_name: str, args: dict[str, Any], holder: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        """Run a tool in the background, relaying its progress and a heartbeat."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def progress(label: str, **detail: Any) -> None:
            await queue.put({**detail, "type": "progress", "tool": tool_name, "label": label})

        task = asyncio.create_task(_execute(tool_name, args, dataclasses.replace(ctx, progress=progress)))
        try:
            while True:
                getter = asyncio.ensure_future(queue.get())
                done, _pending = await asyncio.wait(
                    {task, getter}, timeout=HEARTBEAT_SECONDS, return_when=asyncio.FIRST_COMPLETED
                )
                if getter in done:
                    yield getter.result()
                    continue
                getter.cancel()
                if task in done:
                    break
                yield {"type": "heartbeat"}
            while not queue.empty():
                yield queue.get_nowait()
            holder["observation"] = task.result()
        finally:
            if not task.done():
                task.cancel()

    # ── Pre-approved (confirmed) step, if any ──────────────────────────────
    if confirmed and confirmed.get("tool"):
        tool_name = str(confirmed["tool"])
        args = confirmed.get("args") or {}
        spec = get_tool(tool_name)
        yield {
            "type": "tool_call",
            "tool": tool_name,
            "title": spec.running_title if spec else "Working",
            "args": args,
        }
        holder: dict[str, Any] = {}
        async for ev in _run_streaming(tool_name, args, holder):
            yield ev
        observation = holder.get("observation")
        for ev in _emit_buffer:
            yield ev
        _emit_buffer.clear()
        if observation:
            messages.append(
                {"role": "assistant", "content": json.dumps({"action": {"tool": tool_name, "args": args}})}
            )
            messages.append({"role": "user", "content": observation["observation"]})

    # ── Planning loop ──────────────────────────────────────────────────────
    for _ in range(MAX_ITERATIONS):
        try:
            content, _resp = await chat_completion_with_empty_retry(
                client,
                observe="agent_planner",
                job_type="agent",
                raise_on_empty=False,
                model=settings.openai_model,
                messages=messages,
                temperature=0.1,
                max_tokens=PLANNER_MAX_TOKENS,
                response_format={"type": "json_object"},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("agent_planner_failed", user_id=user_id, error=str(exc)[:300])
            yield {"type": "error", "message": llm_failure_message(exc)}
            return

        plan = _parse_planner_json(content)
        if plan is None:
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {"role": "user", "content": "That was not valid JSON. Respond with a single JSON object as instructed."}
            )
            continue

        action = plan.get("action")
        if isinstance(action, dict) and action.get("tool"):
            tool_name = str(action["tool"])
            args = action.get("args") or {}
            spec = get_tool(tool_name)

            # Confirmation gate for destructive / bulk / cost-incurring tools.
            if spec is not None and spec.requires_confirmation:
                yield {
                    "type": "confirm",
                    "tool": tool_name,
                    "title": spec.running_title,
                    "args": args,
                    "summary": _confirm_summary(tool_name, args),
                }
                yield {"type": "done"}
                return

            yield {
                "type": "tool_call",
                "tool": tool_name,
                "title": spec.running_title if spec else "Working",
                "args": args,
            }
            holder = {}
            async for ev in _run_streaming(tool_name, args, holder):
                yield ev
            observation = holder.get("observation")
            for ev in _emit_buffer:
                yield ev
            _emit_buffer.clear()
            messages.append({"role": "assistant", "content": json.dumps({"action": action})})
            messages.append({"role": "user", "content": (observation or {}).get("observation", "")})
            continue

        final = plan.get("message")
        if isinstance(final, str) and final.strip():
            yield {"type": "message", "text": final.strip()}
            yield {"type": "done"}
            return

        # Neither a valid action nor a message - nudge once and retry.
        messages.append({"role": "assistant", "content": content})
        messages.append(
            {"role": "user", "content": "Respond with either an 'action' or a final 'message'."}
        )

    # Iteration budget exhausted.
    yield {
        "type": "message",
        "text": "I wasn't able to finish that request. Could you rephrase or break it into smaller steps?",
    }
    yield {"type": "done"}


def _confirm_summary(tool_name: str, args: dict[str, Any]) -> str:
    """Human-readable confirmation prompt for a pending action."""
    if tool_name == "trigger_sync":
        platforms = args.get("platforms") or []
        target = ", ".join(platforms) if platforms else "all platforms"
        return f"Start a sync for {target}?"
    if tool_name == "set_applied":
        ids = args.get("job_ids") or []
        applied = bool(args.get("applied", True))
        verb = "mark as applied" if applied else "clear the applied mark on"
        return f"{verb.capitalize()} {len(ids)} job(s)?"
    if tool_name == "rerun_matches":
        ids = args.get("job_ids") or []
        return f"Re-run AI match analysis for {len(ids)} job(s)?"
    if tool_name == "submit_job":
        return f"Submit this job URL?\n{args.get('url', '')}"
    return f"Run {tool_name}?"
