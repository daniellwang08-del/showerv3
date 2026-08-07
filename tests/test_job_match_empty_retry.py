"""Empty LLM content retry for Phase A/B JSON calls."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import json
import pytest

from app.core.exceptions import AIParsingError
from app.services.job_match_service import _call_openai_json, _response_message_meta


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
    text, finish, usage = _response_message_meta(
        _fake_response("", finish_reason="length")
    )
    assert text == ""
    assert finish == "length"
    assert usage["reasoning_tokens"] == 180


@pytest.mark.asyncio
async def test_call_openai_json_retries_empty_with_low_reasoning() -> None:
    client = MagicMock()
    create = AsyncMock(
        side_effect=[
            _fake_response(None, finish_reason="length"),
            _fake_response('{"ok": true}', finish_reason="stop"),
        ]
    )
    client.chat.completions.create = create

    with patch(
        "app.services.job_match_service.get_llm_client_for_user",
        new=AsyncMock(return_value=client),
    ):
        parsed = await _call_openai_json(
            system_prompt="sys",
            user_content="user",
            max_tokens=1024,
            observe_name="phase_b",
            user_id="u1",
            job_type="resume_tailoring",
        )

    assert parsed == {"ok": True}
    assert create.await_count == 2
    second_kwargs = create.await_args_list[1].kwargs
    assert second_kwargs.get("reasoning_effort") == "low"


@pytest.mark.asyncio
async def test_call_openai_json_retries_truncated_json() -> None:
    """Phase A often truncates mid-string in structured_job.description."""
    client = MagicMock()
    create = AsyncMock(
        side_effect=[
            _fake_response(
                '{"overall_score": 70, "structured_job": {"description": "About the role',
                finish_reason="length",
            ),
            _fake_response(
                '{"overall_score": 70, "dimension_scores": {}, "summary": "ok", '
                '"strengths": [], "gaps": [], "recommendation": "moderate_match", '
                '"requires_security_clearance": false, "is_job_posting": true, '
                '"structured_job": {"title": "Eng", "description": "About the role."}}',
                finish_reason="stop",
            ),
        ]
    )
    client.chat.completions.create = create

    with (
        patch(
            "app.services.job_match_service.get_llm_client_for_user",
            new=AsyncMock(return_value=client),
        ),
        patch(
            "app.services.job_match_service._loads_llm_json",
            side_effect=[
                json.JSONDecodeError("Unterminated string", "doc", 0),
                {
                    "overall_score": 70,
                    "dimension_scores": {},
                    "summary": "ok",
                    "strengths": [],
                    "gaps": [],
                    "recommendation": "moderate_match",
                    "requires_security_clearance": False,
                    "is_job_posting": True,
                    "structured_job": {"title": "Eng", "description": "About the role."},
                },
            ],
        ),
    ):
        parsed = await _call_openai_json(
            system_prompt="sys",
            user_content="user",
            max_tokens=2048,
            observe_name="phase_a",
            user_id="u1",
            job_type="job_analysis",
        )

    assert parsed["overall_score"] == 70
    assert create.await_count == 2
    assert create.await_args_list[1].kwargs.get("reasoning_effort") == "low"
    assert create.await_args_list[1].kwargs.get("max_tokens") == 6144


@pytest.mark.asyncio
async def test_call_openai_json_raises_after_empty_retry() -> None:
    client = MagicMock()
    create = AsyncMock(
        side_effect=[
            _fake_response("", finish_reason="length"),
            _fake_response("", finish_reason="length"),
        ]
    )
    client.chat.completions.create = create

    with patch(
        "app.services.job_match_service.get_llm_client_for_user",
        new=AsyncMock(return_value=client),
    ):
        with pytest.raises(AIParsingError, match="Empty response from AI model"):
            await _call_openai_json(
                system_prompt="sys",
                user_content="user",
                max_tokens=1024,
                observe_name="phase_b",
                job_type="resume_tailoring",
            )

    assert create.await_count == 2
