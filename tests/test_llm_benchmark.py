"""Unit tests for admin LLM response-time benchmarks."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.llm_benchmark import (
    BenchmarkTarget,
    benchmark_models,
    benchmark_one,
)


@pytest.mark.asyncio
async def test_benchmark_one_unknown_provider():
    session = MagicMock()
    result = await benchmark_one(
        session,
        BenchmarkTarget(provider="nope", model="x"),
    )
    assert result.ok is False
    assert "Unknown provider" in (result.error or "")


@pytest.mark.asyncio
async def test_benchmark_one_missing_model():
    session = MagicMock()
    result = await benchmark_one(
        session,
        BenchmarkTarget(provider="openai", model="  "),
    )
    assert result.ok is False
    assert "Model id" in (result.error or "")


@pytest.mark.asyncio
async def test_benchmark_one_openai_success():
    session = MagicMock()

    mock_resp = MagicMock()
    mock_resp.choices = [MagicMock()]
    mock_resp.choices[0].message.content = "ok"

    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=mock_resp)

    with (
        patch(
            "app.services.llm_benchmark.resolve_benchmark_api_key",
            new=AsyncMock(return_value="sk-test-key-12345678901234567890"),
        ),
        patch("app.services.llm_benchmark._env_api_key", return_value="sk-test"),
        patch("openai.AsyncOpenAI", return_value=mock_client),
        patch(
            "app.services.llm_benchmark._timeout_for_provider",
            return_value=10.0,
        ),
    ):
        result = await benchmark_one(
            session,
            BenchmarkTarget(provider="openai", model="gpt-4o-mini"),
        )

    assert result.ok is True
    assert result.latency_ms is not None
    assert result.latency_ms >= 0
    assert result.response_preview == "ok"
    mock_client.chat.completions.create.assert_awaited_once()


@pytest.mark.asyncio
async def test_benchmark_models_runs_multiple_rounds():
    session = MagicMock()
    targets = [
        BenchmarkTarget(provider="openai", model="a"),
        BenchmarkTarget(provider="openai", model="b"),
    ]

    async def fake_one(_session, target, *, prompt="x"):
        from app.services.llm_benchmark import BenchmarkResult

        return BenchmarkResult(
            provider=target.provider,
            model=target.model,
            provider_key_id=None,
            ok=True,
            latency_ms=100.0,
            error=None,
            ran_at="2026-01-01T00:00:00Z",
        )

    with patch("app.services.llm_benchmark.benchmark_one", side_effect=fake_one):
        results = await benchmark_models(session, targets, runs=2, concurrency=2)

    assert len(results) == 4
    assert {r.model for r in results} == {"a", "b"}


@pytest.mark.asyncio
async def test_benchmark_models_rejects_too_many():
    session = MagicMock()
    targets = [
        BenchmarkTarget(provider="openai", model=f"m{i}") for i in range(41)
    ]
    with pytest.raises(ValueError, match="At most 40"):
        await benchmark_models(session, targets)


@pytest.mark.asyncio
async def test_benchmark_one_skips_retired_gemini():
    session = MagicMock()
    result = await benchmark_one(
        session,
        BenchmarkTarget(provider="gemini", model="gemini-1.5-pro"),
    )
    assert result.ok is False
    assert result.latency_ms is None
    assert "retired" in (result.error or "").lower()


def test_format_provider_error_quota_and_not_found():
    from app.services.llm_benchmark import format_provider_error

    msg_429 = format_provider_error(
        "Error code: 429 - exceeded your current quota",
        model="gemini-2.5-pro",
    )
    assert "429" in msg_429
    assert "quota" in msg_429.lower()

    msg_404 = format_provider_error(
        "Error code: 404 - models/gemini-1.5-pro is not found",
        model="gemini-1.5-pro",
    )
    assert "404" in msg_404
    assert "retired" in msg_404.lower() or "unavailable" in msg_404.lower()
