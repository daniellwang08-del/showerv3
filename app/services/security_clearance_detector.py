"""Deterministic U.S. security-clearance requirement detection.

Replaces the LLM's Phase A Task 1 (a keyword judgment call) with a regex
gate that runs in microseconds before any model call. The phrase list is
ported from ``job_match_phase_a_prompt.py`` and extended with the common
real-world variants; a negation window prevents "no clearance required"
style postings from being excluded.

Positive = the posting requires the candidate to hold, maintain, or be
eligible for a U.S. government security clearance.
"""

from __future__ import annotations

import re

# Phrases that on their own indicate a clearance requirement. Matched
# case-insensitively with word boundaries.
_CLEARANCE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(rf"(?<![a-z0-9]){p}(?![a-z0-9])", re.IGNORECASE)
    for p in (
        r"ts/sci",
        r"ts-sci",
        r"top\s+secret(?:\s+clearance)?",
        r"secret\s+clearance",
        r"security\s+clearance",
        r"active\s+clearance",
        r"current\s+clearance",
        r"clearance\s+(?:is\s+)?required",
        r"must\s+(?:hold|possess|have|obtain|maintain)\s+(?:an?\s+)?(?:active\s+|current\s+)?(?:\w+\s+)?clearance",
        r"clearance\s+eligibility",
        r"eligib(?:le|ility)\s+(?:for|to\s+obtain)\s+(?:an?\s+)?(?:\w+\s+)?clearance",
        r"ability\s+to\s+obtain\s+(?:and\s+maintain\s+)?(?:an?\s+)?(?:\w+\s+)?clearance",
        r"dod\s+clearance",
        r"federal\s+(?:security\s+)?clearance",
        r"government\s+(?:security\s+)?clearance",
        r"sci\s+access",
        r"q\s+clearance",
        r"polygraph\s+(?:clearance|required)",
        r"ci\s+poly(?:graph)?",
        r"full[\s-]scope\s+poly(?:graph)?",
        r"cleared\s+(?:candidates?|professionals?|personnel)\s+(?:only|required|preferred)",
        r"active\s+(?:ts|sci|dod)\b",
    )
)

# If one of these appears within a short window BEFORE the clearance phrase,
# the sentence is telling candidates a clearance is NOT needed.
_NEGATION_RE = re.compile(
    r"\b(?:no|not|without|don'?t\s+(?:need|require)|does\s+not\s+require|"
    r"doesn'?t\s+require|isn'?t\s+required|not\s+required|nor)\b[^.\n]{0,50}$",
    re.IGNORECASE,
)

# Trailing negation ("... clearance is not required", "... clearance not needed").
_TRAILING_NEGATION_RE = re.compile(
    r"^[^.\n]{0,50}\b(?:not?\s+(?:required|needed|necessary)|optional)\b",
    re.IGNORECASE,
)


def requires_security_clearance(text: str | None) -> tuple[bool, str]:
    """Return (required, matched_phrase). Empty phrase when not required."""
    if not text:
        return False, ""
    for pattern in _CLEARANCE_PATTERNS:
        for match in pattern.finditer(text):
            before = text[max(0, match.start() - 60):match.start()]
            after = text[match.end():match.end() + 60]
            if _NEGATION_RE.search(before):
                continue
            if _TRAILING_NEGATION_RE.match(after):
                continue
            return True, match.group(0).strip()
    return False, ""
