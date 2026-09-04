"""User-facing messages for profile / résumé-parse failures.

LLM providers and Pydantic often return noisy internals (invalid API keys,
``extra_forbidden``, JSON decode dumps). The profile page surfaces these as
notifications, so the text here must be short and actionable.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

_API_KEY_MARKERS = (
    "api key",
    "invalid_api_key",
    "incorrect api key",
    "authenticationerror",
    "invalid api-key",
    "no api key",
    "missing api key",
    "unauthorized",
    "no llm provider",
)


def _loc_path(loc: tuple[Any, ...] | list[Any]) -> str:
    parts = [str(p) for p in loc if p not in ("body", "__root__")]
    return ".".join(parts)


def format_validation_error(exc: ValidationError, fallback: str) -> str:
    """Turn a Pydantic ValidationError into a short field-level summary."""
    bits: list[str] = []
    for err in exc.errors()[:6]:
        loc = _loc_path(err.get("loc") or ())
        err_type = str(err.get("type") or "")
        msg = str(err.get("msg") or "Invalid value").rstrip(".")
        if err_type == "extra_forbidden" or "extra inputs are not permitted" in msg.lower():
            label = loc or "unknown field"
            bits.append(f"Unexpected field '{label}'")
            continue
        bits.append(f"{loc}: {msg}" if loc else msg)
    if not bits:
        return fallback
    more = f" (+{len(exc.errors()) - 6} more)" if len(exc.errors()) > 6 else ""
    return "; ".join(bits) + more


def format_http_validation_detail(detail: Any, fallback: str) -> str:
    """Format FastAPI 422 ``detail`` (string or list of ``{loc, msg, type}``)."""
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    if not isinstance(detail, list) or not detail:
        return fallback
    bits: list[str] = []
    for item in detail[:6]:
        if isinstance(item, str) and item.strip():
            bits.append(item.strip())
            continue
        if not isinstance(item, dict):
            continue
        loc = _loc_path(tuple(item.get("loc") or ()))
        err_type = str(item.get("type") or "")
        msg = str(item.get("msg") or "Invalid value").rstrip(".")
        if err_type == "extra_forbidden" or "extra inputs are not permitted" in msg.lower():
            bits.append(f"Unexpected field '{loc or 'unknown'}'")
            continue
        bits.append(f"{loc}: {msg}" if loc else msg)
    if not bits:
        return fallback
    more = f" (+{len(detail) - 6} more)" if len(detail) > 6 else ""
    return "; ".join(bits) + more


def looks_like_invalid_api_key(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in _API_KEY_MARKERS) and (
        "401" in low
        or "invalid" in low
        or "incorrect" in low
        or "unauthorized" in low
        or "missing" in low
        or "deactivat" in low
        or "authenticationerror" in low
        or "no api key" in low
        or "no llm provider" in low
    )


def format_profile_unexpected_error(exc: BaseException | str, fallback: str) -> str:
    """Map parse / key / validation failures to a notification-ready sentence."""
    text = (exc if isinstance(exc, str) else str(exc) or "").strip()
    low = text.lower()

    if looks_like_invalid_api_key(text) or "no llm provider" in low:
        return (
            "AI request failed: invalid or missing API key. "
            "Update your key in My Preferences and try again."
        )

    if isinstance(exc, ValidationError):
        return format_validation_error(exc, fallback)

    if "extra_forbidden" in low or "extra inputs are not permitted" in low:
        return (
            "Profile data has unexpected fields the server could not accept. "
            "Re-save after fixing highlighted inputs, or import again."
        )

    if "json" in low and ("parse" in low or "decode" in low or "expecting" in low):
        return "Could not parse the AI response. Please try again, or fill the profile manually."

    if "failed to parse extracted profile json" in low:
        return "Could not parse the extracted résumé. Please try again, or fill the profile manually."

    if not text:
        return fallback
    if len(text) > 280:
        return f"{text[:277]}…"
    return text
