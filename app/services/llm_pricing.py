"""List prices for the models NAO calls, used to turn token counts into dollars.

USD per 1M tokens as (input, output). Reasoning tokens are already inside the
completion count the providers report, and they bill at the output rate.
Lookups match the longest known prefix, so dated ids such as
``gpt-5.1-2025-11-13`` resolve to ``gpt-5.1``. Unknown models return None
rather than a guess.
"""

from __future__ import annotations

_PRICES_PER_MILLION: dict[str, tuple[float, float]] = {
    "gpt-5.1-mini": (0.25, 2.00),
    "gpt-5.1": (1.25, 10.00),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5-nano": (0.05, 0.40),
    "gpt-5": (1.25, 10.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "o4-mini": (1.10, 4.40),
    "o3": (2.00, 8.00),
    "claude-opus-4-5": (5.00, 25.00),
    "claude-opus-4": (15.00, 75.00),
    "claude-sonnet-4": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-3-5-haiku": (0.80, 4.00),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.5-flash": (0.30, 2.50),
}
_PREFIXES = sorted(_PRICES_PER_MILLION, key=len, reverse=True)


def model_price(model: str | None) -> tuple[float, float] | None:
    name = (model or "").strip().lower()
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    if name.startswith("models/"):
        name = name[len("models/"):]
    for prefix in _PREFIXES:
        if name.startswith(prefix):
            return _PRICES_PER_MILLION[prefix]
    return None


def estimate_cost_usd(model: str | None, prompt_tokens: int, completion_tokens: int) -> float | None:
    price = model_price(model)
    if price is None:
        return None
    input_rate, output_rate = price
    return round((prompt_tokens * input_rate + completion_tokens * output_rate) / 1_000_000, 6)
