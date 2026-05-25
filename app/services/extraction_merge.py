"""Select the best extracted plain text from multiple extraction attempts.

We score each candidate by how strongly it looks like a real job description
(keyword density of typical JD sections) and penalise candidates that are
dominated by navigation/footer/cookie/login chrome.  Length is still a
factor but only as a tiebreaker between similarly-scoring candidates so a
huge marketing-heavy careers page no longer beats a focused JD payload from
Lever/Ashby/Greenhouse.
"""

from __future__ import annotations

import math
import re
from typing import Iterable

MIN_LENGTH = 50

# Strong job-description signal words.  Matched case-insensitively as whole words.
_JD_SIGNAL_WORDS: tuple[str, ...] = (
    "responsibilities", "responsibility",
    "requirements", "requirement", "qualifications", "qualification",
    "experience", "experiences",
    "skills", "skill",
    "what you will do", "what you'll do", "what you will be doing",
    "what you bring", "what we are looking for", "what we're looking for",
    "you will", "you'll",
    "must have", "nice to have", "preferred", "minimum",
    "benefits", "perks", "compensation", "salary", "equity",
    "apply", "apply now", "submit your application",
    "about the role", "about the team", "about the position", "about us",
    "job description", "job summary", "role description",
    "duties", "responsible for",
    "education", "bachelor", "master", "phd", "degree",
    "years of experience", "years experience",
    "we offer", "we provide", "we're hiring", "we are hiring", "join us",
)

# Phrases that suggest the page is chrome, not the JD.
_NEGATIVE_PHRASES: tuple[str, ...] = (
    "accept cookies", "cookie policy", "manage cookies", "we use cookies",
    "privacy policy", "terms of service", "all rights reserved",
    "sign in to continue", "please log in", "please sign in",
    "log in to view", "create an account",
    "subscribe to our newsletter", "follow us on",
    "404", "page not found", "this page is unavailable",
    "captcha", "are you a robot", "verifying you are human",
)

_WORD_RE = re.compile(r"\b[\w'-]+\b")
_SIGNAL_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(p) for p in _JD_SIGNAL_WORDS) + r")\b",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"(?:" + "|".join(re.escape(p) for p in _NEGATIVE_PHRASES) + r")",
    re.IGNORECASE,
)


def _signal_score(text: str) -> float:
    """0..~1 score: distinct JD signal phrases per ~1k chars, capped."""
    if not text:
        return 0.0
    signals = {m.group(0).lower() for m in _SIGNAL_RE.finditer(text)}
    if not signals:
        return 0.0
    density = len(signals) / max(1, len(text) / 1000)
    return min(1.0, density / 6.0)


def _negative_penalty(text: str) -> float:
    """0..1 penalty proportional to chrome/wall phrases."""
    if not text:
        return 0.0
    hits = sum(1 for _ in _NEGATIVE_RE.finditer(text))
    return min(0.8, hits * 0.15)


def _length_score(text: str) -> float:
    """Soft log-style length boost, saturating around ~6k chars."""
    if not text:
        return 0.0
    n = len(text)
    return min(1.0, math.log10(max(n, 10)) / math.log10(6000))


def _quality_score(text: str) -> float:
    return _signal_score(text) - _negative_penalty(text) + (_length_score(text) * 0.4)


def pick_best_text(candidates: Iterable[tuple[str, str]]) -> tuple[str, str]:
    """Pick the best ``(plain_text, method_name)`` candidate.

    Selection rule: highest JD-quality score, with length as a tiebreaker.
    Returns ``("", "none")`` if no candidate has sufficient content.
    """
    valid = [
        (t, m) for t, m in candidates
        if t and len(t.strip()) >= MIN_LENGTH
    ]
    if not valid:
        return ("", "none")

    return max(
        valid,
        key=lambda x: (_quality_score(x[0]), len(x[0])),
    )
