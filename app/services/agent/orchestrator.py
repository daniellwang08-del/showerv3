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

import json
import re
from collections.abc import AsyncIterator
from typing import Any

from app.core.config import get_settings
from app.core.llm_client import get_llm_client_for_user
from app.core.logging import get_logger
from app.services.agent.base import ToolContext, catalog_prompt, get_tool

logger = get_logger(__name__)

MAX_ITERATIONS = 6
MAX_HISTORY_TURNS = 12
PLANNER_MAX_TOKENS = 700
OBSERVATION_DATA_LIMIT = 1800


def _system_prompt() -> str:
    return (
        "You are the in-app AI assistant for a job-search platform. You help the "
        "signed-in user by calling tools to search their jobs and perform actions on "
        "their behalf. Every tool acts only for this authenticated user.\n\n"
        "AVAILABLE TOOLS:\n"
        f"{catalog_prompt()}\n\n"
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
        "- Never invent job ids; only use ids returned by tools.\n"
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


def _build_messages(
    message: str,
    history: list[dict[str, str]],
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": _system_prompt()}]
    for turn in history[-MAX_HISTORY_TURNS:]:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        text = str(turn.get("content") or "").strip()
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
) -> AsyncIterator[dict[str, Any]]:
    """Drive one user turn, yielding SSE-ready event dicts."""

    ctx = ToolContext(user_id=user_id, timezone=timezone)
    settings = get_settings()
    messages = _build_messages(message, history or [])

    try:
        client = await get_llm_client_for_user(user_id)
    except Exception as exc:  # noqa: BLE001 - surface a clean error
        logger.warning("agent_llm_unavailable", user_id=user_id, error=str(exc)[:200])
        yield {"type": "error", "message": "The AI assistant is not configured. Add an LLM API key in Settings."}
        return

    async def _execute(tool_name: str, args: dict[str, Any]) -> dict[str, Any] | None:
        """Run a tool, emit its events, and return an observation dict for the loop."""
        spec = get_tool(tool_name)
        if spec is None:
            return {"observation": f"Unknown tool '{tool_name}'. Choose one from the catalog."}
        try:
            result = await spec.handler(ctx, args or {})
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
        observation = await _execute(tool_name, args)
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
            resp = await client.chat.completions.create(
                model=settings.openai_model,
                messages=messages,
                temperature=0.1,
                max_tokens=PLANNER_MAX_TOKENS,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or ""
        except Exception as exc:  # noqa: BLE001
            logger.warning("agent_planner_failed", user_id=user_id, error=str(exc)[:300])
            yield {"type": "error", "message": "The assistant is temporarily unavailable. Please try again."}
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
            observation = await _execute(tool_name, args)
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
