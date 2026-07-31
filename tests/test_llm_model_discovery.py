"""Tests for OpenAI-compatible model discovery and job→model binding."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.llm_model_discovery import list_models_for_api_key, model_usable_for_chat


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("gpt-5.1", True),
        ("gemini-2.5-pro", True),
        ("gemini-2.5-flash", True),
        ("sonar-pro", True),
        ("text-embedding-3-large", False),
        ("dall-e-3", False),
        ("gpt-image-1", False),
        ("gpt-4o-realtime-preview", False),
        ("gpt-4o-audio", False),
        ("gpt-4o-transcribe", False),
        ("titan-embed-image-v1", False),
        ("test-text-embedding-3-large", False),
        # Retired Gemini — still listed by LiteLLM, 404 at call time
        ("gemini-1.5-pro", False),
        ("gemini-1.5-flash", False),
        ("gemini-2.0-flash", False),
        ("gemini-2.0-flash-exp", False),
        ("gemini-2.0-flash-lite", False),
        ("gemini-pro", False),
        ("gemini/gemini-1.5-pro", False),
    ],
)
def test_model_usable_for_chat(model_id: str, expected: bool) -> None:
    assert model_usable_for_chat(model_id) is expected


def test_is_retired_gemini_model() -> None:
    from app.services.llm_model_discovery import is_retired_gemini_model

    assert is_retired_gemini_model("gemini-1.5-pro") is True
    assert is_retired_gemini_model("gemini-2.0-flash-exp") is True
    assert is_retired_gemini_model("gemini-2.5-pro") is False
    assert is_retired_gemini_model("gpt-4o") is False


@pytest.mark.asyncio
async def test_list_models_for_openai_compatible_key() -> None:
    fake_page = SimpleNamespace(
        data=[
            SimpleNamespace(id="gpt-5.1", owned_by="openai"),
            SimpleNamespace(id="text-embedding-3-large", owned_by="openai"),
            SimpleNamespace(id="gemini-2.5-flash", owned_by="openai"),
            SimpleNamespace(id="gpt-5.1", owned_by="dup"),  # de-dupe
        ]
    )
    fake_client = MagicMock()
    fake_client.models.list = AsyncMock(return_value=fake_page)

    with (
        patch("app.services.llm_model_discovery.get_settings") as gs,
        patch("openai.AsyncOpenAI", return_value=fake_client) as openai_cls,
    ):
        gs.return_value = SimpleNamespace(
            openai_api_base="https://llm.hyntelo.dev/v1",
            openai_timeout_seconds=60.0,
            gemini_timeout_seconds=60.0,
            gemini_base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        )
        result = await list_models_for_api_key(
            provider="openai",
            api_key="sk-test-key-1234567890",
        )

    openai_cls.assert_called_once()
    call_kwargs = openai_cls.call_args.kwargs
    assert call_kwargs["base_url"] == "https://llm.hyntelo.dev/v1"
    assert result["count"] == 3
    assert [m["id"] for m in result["models"]] == [
        "gemini-2.5-flash",
        "gpt-5.1",
        "text-embedding-3-large",
    ]
    assert [m["id"] for m in result["chat_models"]] == ["gemini-2.5-flash", "gpt-5.1"]
    assert all(m["usable_for_chat"] for m in result["chat_models"])


@pytest.mark.asyncio
async def test_list_models_anthropic_returns_empty_with_message() -> None:
    result = await list_models_for_api_key(
        provider="anthropic",
        api_key="sk-ant-test-key-1234567890",
    )
    assert result["count"] == 0
    assert result["models"] == []
    assert result["message"]
    assert "OpenAI-compatible" in result["message"]


@pytest.mark.asyncio
async def test_resolve_job_llm_credentials_admin_model_wins_over_user() -> None:
    from app.services.llm_provider_keys_service import resolve_job_llm_credentials

    binding = SimpleNamespace(
        provider="openai",
        provider_key_id=None,
        model="gpt-4.1",
    )
    user = SimpleNamespace(llm_model="gpt-5.1")
    session = AsyncMock()
    result_binding = MagicMock()
    result_binding.scalar_one_or_none.return_value = binding
    session.execute = AsyncMock(return_value=result_binding)

    with (
        patch(
            "app.storage.user_repository.UserRepository.resolve_llm_provider",
            new=AsyncMock(return_value="openai"),
        ),
        patch(
            "app.storage.user_repository.UserRepository.resolve_provider_api_key",
            new=AsyncMock(return_value="sk-user"),
        ),
        patch(
            "app.storage.user_repository.UserRepository.get_by_id",
            new=AsyncMock(return_value=user),
        ),
        patch(
            "app.services.system_settings_service.get_effective_value",
            new=AsyncMock(return_value="openai"),
        ),
    ):
        creds = await resolve_job_llm_credentials(
            session, job_type="resume_tailoring", user_id="u1"
        )

    assert creds["bound_model"] == "gpt-4.1"
    assert creds["provider"] == "openai"


@pytest.mark.asyncio
async def test_resolve_job_llm_credentials_user_model_when_admin_unbound() -> None:
    from app.services.llm_provider_keys_service import resolve_job_llm_credentials

    binding = SimpleNamespace(
        provider=None,
        provider_key_id=None,
        model=None,
    )
    user = SimpleNamespace(llm_model="gpt-5.1")
    session = AsyncMock()
    result_binding = MagicMock()
    result_binding.scalar_one_or_none.return_value = binding
    session.execute = AsyncMock(return_value=result_binding)

    with (
        patch(
            "app.storage.user_repository.UserRepository.resolve_llm_provider",
            new=AsyncMock(return_value="openai"),
        ),
        patch(
            "app.storage.user_repository.UserRepository.resolve_provider_api_key",
            new=AsyncMock(return_value="sk-user"),
        ),
        patch(
            "app.storage.user_repository.UserRepository.get_by_id",
            new=AsyncMock(return_value=user),
        ),
        patch(
            "app.services.system_settings_service.get_effective_value",
            new=AsyncMock(return_value="openai"),
        ),
    ):
        creds = await resolve_job_llm_credentials(
            session, job_type="job_analysis", user_id="u1"
        )

    assert creds["bound_model"] == "gpt-5.1"
    assert creds["provider"] == "openai"


def test_get_llm_client_honors_openai_model_override() -> None:
    from app.core import llm_client as lc

    # Clear cache so a prior test client cannot leak in.
    lc._clients.clear()

    fake_adapter = MagicMock()
    fake_adapter.name = "openai"
    fake_adapter._model = "gpt-5.1"

    with (
        patch.object(lc, "_build_adapter", return_value=fake_adapter) as build,
        patch(
            "app.services.system_settings_service.get_effective_value_sync",
            side_effect=lambda key: {
                "openai_model": "gpt-4o-mini",
                "anthropic_model": "claude",
                "gemini_model": "gemini",
                "llm_fallback_enabled": False,
                "default_llm_provider": "openai",
                "llm_circuit_breaker_threshold": 5,
                "llm_circuit_breaker_cooldown_seconds": 60,
            }.get(key, ""),
        ),
        patch.object(
            lc,
            "get_settings",
            return_value=SimpleNamespace(
                openai_api_key="sk-env",
                anthropic_api_key="",
                gemini_api_key="",
            ),
        ),
    ):
        client = lc.get_llm_client(
            provider="openai",
            openai_api_key="sk-env",
            openai_model="gpt-5.1",
        )

    assert client.primary_provider == "openai"
    build.assert_called()
    assert build.call_args.kwargs.get("model") == "gpt-5.1" or (
        len(build.call_args.args) >= 2 and build.call_args.kwargs.get("model") == "gpt-5.1"
    )
    # Explicit kwargs check (model is keyword-only).
    assert build.call_args.kwargs["model"] == "gpt-5.1"
    lc._clients.clear()
