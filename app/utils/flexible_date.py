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

DatePrecision = Literal["year", "month", "day"]


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
