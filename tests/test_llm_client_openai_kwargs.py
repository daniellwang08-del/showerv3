from types import SimpleNamespace

from app.core.llm_client import (
    _effective_openai_reasoning_effort,
    _is_openai_reasoning_model,
    _normalize_openai_chat_kwargs,
)


def test_is_openai_reasoning_model_detects_gpt5_and_o_series():
    assert _is_openai_reasoning_model("gpt-5-nano-2025-08-07")
    assert _is_openai_reasoning_model("gpt-5-mini")
    assert _is_openai_reasoning_model("o3-mini")
    assert _is_openai_reasoning_model("o1-preview")


def test_is_openai_reasoning_model_excludes_chat_and_legacy():
    assert not _is_openai_reasoning_model("gpt-5-chat-latest")
    assert not _is_openai_reasoning_model("gpt-4.1")
    assert not _is_openai_reasoning_model("gpt-4o-mini")


def test_normalize_reasoning_model_maps_max_tokens_and_strips_temperature():
    out = _normalize_openai_chat_kwargs(
        {
            "max_tokens": 8192,
            "temperature": 0.2,
            "top_p": 0.9,
            "messages": [{"role": "user", "content": "hi"}],
        },
        model="gpt-5-nano-2025-08-07",
    )
    assert "max_tokens" not in out
    assert out["max_completion_tokens"] == 8192
    assert "temperature" not in out
    assert "top_p" not in out
    assert out["messages"] == [{"role": "user", "content": "hi"}]


def test_normalize_reasoning_model_keeps_default_temperature():
    out = _normalize_openai_chat_kwargs(
        {"max_tokens": 100, "temperature": 1},
        model="o3-mini",
    )
    assert out["max_completion_tokens"] == 100
    assert out["temperature"] == 1


def test_normalize_reasoning_model_preserves_existing_max_completion_tokens():
    out = _normalize_openai_chat_kwargs(
        {"max_tokens": 100, "max_completion_tokens": 200},
        model="gpt-5",
    )
    assert out["max_completion_tokens"] == 200
    assert "max_tokens" not in out


def test_normalize_reasoning_model_injects_reasoning_effort():
    out = _normalize_openai_chat_kwargs(
        {"max_tokens": 100},
        model="gpt-5-nano-2025-08-07",
        reasoning_effort="low",
    )
    assert out["max_completion_tokens"] == 100
    assert out["reasoning_effort"] == "low"


def test_normalize_reasoning_model_does_not_override_explicit_reasoning_effort():
    out = _normalize_openai_chat_kwargs(
        {"max_tokens": 100, "reasoning_effort": "high"},
        model="gpt-5-nano",
        reasoning_effort="low",
    )
    assert out["reasoning_effort"] == "high"

    kwargs = {"max_tokens": 4096, "temperature": 0.2, "top_p": 0.9}
    out = _normalize_openai_chat_kwargs(kwargs, model="gpt-4.1")
    assert out == kwargs


def test_effective_openai_reasoning_effort_uses_system_settings(monkeypatch):
    monkeypatch.setattr(
        "app.services.system_settings_service.get_effective_value_sync",
        lambda key: "medium" if key == "openai_reasoning_effort" else None,
    )
    assert _effective_openai_reasoning_effort() == "medium"


def test_effective_openai_reasoning_effort_falls_back_on_invalid(monkeypatch):
    monkeypatch.setattr(
        "app.services.system_settings_service.get_effective_value_sync",
        lambda key: "bogus",
    )
    monkeypatch.setattr(
        "app.core.llm_client.get_settings",
        lambda: SimpleNamespace(openai_reasoning_effort="low"),
    )
    assert _effective_openai_reasoning_effort() == "low"
