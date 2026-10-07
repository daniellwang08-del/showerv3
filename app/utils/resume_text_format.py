"""Parse lightweight inline markup in resume text for DOCX / preview rendering.

The same three markers are understood on the backend (here + the fill engine) and the
frontend (``frontend/src/utils/richText.tsx``) so the live preview and the rendered
document agree byte-for-byte:

* ``**bold**``       - also what the tailoring LLM emits for ATS-critical keywords
* ``*italic*``
* ``__underline__``

A delimiter is only treated as formatting when a matching closing delimiter exists later
in the string; a lone/dangling marker renders literally (so "3 * 4" or a snake_case token
is left untouched). Markers may nest (e.g. ``**__x__**``)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_BOLD_PATTERN = re.compile(r"\*\*(.+?)\*\*")


@dataclass(frozen=True)
class InlineSegment:
    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False


def _single_star_ahead(text: str, start: int) -> bool:
    """Is there another standalone ``*`` (not part of ``**``) at/after *start*?"""
    j = start
    n = len(text)
    while j < n:
        if text[j] == "*":
            prev_star = j > 0 and text[j - 1] == "*"
            next_star = j + 1 < n and text[j + 1] == "*"
            if not prev_star and not next_star:
                return True
            # skip over a "**" pair
            j += 2 if next_star else 1
            continue
        j += 1
    return False


def parse_inline_markup(text: str) -> list[InlineSegment]:
    """Split *text* into styled segments using ``**`` / ``*`` / ``__`` markers."""
    if not text:
        return []
    n = len(text)
    i = 0
    bold = italic = underline = False
    out: list[InlineSegment] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            out.append(InlineSegment("".join(buf), bold, italic, underline))
            buf.clear()

    while i < n:
        two = text[i : i + 2]
        if two == "**":
            if bold or text.find("**", i + 2) != -1:
                flush()
                bold = not bold
                i += 2
                continue
        elif two == "__":
            if underline or text.find("__", i + 2) != -1:
                flush()
                underline = not underline
                i += 2
                continue
        ch = text[i]
        if ch == "*" and two != "**":
            if italic or _single_star_ahead(text, i + 1):
                flush()
                italic = not italic
                i += 1
                continue
        buf.append(ch)
        i += 1
    flush()
    return _unbold_word_fragments([s for s in out if s.text])


def _unbold_word_fragments(segs: list[InlineSegment]) -> list[InlineSegment]:
    """Bold that splits a word ("**Design**ed") is never intended: render the word plain."""
    fixed: list[InlineSegment] = []
    for idx, s in enumerate(segs):
        if s.bold:
            prev = segs[idx - 1] if idx > 0 else None
            nxt = segs[idx + 1] if idx + 1 < len(segs) else None
            joins_prev = prev is not None and not prev.bold and prev.text[-1:].isalpha() and s.text[:1].isalpha()
            joins_next = nxt is not None and not nxt.bold and s.text[-1:].isalpha() and nxt.text[:1].isalpha()
            if joins_prev or joins_next:
                s = InlineSegment(s.text, False, s.italic, s.underline)
        fixed.append(s)
    merged: list[InlineSegment] = []
    for s in fixed:
        last = merged[-1] if merged else None
        if last and (last.bold, last.italic, last.underline) == (s.bold, s.italic, s.underline):
            merged[-1] = InlineSegment(last.text + s.text, s.bold, s.italic, s.underline)
        else:
            merged.append(s)
    return merged


def parse_bold_markers(text: str) -> list[tuple[str, bool]]:
    """Backward-compatible bold-only split into ``(segment, is_bold)``."""
    return [(s.text, s.bold) for s in parse_inline_markup(text)]


def strip_bold_markers(text: str) -> str:
    """Remove ``**`` markers for plain-text display."""
    if not text or "**" not in text:
        return text
    return _BOLD_PATTERN.sub(r"\1", text)


def strip_inline_markup(text: str) -> str:
    """Flatten all inline markup to plain text (drops bold/italic/underline markers)."""
    if not text:
        return text
    return "".join(s.text for s in parse_inline_markup(text))
