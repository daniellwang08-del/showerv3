"""Per-user tailored document filename stems.

Users pick a static name or a token pattern such as ``{firstname}_{lastname}_{kind}``.
Separators may be ``_``, ``-``, or ``.``. Empty tokens (no company, no last name)
drop their neighboring separators so stems stay clean.
"""

from __future__ import annotations

import re
from typing import Any

DEFAULT_FILENAME_PATTERN = "{firstname}_{lastname}_{kind}"
FILENAME_VALUE_MAX = 200
STEM_MAX = 80

TOKEN_ALIASES = {
    "firstname": "firstname",
    "first": "firstname",
    "lastname": "lastname",
    "last": "lastname",
    "fullname": "fullname",
    "company": "company",
    "title": "title",
    "jobtitle": "title",
    "role": "title",
    "kind": "kind",
}

# ``{firstname}`` or a bare ``firstname`` word.
_TOKEN_RE = re.compile(
    r"\{([A-Za-z]+)\}|(firstname|lastname|fullname|company|jobtitle|title|role|kind|first|last)",
    re.IGNORECASE,
)
_UNSAFE_CHARS = re.compile(r"[^\w.\s-]", re.UNICODE)
_MULTI_SEP = re.compile(r"[-_.]{2,}")


def normalize_filename_mode(mode: str | None) -> str:
    return "static" if str(mode or "").strip().lower() == "static" else "pattern"


def normalize_filename_value(mode: str, value: str | None) -> str:
    text = (value or "").strip()
    if any(ch in text for ch in "/\\:"):
        raise ValueError("File name cannot include path characters.")
    if mode == "static":
        if not text:
            raise ValueError("Enter a file name.")
        return text[:FILENAME_VALUE_MAX]
    return (text or DEFAULT_FILENAME_PATTERN)[:FILENAME_VALUE_MAX]


def sanitize_filename_part(value: str, *, fallback: str = "") -> str:
    cleaned = _UNSAFE_CHARS.sub("", value or "").strip()
    cleaned = re.sub(r"[\s]+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned).strip("._-")
    return cleaned or fallback


def _token_context(
    *,
    first_name: str,
    last_name: str,
    kind: str,
    company: str = "",
    title: str = "",
) -> dict[str, str]:
    first = sanitize_filename_part(first_name)
    last = sanitize_filename_part(last_name)
    full = sanitize_filename_part(" ".join(p for p in (first_name, last_name) if (p or "").strip()))
    kind_s = "cover_letter" if kind == "cover_letter" else "resume"
    return {
        "firstname": first,
        "lastname": last,
        "fullname": full or first or last,
        "company": sanitize_filename_part(company),
        "title": sanitize_filename_part(title),
        "kind": kind_s,
    }


def _tokenize_pattern(pattern: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    for match in _TOKEN_RE.finditer(pattern):
        if match.start() > pos:
            out.append(("lit", pattern[pos : match.start()]))
        raw = (match.group(1) or match.group(2) or "").lower()
        key = TOKEN_ALIASES.get(raw)
        if key:
            out.append(("token", key))
        else:
            out.append(("lit", match.group(0)))
        pos = match.end()
    if pos < len(pattern):
        out.append(("lit", pattern[pos:]))
    return out


def _join_segments(segments: list[tuple[str, str]], ctx: dict[str, str]) -> str:
    pieces: list[str] = []
    for kind, value in segments:
        if kind == "token":
            part = ctx.get(value, "")
            if part:
                pieces.append(part)
            continue
        lit = _UNSAFE_CHARS.sub("", value)
        lit = re.sub(r"[\s]+", "_", lit)
        lit = re.sub(r"[^\w.\-]", "", lit)
        if lit:
            pieces.append(lit)
    text = "".join(pieces)
    text = _MULTI_SEP.sub(lambda m: m.group(0)[0], text)
    return text.strip("-_.")


def resolve_document_stem(
    *,
    mode: str | None,
    value: str | None,
    first_name: str,
    last_name: str,
    kind: str = "resume",
    company: str = "",
    title: str = "",
) -> str:
    """Return a filesystem-safe stem (no extension) for a resume or cover letter."""
    mode_n = normalize_filename_mode(mode)
    ctx = _token_context(
        first_name=first_name,
        last_name=last_name,
        kind=kind,
        company=company,
        title=title,
    )
    fallback = ctx["fullname"] or ctx["kind"] or "Resume"

    if mode_n == "static":
        stem = sanitize_filename_part(value or "", fallback=fallback)
    else:
        pattern = (value or "").strip() or DEFAULT_FILENAME_PATTERN
        stem = _join_segments(_tokenize_pattern(pattern), ctx) or fallback

    if kind == "cover_letter":
        resume_ctx = {**ctx, "kind": "resume"}
        if mode_n == "static":
            resume_stem = sanitize_filename_part(value or "", fallback=ctx["fullname"] or "Resume")
        else:
            pattern = (value or "").strip() or DEFAULT_FILENAME_PATTERN
            resume_stem = _join_segments(_tokenize_pattern(pattern), resume_ctx) or (
                ctx["fullname"] or "Resume"
            )
        if not stem or stem == resume_stem:
            stem = f"{stem}_cover_letter" if stem else "cover_letter"

    stem = stem[:STEM_MAX].strip("-_.") or fallback
    return stem


def person_document_stem(first_name: str, last_name: str, kind: str = "resume") -> str:
    """Default stem: ``First_Last_resume`` / ``First_Last_cover_letter``."""
    return resolve_document_stem(
        mode="pattern",
        value=DEFAULT_FILENAME_PATTERN,
        first_name=first_name,
        last_name=last_name,
        kind=kind,
    )


def person_resume_stem(first_name: str, last_name: str) -> str:
    return person_document_stem(first_name, last_name, "resume")


def document_stem_for_user(
    user: Any,
    kind: str = "resume",
    *,
    company: str = "",
    title: str = "",
) -> str:
    return resolve_document_stem(
        mode=getattr(user, "resume_filename_mode", None),
        value=getattr(user, "resume_filename_value", None),
        first_name=(getattr(user, "name_first", None) or ""),
        last_name=(getattr(user, "name_last", None) or ""),
        kind=kind,
        company=company,
        title=title,
    )
