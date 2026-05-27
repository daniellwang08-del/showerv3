"""Parse lightweight markup in tailored resume text for DOCX rendering."""

from __future__ import annotations

import re

_BOLD_PATTERN = re.compile(r"\*\*(.+?)\*\*")


def parse_bold_markers(text: str) -> list[tuple[str, bool]]:
    """Split text into (segment, is_bold) using ``**highlight**`` markers."""
    if not text:
        return []
    if "**" not in text:
        return [(text, False)]

    parts: list[tuple[str, bool]] = []
    last = 0
    for match in _BOLD_PATTERN.finditer(text):
        if match.start() > last:
            parts.append((text[last : match.start()], False))
        inner = match.group(1)
        if inner:
            parts.append((inner, True))
        last = match.end()
    if last < len(text):
        parts.append((text[last:], False))
    return parts if parts else [(text, False)]


def strip_bold_markers(text: str) -> str:
    """Remove ``**`` markers for plain-text display."""
    if not text or "**" not in text:
        return text
    return _BOLD_PATTERN.sub(r"\1", text)
