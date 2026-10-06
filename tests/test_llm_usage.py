import asyncio
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

from app.core.logging import bind_logging_context, clear_logging_context, set_request_id
from app.models.database import User
from app.services import llm_usage
from app.services.llm_pricing import estimate_cost_usd, model_price
from app.services.signup_approval_service import can_use_app, can_use_app_clause


@pytest.fixture(autouse=True)
def _clean():
    llm_usage._buffer.clear()
    clear_logging_context()
    yield
    llm_usage._buffer.clear()
    clear_logging_context()


def test_price_matches_dated_and_prefixed_model_ids():
    assert model_price("gpt-5.1-2025-11-13") == (1.25, 10.0)
    assert model_price("openai/gpt-5-mini") == (0.25, 2.0)
    assert model_price("models/gemini-2.5-flash-lite") == (0.10, 0.40)
    assert model_price("some-unknown-model") is None


def test_cost_uses_input_and_output_rates():
    assert estimate_cost_usd("gpt-5.1", 1_000_000, 100_000) == pytest.approx(2.25)
    assert estimate_cost_usd("mystery", 10, 10) is None


def test_record_takes_user_job_and_run_from_logging_context():
    set_request_id("run-1")
    bind_logging_context(user_id="u1", valid_job_id="j1", worker_job_type="generate_tailored_content")
    with llm_usage.llm_call_label(observe="phase_b", job_type="resume_tailoring"):
        llm_usage.record_llm_usage(provider="openai", model="gpt-5.1", prompt_tokens=1000, completion_tokens=200)

    (row,) = list(llm_usage._buffer)
    assert row["user_id"] == "u1"
    assert row["job_id"] == "j1"
    assert row["run_id"] == "run-1"
    assert row["feature"] == "resume_tailoring"
    assert row["operation"] == "phase_b"
    assert row["total_tokens"] == 1200
    assert row["cost_usd"] == pytest.approx((1000 * 1.25 + 200 * 10) / 1_000_000)
    assert row["estimated"] is False


def test_feature_falls_back_to_worker_then_other():
    bind_logging_context(worker_job_type="analyze_job_match")
    llm_usage.record_llm_usage(provider="openai", model="x", prompt_tokens=1, completion_tokens=1)
    clear_logging_context()
    llm_usage.record_llm_usage(provider="openai", model="x", prompt_tokens=1, completion_tokens=1)
    assert [r["feature"] for r in llm_usage._buffer] == ["analyze_job_match", "other"]


def test_record_never_raises_on_bad_numbers():
    llm_usage.record_llm_usage(provider=None, model=None, prompt_tokens="nope", completion_tokens=None)
    (row,) = list(llm_usage._buffer)
    assert row["prompt_tokens"] == 0 and row["total_tokens"] == 0 and row["cost_usd"] is None


def test_usage_from_response_reads_reasoning_details():
    resp = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=10, completion_tokens=5, completion_tokens_details=SimpleNamespace(reasoning_tokens=3)
        )
    )
    assert llm_usage.usage_from_response(resp) == (10, 5, 3)
    assert llm_usage.usage_from_response(SimpleNamespace()) is None


class _FakeAdapter:
    name = "openai"
    _model = "gpt-5.1"
    recoverable_errors = (RuntimeError,)

    async def create(self, **kwargs):
        return SimpleNamespace(
            model="gpt-5.1-2025-11-13",
            usage=SimpleNamespace(prompt_tokens=40, completion_tokens=8, completion_tokens_details=None),
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'), finish_reason="stop")],
        )

    async def stream(self, **kwargs):
        for part in ("Hello ", "there"):
            yield part


def _client():
    from app.core.llm_client import LLMFallbackClient, _ChatNamespace

    client = LLMFallbackClient.__new__(LLMFallbackClient)
    client._adapters = [_FakeAdapter()]
    client.chat = _ChatNamespace(client)
    client._cb = SimpleNamespace(
        should_attempt_primary=lambda: True,
        record_success=lambda: None,
        record_failure=lambda e: None,
        state="closed",
        cooldown_remaining=0,
        _consecutive_failures=0,
    )
    return client


def test_every_completion_through_the_client_is_recorded():
    from app.core.llm_client import chat_completion_with_empty_retry

    bind_logging_context(user_id="u9")
    text, _ = asyncio.run(
        chat_completion_with_empty_retry(
            _client(), observe="assistant_autofill", job_type="extension_autofill", messages=[{"role": "user", "content": "hi"}]
        )
    )
    assert text
    (row,) = list(llm_usage._buffer)
    assert row["user_id"] == "u9"
    assert row["feature"] == "extension_autofill"
    assert row["model"] == "gpt-5.1-2025-11-13"
    assert row["prompt_tokens"] == 40 and row["completion_tokens"] == 8


def test_streamed_reply_is_recorded_as_estimated():
    async def consume():
        return "".join([d async for d in _client().stream_chat(messages=[{"role": "user", "content": "x" * 400}])])

    assert asyncio.run(consume()) == "Hello there"
    (row,) = list(llm_usage._buffer)
    assert row["estimated"] is True
    assert row["feature"] == "assistant_chat"
    assert row["prompt_tokens"] >= 100


@pytest.mark.parametrize(
    ("active", "status", "allowed"),
    [(True, "approved", True), (True, "pending", False), (True, "rejected", False), (False, "approved", False)],
)
def test_only_active_approved_accounts_can_use_the_app(active, status, allowed):
    assert can_use_app(User(is_active=active, approval_status=status)) is allowed


def test_fanout_clause_requires_approval_not_just_active():
    sql = str(can_use_app_clause().compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "users.is_active IS true" in sql
    assert "users.approval_status = 'approved'" in sql
