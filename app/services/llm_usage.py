"""Per-call LLM usage capture for admin cost reporting.

``LLMFallbackClient`` calls :func:`record_llm_usage` after every successful
completion. Who and what the call was for comes from the logging context the
API request or worker already bound (user_id, job id, request id), plus the
``observe``/``job_type`` labels set by :func:`llm_call_label`. Rows are
buffered and written by the log sink's flusher so a slow database never adds
latency to an AI request.
"""

from __future__ import annotations

import uuid
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Iterator

import structlog

from app.services.llm_pricing import estimate_cost_usd

_label: ContextVar[tuple[str | None, str | None]] = ContextVar("llm_usage_label", default=(None, None))
_buffer: deque[dict[str, Any]] = deque(maxlen=20_000)

TAILORING_FEATURE = "resume_tailoring"


@contextmanager
def llm_call_label(*, observe: str | None, job_type: str | None) -> Iterator[None]:
    token = _label.set((observe, job_type))
    try:
        yield
    finally:
        _label.reset(token)


def _clip(value: Any, size: int) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[:size] or None


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def usage_from_response(response: Any) -> tuple[int, int, int] | None:
    """(prompt, completion, reasoning) from an OpenAI-shaped response, or None."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    details = getattr(usage, "completion_tokens_details", None)
    return (
        _int(getattr(usage, "prompt_tokens", 0)),
        _int(getattr(usage, "completion_tokens", 0)),
        _int(getattr(details, "reasoning_tokens", 0)) if details is not None else 0,
    )


def estimate_tokens(text: str) -> int:
    """Rough count for streamed replies, which carry no usage block (about 4 chars per token)."""
    return max(1, len(text or "") // 4)


def record_llm_usage(
    *,
    provider: str | None,
    model: str | None,
    prompt_tokens: int,
    completion_tokens: int,
    reasoning_tokens: int = 0,
    estimated: bool = False,
) -> None:
    """Queue one usage row. Never raises: accounting must not break an AI call."""
    try:
        from app.core.logging import get_request_id

        ctx = structlog.contextvars.get_contextvars()
        observe, job_type = _label.get()
        feature = job_type or ctx.get("worker_job_type") or observe or "other"
        prompt = _int(prompt_tokens)
        completion = _int(completion_tokens)
        _buffer.append(
            {
                "id": str(uuid.uuid4()),
                "created_at": datetime.now(timezone.utc).replace(tzinfo=None),
                "user_id": _clip(ctx.get("user_id"), 36),
                "job_id": _clip(ctx.get("job_id") or ctx.get("valid_job_id"), 36),
                "run_id": _clip(get_request_id() or ctx.get("request_id"), 64),
                "feature": _clip(feature, 80) or "other",
                "operation": _clip(observe, 80),
                "provider": _clip(provider, 20),
                "model": _clip(model, 200),
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "reasoning_tokens": _int(reasoning_tokens),
                "total_tokens": prompt + completion,
                "cost_usd": estimate_cost_usd(model, prompt, completion),
                "estimated": bool(estimated),
            }
        )
    except Exception:
        pass


def pending_usage_rows() -> int:
    return len(_buffer)


async def flush_llm_usage() -> int:
    if not _buffer:
        return 0
    batch: list[dict[str, Any]] = []
    while _buffer and len(batch) < 200:
        try:
            batch.append(_buffer.popleft())
        except IndexError:
            break
    if not batch:
        return 0
    try:
        from app.models.database import LlmUsageEvent
        from app.storage.database import get_session

        async with get_session() as session:
            session.add_all([LlmUsageEvent(**row) for row in batch])
            await session.commit()
        return len(batch)
    except Exception:
        for row in reversed(batch):
            try:
                _buffer.appendleft(row)
            except Exception:
                break
        return 0
