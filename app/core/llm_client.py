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
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import openai as _openai_pkg
import anthropic as _anthropic_pkg
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

# Gemini is reached through the OpenAI-compatible endpoint using the OpenAI SDK,
# so it raises the same ``openai.*`` exception types — reuse the same set.
GEMINI_FALLBACK_ERRORS: tuple[type[Exception], ...] = OPENAI_FALLBACK_ERRORS

# Equivalent recoverable-error classification for a primary Anthropic provider.
ANTHROPIC_FALLBACK_ERRORS: tuple[type[Exception], ...] = (
    _anthropic_pkg.RateLimitError,
    _anthropic_pkg.AuthenticationError,
    _anthropic_pkg.PermissionDeniedError,
    _anthropic_pkg.APIConnectionError,
    _anthropic_pkg.APITimeoutError,
    _anthropic_pkg.InternalServerError,
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


def _coerce_json_object(raw_text: str) -> str:
    """Best-effort coerce arbitrary model output into a single valid JSON object.

    Unlike ``_normalize_anthropic_json`` this does NOT assume a prefilled ``{``.
    Used for the Gemini (OpenAI-compatible) path, where JSON mode is requested
    but the model may still wrap output in a ```` ```json ```` fence or append
    trailing prose. Strategy mirrors the Anthropic recovery: strip fences →
    extract the outermost balanced object → strict parse → json-repair.
    """
    text = (raw_text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3].rstrip()

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
                try:
                    json_lib.loads(repaired)
                    logger.warning(
                        "gemini_json_repaired",
                        original_len=len(candidate),
                        repaired_len=len(repaired),
                    )
                    return repaired
                except json_lib.JSONDecodeError:
                    pass
        except Exception as repair_exc:  # noqa: BLE001 - best-effort
            logger.warning("gemini_json_repair_failed", error=str(repair_exc)[:200])

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


async def _stream_anthropic(
    client: AsyncAnthropic,
    *,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    temperature: float | None,
) -> AsyncIterator[str]:
    """Stream plain-text deltas from the Anthropic Messages API.

    Mirrors ``_call_anthropic`` but yields text incrementally. JSON mode is not
    supported here — this path is for free-text assistant chat only.
    """
    system_text, anthropic_messages = _split_system_and_messages(messages)
    if not anthropic_messages:
        raise AIParsingError("LLM stream received no user/assistant messages.")

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": anthropic_messages,
    }
    if system_text:
        kwargs["system"] = system_text
    if temperature is not None:
        kwargs["temperature"] = temperature

    async with client.messages.stream(**kwargs) as stream:
        async for text in stream.text_stream:
            if text:
                yield text


# ── Provider adapters ─────────────────────────────────────────────────────
#
# Each adapter exposes ``async create(**openai_shape_kwargs) -> response`` and a
# ``recoverable_errors`` tuple used by the fallback loop. OpenAI and Gemini both
# speak the OpenAI Chat Completions API (Gemini via Google's OpenAI-compatible
# endpoint), so they share the same SDK; Anthropic uses its native Messages API.
#
# Every adapter overrides the incoming ``model`` kwarg with its own provider's
# configured model, so existing call sites can keep passing ``settings.openai_model``.

LLM_PROVIDERS: tuple[str, ...] = ("openai", "anthropic", "gemini")


class _OpenAIAdapter:
    """OpenAI (or any OpenAI-compatible endpoint) returning the native response.

    Used for the ``openai`` provider so Langfuse tracing on the underlying
    client is preserved.
    """

    name = "openai"
    recoverable_errors = OPENAI_FALLBACK_ERRORS

    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def create(self, **kwargs: Any) -> Any:
        kwargs = dict(kwargs)
        kwargs["model"] = self._model
        return await self._client.chat.completions.create(**kwargs)

    async def stream(self, **kwargs: Any) -> AsyncIterator[str]:
        async for delta in _stream_openai_compatible(self._client, self._model, **kwargs):
            yield delta


class _GeminiAdapter:
    """Gemini via the OpenAI-compatible endpoint.

    Returns a normalised ``_ChatCompletion`` so a JSON-mode response is coerced
    into a strictly-parseable object (Gemini occasionally wraps JSON in a fence
    or appends trailing text), mirroring the Anthropic JSON recovery.
    """

    name = "gemini"
    recoverable_errors = GEMINI_FALLBACK_ERRORS

    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def create(self, **kwargs: Any) -> Any:
        kwargs = dict(kwargs)
        kwargs["model"] = self._model
        response_format = kwargs.get("response_format")
        json_mode = bool(response_format) and (response_format or {}).get("type") == "json_object"

        resp = await self._client.chat.completions.create(**kwargs)
        text = ""
        try:
            text = resp.choices[0].message.content or ""
        except (AttributeError, IndexError):
            text = ""
        if json_mode:
            text = _coerce_json_object(text)

        usage_obj = getattr(resp, "usage", None)
        in_t = int(getattr(usage_obj, "prompt_tokens", 0) or 0)
        out_t = int(getattr(usage_obj, "completion_tokens", 0) or 0)
        return _ChatCompletion(
            id=str(getattr(resp, "id", "") or ""),
            model=str(getattr(resp, "model", self._model) or self._model),
            choices=[_Choice(index=0, message=_Message(content=text))],
            usage=_Usage(prompt_tokens=in_t, completion_tokens=out_t, total_tokens=in_t + out_t),
            provider="gemini",
        )

    async def stream(self, **kwargs: Any) -> AsyncIterator[str]:
        async for delta in _stream_openai_compatible(self._client, self._model, **kwargs):
            yield delta


class _AnthropicAdapter:
    name = "anthropic"
    recoverable_errors = ANTHROPIC_FALLBACK_ERRORS

    def __init__(self, client: AsyncAnthropic, model: str, default_max_tokens: int) -> None:
        self._client = client
        self._model = model
        self._default_max_tokens = default_max_tokens

    async def create(self, **kwargs: Any) -> Any:
        return await _call_anthropic(
            self._client,
            model=self._model,
            messages=kwargs.get("messages") or [],
            max_tokens=int(kwargs.get("max_tokens") or self._default_max_tokens),
            temperature=kwargs.get("temperature"),
            response_format=kwargs.get("response_format"),
        )

    async def stream(self, **kwargs: Any) -> AsyncIterator[str]:
        async for delta in _stream_anthropic(
            self._client,
            model=self._model,
            messages=kwargs.get("messages") or [],
            max_tokens=int(kwargs.get("max_tokens") or self._default_max_tokens),
            temperature=kwargs.get("temperature"),
        ):
            yield delta


def _stream_openai_compatible(
    client: AsyncOpenAI, model: str, **kwargs: Any
) -> AsyncIterator[str]:
    """Yield text deltas from an OpenAI-compatible chat-completions stream."""

    async def _gen() -> AsyncIterator[str]:
        call_kwargs = dict(kwargs)
        call_kwargs["model"] = model
        call_kwargs["stream"] = True
        # JSON mode is incompatible with the free-text streaming path.
        call_kwargs.pop("response_format", None)
        stream = await client.chat.completions.create(**call_kwargs)
        async for chunk in stream:
            try:
                delta = chunk.choices[0].delta.content
            except (AttributeError, IndexError):
                delta = None
            if delta:
                yield delta

    return _gen()


_Adapter = _OpenAIAdapter | _GeminiAdapter | _AnthropicAdapter


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
    """Drop-in replacement for ``AsyncOpenAI`` with multi-provider fallback.

    Exposes ``client.chat.completions.create(**openai_shape_kwargs)``. The
    user-selected provider is the *primary*; on a recoverable error (and when
    ``llm_fallback_enabled``) the same request is retried against each other
    configured provider in order.

    A circuit breaker prevents wasting time on a known-bad primary endpoint.
    After ``threshold`` consecutive failures the breaker trips OPEN and all
    requests skip the primary for ``cooldown`` seconds, going directly to the
    fallbacks.  After the cooldown a single probe request tests recovery.
    """

    def __init__(self, adapters: list[_Adapter]) -> None:
        self._adapters = adapters
        self.chat = _ChatNamespace(self)
        settings = get_settings()
        self._cb = _CircuitBreaker(
            threshold=settings.llm_circuit_breaker_threshold,
            cooldown=settings.llm_circuit_breaker_cooldown_seconds,
        )

    @property
    def primary_provider(self) -> str | None:
        return self._adapters[0].name if self._adapters else None

    @property
    def has_primary(self) -> bool:
        return len(self._adapters) >= 1

    @property
    def has_fallback(self) -> bool:
        return len(self._adapters) >= 2

    async def _chat_completions_create(self, **kwargs: Any) -> Any:
        if not self._adapters:
            raise AIParsingError(
                "No LLM provider configured. Set an API key for OpenAI, Anthropic, or Gemini."
            )

        primary = self._adapters[0]
        fallbacks = self._adapters[1:]
        primary_error: Exception | None = None

        # When the circuit breaker is OPEN we skip the primary entirely — unless
        # there is no fallback, in which case trying a possibly-broken primary is
        # better than giving up immediately.
        skip_primary = bool(fallbacks) and not self._cb.should_attempt_primary()
        if skip_primary:
            logger.debug(
                "llm_primary_skipped_circuit_open",
                provider=primary.name,
                circuit_state=self._cb.state,
                cooldown_remaining=round(self._cb.cooldown_remaining, 1),
            )

        if not skip_primary:
            try:
                result = await primary.create(**kwargs)
                self._cb.record_success()
                return result
            except primary.recoverable_errors as e:
                primary_error = e
                self._cb.record_failure(e)
                logger.warning(
                    "llm_primary_failed_will_try_fallback",
                    provider=primary.name,
                    error_type=type(e).__name__,
                    error=str(e)[:300],
                    fallback_available=bool(fallbacks),
                    circuit_state=self._cb.state,
                    consecutive_failures=self._cb._consecutive_failures,
                )

        if not fallbacks:
            if primary_error is not None:
                raise primary_error
            raise AIParsingError("No LLM provider available for this request.")

        last_fallback_error: Exception | None = None
        for fb in fallbacks:
            try:
                result = await fb.create(**kwargs)
                logger.info(
                    "llm_fallback_used",
                    provider=fb.name,
                    primary=primary.name,
                    primary_error=type(primary_error).__name__ if primary_error else None,
                    primary_skipped=skip_primary,
                )
                return result
            except Exception as fb_exc:  # noqa: BLE001 - try every fallback
                last_fallback_error = fb_exc
                logger.warning(
                    "llm_fallback_provider_failed",
                    provider=fb.name,
                    error_type=type(fb_exc).__name__,
                    error=str(fb_exc)[:300],
                )
                continue

        logger.exception(
            "llm_all_providers_failed",
            primary=primary.name,
            primary_error_type=type(primary_error).__name__ if primary_error else None,
            last_fallback_error_type=type(last_fallback_error).__name__
            if last_fallback_error
            else None,
        )
        parts: list[str] = []
        if primary_error is not None:
            parts.append(f"{primary.name}: {type(primary_error).__name__}: {str(primary_error)[:200]}")
        if last_fallback_error is not None:
            parts.append(
                f"fallback: {type(last_fallback_error).__name__}: {str(last_fallback_error)[:200]}"
            )
        combined = AIParsingError("All LLM providers failed. " + " | ".join(parts))
        if last_fallback_error is not None:
            raise combined from last_fallback_error
        raise combined

    async def stream_chat(
        self,
        *,
        messages: list[dict[str, Any]],
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> AsyncIterator[str]:
        """Stream a free-text assistant answer as incremental text deltas.

        The user-selected provider is tried first; if it fails *before* emitting
        any token (and a fallback is configured) the next provider is tried.
        Once any text has been streamed we cannot safely switch providers, so a
        mid-stream failure is propagated.
        """
        if not self._adapters:
            raise AIParsingError(
                "No LLM provider configured. Set an API key for OpenAI, Anthropic, or Gemini."
            )

        primary = self._adapters[0]
        fallbacks = self._adapters[1:]
        skip_primary = bool(fallbacks) and not self._cb.should_attempt_primary()

        providers = ([] if skip_primary else [primary]) + fallbacks
        last_error: Exception | None = None

        for adapter in providers:
            produced = False
            try:
                async for delta in adapter.stream(
                    messages=messages, temperature=temperature, max_tokens=max_tokens
                ):
                    produced = True
                    yield delta
                if adapter is primary:
                    self._cb.record_success()
                return
            except Exception as exc:  # noqa: BLE001 - try every provider until one streams
                last_error = exc
                if adapter is primary:
                    self._cb.record_failure(exc)
                if produced:
                    # Partial output already delivered; cannot fall back cleanly.
                    logger.warning(
                        "llm_stream_failed_after_partial",
                        provider=adapter.name,
                        error=str(exc)[:300],
                    )
                    raise
                logger.warning(
                    "llm_stream_provider_failed",
                    provider=adapter.name,
                    error_type=type(exc).__name__,
                    error=str(exc)[:300],
                )
                continue

        raise AIParsingError(
            "All LLM providers failed (streaming). "
            + (f"{type(last_error).__name__}: {str(last_error)[:200]}" if last_error else "")
        )


# ── Construction & caching ────────────────────────────────────────────────


_clients: dict[str, LLMFallbackClient] = {}


def _cache_key(provider: str, openai_key: str, anthropic_key: str, gemini_key: str) -> str:
    raw = f"{provider}|{openai_key}|{anthropic_key}|{gemini_key}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


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


def _build_gemini_client(api_key: str) -> AsyncOpenAI | None:
    if not api_key:
        return None
    settings = get_settings()
    t = settings.gemini_timeout_seconds
    # Plain OpenAI SDK pointed at Google's OpenAI-compatible endpoint. We use the
    # base ``openai.AsyncOpenAI`` (not the Langfuse wrapper) to avoid attributing
    # Gemini calls to OpenAI in traces.
    from openai import AsyncOpenAI as _BaseAsyncOpenAI

    return _BaseAsyncOpenAI(
        api_key=api_key,
        base_url=settings.gemini_base_url,
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


def _build_adapter(provider: str, api_key: str) -> _Adapter | None:
    if not api_key:
        return None
    settings = get_settings()
    if provider == "openai":
        client = _build_openai_client(api_key)
        return _OpenAIAdapter(client, settings.openai_model) if client else None
    if provider == "gemini":
        client = _build_gemini_client(api_key)
        return _GeminiAdapter(client, settings.gemini_model) if client else None
    if provider == "anthropic":
        client = _build_anthropic_client(api_key)
        return (
            _AnthropicAdapter(client, settings.anthropic_model, settings.anthropic_max_tokens)
            if client
            else None
        )
    return None


def _normalize_provider(provider: str | None) -> str:
    p = (provider or "").strip().lower()
    if p in LLM_PROVIDERS:
        return p
    return get_settings().default_llm_provider


def get_llm_client(
    *,
    provider: str | None = None,
    openai_api_key: str | None = None,
    anthropic_api_key: str | None = None,
    gemini_api_key: str | None = None,
) -> LLMFallbackClient:
    """Return a cached multi-provider client.

    ``provider`` is the user's preferred primary provider; the others act as
    ordered fallbacks when ``llm_fallback_enabled`` is True. Any key may be
    empty; at least one configured provider must remain.

    For each key argument: ``None`` → fall back to the server env value;
    ``""`` → explicit disable for that provider.
    """
    settings = get_settings()
    provider = _normalize_provider(provider)

    def _resolve(arg: str | None, env_default: str) -> str:
        return (arg if arg is not None else (env_default or "")).strip()

    keys = {
        "openai": _resolve(openai_api_key, settings.openai_api_key),
        "anthropic": _resolve(anthropic_api_key, settings.anthropic_api_key),
        "gemini": _resolve(gemini_api_key, settings.gemini_api_key),
    }

    # Primary first, then the remaining providers in a stable order. When
    # fallback is disabled, only the selected provider is used.
    order = [provider] + [p for p in LLM_PROVIDERS if p != provider]
    if not settings.llm_fallback_enabled:
        order = [provider]

    if not any(keys[p] for p in order):
        raise AIParsingError(
            "No LLM provider configured. Set an API key for OpenAI, Anthropic, or Gemini."
        )

    ck = _cache_key(provider, keys["openai"], keys["anthropic"], keys["gemini"])
    if ck in _clients:
        return _clients[ck]

    adapters: list[_Adapter] = []
    for p in order:
        adapter = _build_adapter(p, keys[p])
        if adapter is not None:
            adapters.append(adapter)

    if not adapters:
        raise AIParsingError("No LLM provider available for this request.")

    client = LLMFallbackClient(adapters)
    _clients[ck] = client
    logger.info(
        "llm_client_initialized",
        primary_provider=client.primary_provider,
        providers=[a.name for a in adapters],
        fallback_enabled=settings.llm_fallback_enabled,
        langfuse_tracing=_LANGFUSE_AVAILABLE and settings.langfuse_enabled,
    )
    return client


async def get_llm_client_for_user(user_id: str | None) -> LLMFallbackClient:
    """Resolve the LLM client for a user.

    The user's selected provider becomes the primary. Each provider's key
    follows per-user resolution (a custom encrypted key when opted in, else the
    server env key). The other configured providers remain available as
    ordered fallbacks when ``llm_fallback_enabled``.
    """
    if not user_id:
        return get_llm_client()

    from app.storage.database import get_session
    from app.storage.user_repository import UserRepository

    async with get_session() as session:
        repo = UserRepository(session)
        provider = await repo.resolve_llm_provider(user_id)
        openai_key = await repo.resolve_provider_api_key(user_id, "openai")
        anthropic_key = await repo.resolve_provider_api_key(user_id, "anthropic")
        gemini_key = await repo.resolve_provider_api_key(user_id, "gemini")

    return get_llm_client(
        provider=provider,
        openai_api_key=openai_key,
        anthropic_api_key=anthropic_key,
        gemini_api_key=gemini_key,
    )
