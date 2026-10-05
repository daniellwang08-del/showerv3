"""Normalize employer names so 'Google LLC' matches 'Google'."""

from __future__ import annotations

import re

_LEGAL_SUFFIX_RE = re.compile(
    r"[\s,./]*\b(?:incorporated|corporation|company|limited|gmbh|llc|ltd|inc|corp|plc|l\.l\.c\.?|co)\b\.?",
    re.I,
)


def normalize_company_name(value: object) -> str:
    s = str(value or "").strip().lower()
    if not s:
        return ""
    s = s.replace("&", " and ")
    s = re.sub(r"[\"'`’]", "", s)
    s = re.sub(r"[.,()/\\-]+", " ", s)
    prev = None
    while prev != s:
        prev = s
        s = _LEGAL_SUFFIX_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def companies_match(left: object, right: object) -> bool:
    """True when two employer strings refer to the same company."""
    a, b = normalize_company_name(left), normalize_company_name(right)
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) < 4:
        return False
    return (
        longer.startswith(shorter + " ")
        or longer.endswith(" " + shorter)
        or f" {shorter} " in f" {longer} "
    )
