"""Select the best extracted plain text from multiple extraction attempts."""

from __future__ import annotations


def pick_best_text(candidates: list[tuple[str, str]]) -> tuple[str, str]:
    """
    From a list of ``(plain_text, method_name)`` tuples, pick the best extraction.

    Selection rule: the longest non-trivial text wins.  This is intentionally
    simple — the downstream LLM is far better at identifying job content than
    any heuristic scoring.

    Returns ``("", "none")`` if no candidate has sufficient content.
    """
    MIN_LENGTH = 50
    valid = [(t, m) for t, m in candidates if t and len(t.strip()) >= MIN_LENGTH]
    if not valid:
        return ("", "none")
    return max(valid, key=lambda x: len(x[0]))
