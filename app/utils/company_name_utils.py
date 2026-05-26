"""Normalize company names for matching profile roles to source documents."""

from __future__ import annotations

import re

_SUFFIXES = (
    r"\bincorporated\b",
    r"\binc\b\.?",
    r"\bllc\b\.?",
    r"\bltd\b\.?",
    r"\blimited\b",
    r"\bcorp\b\.?",
    r"\bcorporation\b",
    r"\bcompany\b",
    r"\bco\b\.?",
    r"\bplc\b\.?",
    r"\bgmbh\b",
    r"\bs\.?a\.?\b",
)


def normalize_company_name(name: str | None) -> str:
    if not name:
        return ""
    s = name.lower().strip()
    s = re.sub(r"[^\w\s&.-]", " ", s)
    for pat in _SUFFIXES:
        s = re.sub(pat, " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def company_names_match(a: str | None, b: str | None) -> bool:
    na = normalize_company_name(a)
    nb = normalize_company_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if na in nb or nb in na:
        return True
    na_tokens = set(na.split())
    nb_tokens = set(nb.split())
    if len(na_tokens) >= 2 and len(nb_tokens) >= 2:
        overlap = na_tokens & nb_tokens
        if len(overlap) >= min(2, min(len(na_tokens), len(nb_tokens))):
            return True
    return False
