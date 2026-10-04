"""Detect fetched pages that are not an open job posting.

Scraped URLs sometimes resolve to a careers index, a closed-job placeholder
or a "page not found" shell. Scoring those against a profile produces a
confident-looking number for a page with no job on it. The phrases below are
the page's own wording and are only searched near the top of the text, where
the page states what it is; a posting that mentions "current openings" in its
footer is not affected.
"""

from __future__ import annotations

import re

_HEAD_CHARS = 900

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "closed",
        re.compile(
            r"this (?:job|position|posting|role|requisition) (?:has been|is) (?:closed|filled|no longer (?:available|open|active))"
            r"|(?:job|position|posting) (?:is )?no longer (?:available|open|accepting applications)"
            r"|no longer accepting applications"
            r"|this job (?:posting )?has expired",
            re.I,
        ),
    ),
    (
        "not_found",
        re.compile(
            r"(?:this )?page (?:was |could not be |cannot be )?not found"
            r"|the page you (?:are|were|'re) looking for (?:may have|has|does not|doesn't|could not|can't)",
            re.I,
        ),
    ),
    ("careers_index", re.compile(r"current openings at\b|^\s*open positions\s*$|^\s*all open roles\s*$", re.I | re.M)),
)


def non_posting_reason(text: str | None) -> str | None:
    """'closed' | 'not_found' | 'careers_index' when the page is not a posting, else None."""
    head = (text or "")[:_HEAD_CHARS]
    if not head.strip():
        return None
    for reason, pattern in _PATTERNS:
        if pattern.search(head):
            return reason
    return None
