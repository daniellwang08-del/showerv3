"""Shared empty-content retry for reasoning models (GPT-5 / o-series)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.exceptions import AIParsingError
from app.core.llm_client import chat_completion_with_empty_retry, response_message_meta


def _fake_response(content: str | None, *, finish_reason: str = "stop", model: str = "gpt-5.1"):
    message = SimpleNamespace(content=content)
    choice = SimpleNamespace(message=message, finish_reason=finish_reason)
    usage = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=200,
        total_tokens=300,
        completion_tokens_details=SimpleNamespace(reasoning_tokens=180),
    )
    return SimpleNamespace(choices=[choice], usage=usage, model=model)


def test_response_message_meta_reads_usage_and_finish_reason():
    text, finish, usage = response_message_meta(_fake_response("", finish_reason="length"))
    assert text == ""
    assert finish == "length"
    assert usage["reasoning_tokens"] == 180


@pytest.mark.asyncio
async def test_chat_completion_retries_empty_with_low_reasoning() -> None:
    client = MagicMock()
    create = AsyncMock(
        side_effect=[
            _fake_response(None, finish_reason="length"),
            _fake_response('{"ok": true}', finish_reason="stop"),
        ]
    )
    client.chat.completions.create = create

    text, _resp = await chat_completion_with_empty_retry(
        client,
        observe="resume_parse",
        job_type="resume_parse",
        model="gpt-5.1",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=1024,
    )

    assert text == '{"ok": true}'
    assert create.await_count == 2
    second_kwargs = create.await_args_list[1].kwargs
    assert second_kwargs.get("reasoning_effort") == "low"


@pytest.mark.asyncio
async def test_chat_completion_raises_after_empty_retry() -> None:
    client = MagicMock()
    create = AsyncMock(
        side_effect=[
            _fake_response("", finish_reason="length"),
            _fake_response("", finish_reason="length"),
        ]
    )
    client.chat.completions.create = create

    with pytest.raises(AIParsingError, match="Empty response from AI model"):
        await chat_completion_with_empty_retry(
            client,
            observe="resume_parse",
            job_type="resume_parse",
            model="gpt-5.1",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=1024,
        )

    assert create.await_count == 2


@pytest.mark.asyncio
async def test_chat_completion_raise_on_empty_false_returns_blank() -> None:
    client = MagicMock()
    create = AsyncMock(
        side_effect=[
            _fake_response("", finish_reason="length"),
            _fake_response("", finish_reason="length"),
        ]
    )
    client.chat.completions.create = create

    text, _resp = await chat_completion_with_empty_retry(
        client,
        observe="evidence",
        raise_on_empty=False,
        model="gpt-5.1",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert text == ""
    assert create.await_count == 2
