"""Flexible resume dates: YYYY, YYYY-MM, or YYYY-MM-DD."""

from __future__ import annotations

import re
from typing import Literal

MONTH_NAMES = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)

_MONTH_LOOKUP: dict[str, int] = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

DatePrecision = Literal["year", "month", "day"]

_PRESENT_RE = re.compile(r"^(present|current|now|ongoing)$", re.I)
_ISSUED_RE = re.compile(r"\bissued\b(.*)$", re.I | re.S)
_EXPIRED_SPLIT_RE = re.compile(r"\bexpired\b", re.I)
_MONTH_DAY_YEAR_RE = re.compile(
    r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b"
)
_DAY_MONTH_YEAR_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b"
)
_MONTH_YEAR_RE = re.compile(r"\b([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})\b")
_MDY_NUMERIC_RE = re.compile(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b")
_MY_NUMERIC_RE = re.compile(r"\b(\d{1,2})[/\-.](\d{4})\b")
_YM_NUMERIC_RE = re.compile(r"\b(\d{4})[/\-.](\d{1,2})\b")
_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\b")


def parse_flexible_date(raw: str | None) -> dict | None:
    v = (raw or "").strip()
    if not v or re.match(r"^present$", v, re.I):
        return None
    day = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", v)
    if day:
        y, m, d = int(day.group(1)), int(day.group(2)), int(day.group(3))
        if 1900 <= y <= 2100 and 1 <= m <= 12 and 1 <= d <= 31:
            return {"year": y, "month": m, "day": d, "precision": "day"}
        return None
    month = re.match(r"^(\d{4})-(\d{2})$", v)
    if month:
        y, m = int(month.group(1)), int(month.group(2))
        if 1900 <= y <= 2100 and 1 <= m <= 12:
            return {"year": y, "month": m, "precision": "month"}
        return None
    if re.match(r"^\d{4}$", v):
        y = int(v)
        if 1900 <= y <= 2100:
            return {"year": y, "precision": "year"}
    return None


def build_flexible_date(
    precision: DatePrecision,
    year: int,
    month: int | None = None,
    day: int | None = None,
) -> str:
    if precision == "year":
        return str(year)
    m = min(12, max(1, month or 1))
    if precision == "month":
        return f"{year}-{m:02d}"
    d = min(31, max(1, day or 1))
    return f"{year}-{m:02d}-{d:02d}"


def _canonical_from_parsed(parsed: dict) -> str:
    precision: DatePrecision = parsed["precision"]
    return build_flexible_date(
        precision,
        int(parsed["year"]),
        parsed.get("month"),
        parsed.get("day"),
    )


def _month_num(token: str) -> int | None:
    return _MONTH_LOOKUP.get(token.strip(".").lower())


def _valid_ymd(year: int, month: int | None = None, day: int | None = None) -> bool:
    if not (1900 <= year <= 2100):
        return False
    if month is not None and not (1 <= month <= 12):
        return False
    if day is not None and not (1 <= day <= 31):
        return False
    return True


def _find_date_in_text(text: str) -> str | None:
    """Best-effort extract a canonical flexible date from free-form text."""
    s = (text or "").strip()
    if not s:
        return None

    m = _MONTH_DAY_YEAR_RE.search(s)
    if m:
        mon = _month_num(m.group(1))
        day = int(m.group(2))
        year = int(m.group(3))
        if mon and _valid_ymd(year, mon, day):
            return build_flexible_date("day", year, mon, day)

    m = _DAY_MONTH_YEAR_RE.search(s)
    if m:
        day = int(m.group(1))
        mon = _month_num(m.group(2))
        year = int(m.group(3))
        if mon and _valid_ymd(year, mon, day):
            return build_flexible_date("day", year, mon, day)

    m = _MONTH_YEAR_RE.search(s)
    if m:
        mon = _month_num(m.group(1))
        year = int(m.group(2))
        if mon and _valid_ymd(year, mon):
            return build_flexible_date("month", year, mon)

    m = _MDY_NUMERIC_RE.search(s)
    if m:
        a, b, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        # Prefer MDY when first token looks like a month; else DMY.
        if 1 <= a <= 12 and 1 <= b <= 31 and _valid_ymd(year, a, b):
            return build_flexible_date("day", year, a, b)
        if 1 <= b <= 12 and 1 <= a <= 31 and _valid_ymd(year, b, a):
            return build_flexible_date("day", year, b, a)

    m = _MY_NUMERIC_RE.search(s)
    if m:
        month, year = int(m.group(1)), int(m.group(2))
        if _valid_ymd(year, month):
            return build_flexible_date("month", year, month)

    m = _YM_NUMERIC_RE.search(s)
    if m:
        year, month = int(m.group(1)), int(m.group(2))
        if _valid_ymd(year, month):
            return build_flexible_date("month", year, month)

    m = _YEAR_RE.search(s)
    if m:
        year = int(m.group(1))
        if _valid_ymd(year):
            return build_flexible_date("year", year)

    return None


def coerce_flexible_date(raw: str | None) -> str | None:
    """Normalize free-form date text to YYYY / YYYY-MM / YYYY-MM-DD.

    Used for résumé-import fields (especially certificate ``issued_at``) where the
    model may return résumé wording like ``Aug 2023`` or ``Issued Nov 2021``.
    Returns None when empty, Present-like, or unparseable, never leaves an
    invalid string that would fail profile validation.
    """
    v = (raw or "").strip()
    if not v:
        return None
    if _PRESENT_RE.match(v):
        return None

    already = parse_flexible_date(v)
    if already:
        return _canonical_from_parsed(already)

    # Prefer the date after "Issued", ignoring an "Expired …" tail.
    issued = _ISSUED_RE.search(v)
    if issued:
        chunk = _EXPIRED_SPLIT_RE.split(issued.group(1), maxsplit=1)[0]
        found = _find_date_in_text(chunk)
        if found:
            return found

    return _find_date_in_text(v)


def format_flexible_date(raw: str | None, empty: str = "") -> str:
    v = (raw or "").strip()
    if not v:
        return empty
    if re.match(r"^present$", v, re.I):
        return "Present"
    parsed = parse_flexible_date(v)
    if not parsed:
        return v
    precision = parsed["precision"]
    year = parsed["year"]
    if precision == "year":
        return str(year)
    mon = MONTH_NAMES[(parsed.get("month") or 1) - 1]
    if precision == "month":
        return f"{mon} {year}"
    return f"{mon} {parsed.get('day')}, {year}"


def format_flexible_period(start: str | None, end: str | None) -> str:
    s = format_flexible_date(start)
    e = format_flexible_date(end)
    if s and e:
        return f"{s} - {e}"
    if s:
        return f"{s} - Present"
    return e or ""
