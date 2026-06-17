"""
Multi-provider async LLM client with automatic Anthropic fallback
and circuit breaker.

The public surface intentionally mimics the subset of OpenAI's Chat
Completions API used across the codebase, so existing call sites do not need
to change:

    client = await get_llm_client_for_user(user_id)
    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[{"role": "system", ...}, {"role": "user", ...}],
        temperature=0.1,
        max_tokens=4096,
        response_format={"type": "json_object"},
    )
    text = response.choices[0].message.content

If the OpenAI request raises a recoverable error (quota exceeded,
rate-limited, auth failure, connection/timeout, or 5xx) AND an Anthropic
API key is configured, the same request is transparently retried against
Anthropic Claude with equivalent semantics (system prompt extraction,
JSON-object prefill, etc.).

A circuit breaker tracks consecutive OpenAI failures.  After
``LLM_CIRCUIT_BREAKER_THRESHOLD`` (default 3) consecutive errors the breaker
trips OPEN and subsequent requests skip OpenAI entirely for
``LLM_CIRCUIT_BREAKER_COOLDOWN_SECONDS`` (default 300 s / 5 min), going
straight to Anthropic without wasting a round-trip on a known-bad endpoint.
After the cooldown, one probe request tests whether OpenAI has recovered.

The wrapper preserves Langfuse OpenAI tracing when available — only the
fallback branch bypasses Langfuse (Anthropic is not auto-instrumented here).
"""

from __future__ import annotations

import hashlib
import json as json_lib
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import openai as _openai_pkg
from anthropic import AsyncAnthropic

from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger

try:
    # json-repair tolerantly fixes unescaped quotes / control chars / trailing
    # commas / wrapping fences in LLM-generated JSON. It is the recommended
    # remediation for Anthropic JSON-mode outputs that contain very long
    # string fields (e.g. a multi-thousand-char job description).
    from json_repair import repair_json as _repair_json  # type: ignore
except ImportError:  # pragma: no cover - hard dependency
    _repair_json = None  # type: ignore[assignment]

try:
    from langfuse.openai import AsyncOpenAI  # type: ignore[import-unresolved]

    _LANGFUSE_AVAILABLE = True
except ImportError:
    from openai import AsyncOpenAI

    _LANGFUSE_AVAILABLE = False

logger = get_logger(__name__)


# ── Error classification ───────────────────────────────────────────────────
#
# We fall back to Anthropic when OpenAI returns an error that is plausibly
# transient or quota-related:
#   - RateLimitError       : 429 (quota exceeded, TPM/RPM limit)
#   - AuthenticationError  : 401 (key revoked / wrong)
#   - PermissionDeniedError: 403 (org disabled, model not allowed)
#   - APIConnectionError   : network glitch reaching api.openai.com
#   - APITimeoutError      : per-request timeout
#   - InternalServerError  : 5xx
#
# We do NOT fall back on BadRequest / NotFound / UnprocessableEntity — those
# indicate our request is malformed and the same payload would also fail
# against Anthropic.

OPENAI_FALLBACK_ERRORS: tuple[type[Exception], ...] = (
    _openai_pkg.RateLimitError,
    _openai_pkg.AuthenticationError,
    _openai_pkg.PermissionDeniedError,
    _openai_pkg.APIConnectionError,
    _openai_pkg.APITimeoutError,
    _openai_pkg.InternalServerError,
)


# ── Circuit breaker ───────────────────────────────────────────────────────
#
# Three-state pattern: CLOSED → OPEN → HALF_OPEN → CLOSED.
#
# CLOSED  – normal operation, every request tries OpenAI first.
# OPEN    – OpenAI is known-bad; skip it and go straight to Anthropic.
#           After a configurable cooldown, transition to HALF_OPEN.
# HALF_OPEN – allow ONE probe request to OpenAI.
#           If it succeeds → CLOSED (recovered).
#           If it fails   → OPEN   (fresh cooldown).
#
# Each LLMFallbackClient instance owns its own _CircuitBreaker so that
# different API-key combos track failures independently.


class _CircuitBreaker:
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

    def __init__(self, threshold: int, cooldown: float) -> None:
        self._threshold = max(1, threshold)
        self._cooldown = max(0.0, cooldown)
        self._consecutive_failures = 0
        self._state = self.CLOSED
        self._opened_at: float = 0.0
        self._last_error_type: str = ""
        # Concurrency guard: the arq worker runs up to max_jobs concurrent
        # tasks in one asyncio event loop.  Without a guard, all concurrent
        # tasks pass ``should_attempt_primary()`` before any of them calls
        # ``record_failure()``, so they ALL hit OpenAI even though the very
        # first response would have tripped the breaker.
        #
        # ``_probe_in_flight`` ensures that when the breaker transitions
        # from OPEN → HALF_OPEN, only ONE task gets the probe slot.  All
        # others see OPEN and skip directly to Anthropic.
        self._probe_in_flight: bool = False

    @property
    def state(self) -> str:
        if self._state == self.OPEN and self._cooldown_elapsed:
            self._state = self.HALF_OPEN
        return self._state

    @property
    def _cooldown_elapsed(self) -> bool:
        return time.monotonic() - self._opened_at >= self._cooldown

    @property
    def cooldown_remaining(self) -> float:
        if self._state != self.OPEN:
            return 0.0
        return max(0.0, self._cooldown - (time.monotonic() - self._opened_at))

    def should_attempt_primary(self) -> bool:
        """Return True when a request should be sent to OpenAI.

        In HALF_OPEN state, only the first caller gets ``True`` (the probe).
        Subsequent concurrent callers see ``False`` until the probe resolves.
        """
        s = self.state
        if s == self.CLOSED:
            return True
        if s == self.HALF_OPEN:
            if self._probe_in_flight:
                return False
            self._probe_in_flight = True
            return True
        return False

    def record_success(self) -> None:
        prev = self._state
        self._probe_in_flight = False
        if prev != self.CLOSED:
            logger.info(
                "llm_circuit_breaker_recovered",
                previous_state=prev,
                total_failures_before_recovery=self._consecutive_failures,
            )
        self._consecutive_failures = 0
        self._state = self.CLOSED
        self._last_error_type = ""

    def record_failure(self, error: Exception) -> None:
        self._consecutive_failures += 1
        self._last_error_type = type(error).__name__
        if self._consecutive_failures >= self._threshold:
            was_closed = self._state == self.CLOSED
            self._state = self.OPEN
            self._opened_at = time.monotonic()
            self._probe_in_flight = False
            if was_closed:
                logger.warning(
                    "llm_circuit_breaker_tripped",
                    consecutive_failures=self._consecutive_failures,
                    cooldown_seconds=self._cooldown,
                    last_error_type=self._last_error_type,
                )
            else:
                logger.info(
                    "llm_circuit_breaker_probe_failed",
                    consecutive_failures=self._consecutive_failures,
                    cooldown_seconds=self._cooldown,
                    last_error_type=self._last_error_type,
                )


# ── OpenAI-shape response object (so call sites can read .choices[0].message.content) ─


@dataclass
class _Message:
    content: str
    role: str = "assistant"


@dataclass
class _Choice:
    index: int
    message: _Message
    finish_reason: str | None = None


@dataclass
class _Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class _ChatCompletion:
    id: str
    model: str
    choices: list[_Choice] = field(default_factory=list)
    usage: _Usage = field(default_factory=_Usage)
    provider: str = "openai"


# ── Anthropic message-format adapter ───────────────────────────────────────


def _split_system_and_messages(
    messages: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    """Anthropic Messages API requires ``system=...`` as a separate kwarg and
    only ``user``/``assistant`` messages inside the messages list.

    Collect every ``role == 'system'`` message (in order, concatenated) and
    return the remaining messages untouched.
    """
    system_parts: list[str] = []
    rest: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            if isinstance(content, list):
                text = "".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )
            else:
                text = str(content or "")
            if text:
                system_parts.append(text)
        else:
            normalised_content: Any = content
            if isinstance(content, list):
                normalised_content = "".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )
            elif content is None:
                normalised_content = ""
            rest.append({"role": role, "content": normalised_content})
    return "\n\n".join(system_parts), rest


def _normalize_anthropic_json(raw_text: str) -> str:
    """Repair Claude's JSON-mode output so downstream ``json.loads`` succeeds.

    Anthropic has no native JSON-mode flag, so we prefill the assistant turn
    with ``{`` and ask Claude to "respond with a single valid JSON object".
    In practice the model frequently breaks strict JSON when a field embeds
    a long, raw block of text (e.g. ``structured_job.description`` carrying
    the full job posting with literal quotes / newlines / Windows CRLF).

    Recovery strategy, in order of cost:

    1. Re-prepend the prefilled ``{`` and strip an optional ```` ```json ```` /
       ```` ``` ```` markdown fence the model sometimes adds anyway.
    2. Locate the OUTERMOST JSON object using a brace-counter that ignores
       braces inside string literals. This drops any commentary/prose that
       may follow ``}`` (a known Claude behaviour at very low temperatures).
    3. Try strict ``json.loads`` first — if it parses, return as-is.
    4. Fall back to ``json-repair`` (a tolerant parser that fixes unescaped
       quotes / newlines / trailing commas) and re-serialise the result.
    5. If repair also fails, return whatever balanced-brace candidate we
       found. The caller's ``AIParsingError`` will then carry an accurate,
       Anthropic-attributable error message instead of a misleading OpenAI
       quota error.
    """
    text = (raw_text or "").strip()
    # Strip a leading code fence the model occasionally emits despite the
    # prefill (e.g. "```json\n{ ... }\n```" → "{ ... }").
    if text.startswith("```"):
        # Drop the opening fence line.
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        # Drop a trailing closing fence.
        if text.rstrip().endswith("```"):
            text = text.rstrip()[: -3].rstrip()
    # Re-attach the prefilled opening brace. We MUST do this before
    # balanced-brace extraction, otherwise the first ``{`` we see is the
    # nested ``"match": {`` and the counter exits early.
    if not text.startswith("{"):
        text = "{" + text

    candidate = _extract_first_json_object(text)

    try:
        json_lib.loads(candidate)
        return candidate
    except json_lib.JSONDecodeError:
        pass

    if _repair_json is not None:
        try:
            repaired = _repair_json(candidate, return_objects=False)
            if isinstance(repaired, (bytes, bytearray)):
                repaired = repaired.decode("utf-8", errors="replace")
            repaired = str(repaired or "").strip()
            if repaired:
                # Sanity check — only accept the repaired string if it
                # round-trips through the strict parser. Otherwise we'd be
                # handing the caller something even worse than the original.
                try:
                    json_lib.loads(repaired)
                    logger.warning(
                        "anthropic_json_repaired",
                        original_len=len(candidate),
                        repaired_len=len(repaired),
                    )
                    return repaired
                except json_lib.JSONDecodeError:
                    pass
        except Exception as repair_exc:  # noqa: BLE001 - best-effort
            logger.warning(
                "anthropic_json_repair_failed",
                error=str(repair_exc)[:200],
            )

    return candidate


def _extract_first_json_object(text: str) -> str:
    """Return the first balanced ``{...}`` substring of ``text``.

    Walks the string with a brace counter that tracks whether we are inside
    a JSON string literal so that braces / quotes embedded in values do
    not confuse the scan. If no balanced object is found, the input is
    returned unchanged (so downstream parsing fails on something
    inspectable, not on an empty string).
    """
    start = text.find("{")
    if start < 0:
        return text
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


async def _call_anthropic(
    client: AsyncAnthropic,
    *,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    temperature: float | None,
    response_format: dict[str, Any] | None,
) -> _ChatCompletion:
    """Translate OpenAI-shape kwargs to Anthropic Messages API and wrap the
    response so it quacks like an OpenAI ChatCompletion.
    """
    system_text, anthropic_messages = _split_system_and_messages(messages)

    # JSON mode: Anthropic has no native flag. Use the prefill technique —
    # strengthen the system prompt + start the assistant turn with ``{`` so
    # Claude continues writing a JSON object. We re-prepend ``{`` to the
    # text we extract.
    json_mode = bool(response_format) and (response_format or {}).get("type") == "json_object"
    if json_mode:
        json_instruction = (
            "Respond with a single valid JSON object. "
            "Do not include prose, markdown fences, comments, or trailing text."
        )
        system_text = (system_text + "\n\n" + json_instruction).strip()
        anthropic_messages = anthropic_messages + [
            {"role": "assistant", "content": "{"}
        ]

    # Anthropic requires the last message to be from the user OR a prefill
    # assistant. If the caller sent only a system + user, we're fine; if
    # the message list is empty (shouldn't happen, but defensive) fail
    # explicitly rather than 400-ing.
    if not anthropic_messages:
        raise AIParsingError("LLM fallback received no user/assistant messages.")

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": anthropic_messages,
    }
    if system_text:
        kwargs["system"] = system_text
    if temperature is not None:
        kwargs["temperature"] = temperature

    resp = await client.messages.create(**kwargs)

    text_parts: list[str] = []
    for block in getattr(resp, "content", []) or []:
        t = getattr(block, "text", None)
        if t:
            text_parts.append(t)
    text = "".join(text_parts)

    if json_mode:
        text = _normalize_anthropic_json(text)

    usage_obj = getattr(resp, "usage", None)
    in_t = int(getattr(usage_obj, "input_tokens", 0) or 0)
    out_t = int(getattr(usage_obj, "output_tokens", 0) or 0)
    return _ChatCompletion(
        id=str(getattr(resp, "id", "") or ""),
        model=str(getattr(resp, "model", model) or model),
        choices=[
            _Choice(
                index=0,
                message=_Message(content=text),
                finish_reason=getattr(resp, "stop_reason", None),
            )
        ],
        usage=_Usage(
            prompt_tokens=in_t,
            completion_tokens=out_t,
            total_tokens=in_t + out_t,
        ),
        provider="anthropic",
    )


# ── Public wrapper that looks like AsyncOpenAI ────────────────────────────


class _CompletionsNamespace:
    def __init__(self, parent: "LLMFallbackClient"):
        self._parent = parent

    async def create(self, **kwargs: Any) -> Any:
        return await self._parent._chat_completions_create(**kwargs)


class _ChatNamespace:
    def __init__(self, parent: "LLMFallbackClient"):
        self.completions = _CompletionsNamespace(parent)


class LLMFallbackClient:
    """Drop-in replacement for ``AsyncOpenAI`` with Anthropic fallback.

    Exposes ``client.chat.completions.create(**openai_shape_kwargs)``. On a
    recoverable OpenAI error and when Anthropic is configured, the same
    request is retried against Anthropic with equivalent semantics.

    A circuit breaker prevents wasting time on a known-bad OpenAI endpoint.
    After ``threshold`` consecutive failures the breaker trips OPEN and all
    requests skip OpenAI for ``cooldown`` seconds, going directly to
    Anthropic.  After the cooldown a single probe request tests whether
    OpenAI has recovered.
    """

    def __init__(
        self,
        openai_client: AsyncOpenAI | None,
        anthropic_client: AsyncAnthropic | None,
    ) -> None:
        self._openai = openai_client
        self._anthropic = anthropic_client
        self.chat = _ChatNamespace(self)
        settings = get_settings()
        self._cb = _CircuitBreaker(
            threshold=settings.llm_circuit_breaker_threshold,
            cooldown=settings.llm_circuit_breaker_cooldown_seconds,
        )

    @property
    def has_primary(self) -> bool:
        return self._openai is not None

    @property
    def has_fallback(self) -> bool:
        return self._anthropic is not None

    async def _chat_completions_create(self, **kwargs: Any) -> Any:
        settings = get_settings()
        primary_error: Exception | None = None

        # Decide whether to attempt OpenAI.  When the circuit breaker is
        # OPEN we skip OpenAI entirely — unless there is no fallback, in
        # which case trying a possibly-broken OpenAI is better than giving
        # up immediately.
        skip_primary = (
            self._openai is not None
            and self.has_fallback
            and not self._cb.should_attempt_primary()
        )

        if skip_primary:
            logger.debug(
                "llm_openai_skipped_circuit_open",
                circuit_state=self._cb.state,
                cooldown_remaining=round(self._cb.cooldown_remaining, 1),
            )

        if self._openai is not None and not skip_primary:
            try:
                result = await self._openai.chat.completions.create(**kwargs)
                self._cb.record_success()
                return result
            except OPENAI_FALLBACK_ERRORS as e:
                primary_error = e
                self._cb.record_failure(e)
                logger.warning(
                    "llm_openai_failed_will_try_fallback",
                    error_type=type(e).__name__,
                    error=str(e)[:300],
                    fallback_available=self.has_fallback,
                    circuit_state=self._cb.state,
                    consecutive_failures=self._cb._consecutive_failures,
                )

        if not self.has_fallback:
            if primary_error is not None:
                raise primary_error
            raise AIParsingError(
                "No LLM provider available. Set OPENAI_API_KEY or ANTHROPIC_API_KEY."
            )

        messages = kwargs.get("messages") or []
        max_tokens = int(kwargs.get("max_tokens") or settings.anthropic_max_tokens)
        temperature = kwargs.get("temperature")
        response_format = kwargs.get("response_format")
        anthropic_model = settings.anthropic_model

        try:
            result = await _call_anthropic(
                self._anthropic,  # type: ignore[arg-type]
                model=anthropic_model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                response_format=response_format,
            )
            logger.info(
                "llm_fallback_used",
                provider="anthropic",
                model=anthropic_model,
                openai_error=type(primary_error).__name__ if primary_error else None,
                openai_skipped=skip_primary,
            )
            return result
        except Exception as fallback_exc:
            logger.exception(
                "llm_anthropic_fallback_failed",
                error=str(fallback_exc)[:300],
                fallback_error_type=type(fallback_exc).__name__,
                primary_error_type=type(primary_error).__name__
                if primary_error
                else None,
            )
            if primary_error is not None:
                combined = AIParsingError(
                    "Both LLM providers failed. "
                    f"OpenAI: {type(primary_error).__name__}: {str(primary_error)[:200]}. "
                    f"Anthropic: {type(fallback_exc).__name__}: {str(fallback_exc)[:200]}."
                )
                raise combined from fallback_exc
            raise


# ── Construction & caching ────────────────────────────────────────────────


_clients: dict[str, LLMFallbackClient] = {}


def _cache_key(openai_key: str, anthropic_key: str) -> str:
    h = hashlib.sha256(f"{openai_key}|{anthropic_key}".encode()).hexdigest()
    return h[:24]


def _build_openai_client(api_key: str) -> AsyncOpenAI | None:
    if not api_key:
        return None
    settings = get_settings()
    t = settings.openai_timeout_seconds
    return AsyncOpenAI(
        api_key=api_key,
        max_retries=0,
        timeout=httpx.Timeout(t, connect=min(30.0, t)),
    )


def _build_anthropic_client(api_key: str) -> AsyncAnthropic | None:
    if not api_key:
        return None
    settings = get_settings()
    t = settings.anthropic_timeout_seconds
    return AsyncAnthropic(
        api_key=api_key,
        max_retries=0,
        timeout=httpx.Timeout(t, connect=min(30.0, t)),
    )


def get_llm_client(
    *,
    openai_api_key: str | None = None,
    anthropic_api_key: str | None = None,
) -> LLMFallbackClient:
    """Return a cached multi-provider client.

    Either key may be empty; at least one must be present. When
    ``llm_fallback_enabled`` is False the Anthropic key is ignored (so the
    behaviour matches the previous OpenAI-only flow).
    """
    settings = get_settings()
    # ``None`` → fall back to settings; ``""`` → explicit disable.
    o_key = (
        openai_api_key if openai_api_key is not None else settings.openai_api_key or ""
    ).strip()
    a_key = (
        anthropic_api_key
        if anthropic_api_key is not None
        else settings.anthropic_api_key or ""
    ).strip()

    if not settings.llm_fallback_enabled:
        a_key = ""

    if not o_key and not a_key:
        raise AIParsingError(
            "No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY."
        )

    ck = _cache_key(o_key, a_key)
    if ck in _clients:
        return _clients[ck]

    client = LLMFallbackClient(
        openai_client=_build_openai_client(o_key),
        anthropic_client=_build_anthropic_client(a_key),
    )
    _clients[ck] = client
    logger.info(
        "llm_client_initialized",
        openai_available=client.has_primary,
        anthropic_available=client.has_fallback,
        langfuse_tracing=_LANGFUSE_AVAILABLE and settings.langfuse_enabled,
    )
    return client


async def get_llm_client_for_user(user_id: str | None) -> LLMFallbackClient:
    """Resolve the LLM client for a user.

    The OpenAI key follows the existing per-user resolution (custom key
    when the user opted in, otherwise the system key). Anthropic is always
    sourced from the server's ``ANTHROPIC_API_KEY`` env var — users cannot
    bring their own Anthropic key yet, but they automatically benefit from
    the operator's fallback when their OpenAI quota is exhausted.
    """
    settings = get_settings()
    a_key = settings.anthropic_api_key
    if not user_id:
        return get_llm_client(anthropic_api_key=a_key)

    from app.storage.database import get_session
    from app.storage.user_repository import UserRepository

    async with get_session() as session:
        repo = UserRepository(session)
        openai_key = await repo.resolve_openai_api_key(user_id)
    return get_llm_client(openai_api_key=openai_key, anthropic_api_key=a_key)
