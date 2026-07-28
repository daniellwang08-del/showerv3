"""Calendar-day / month bounds for stats queries (stored timestamps are naive UTC)."""

from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def _resolve_tz(tz_name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name or "UTC")
    except Exception:
        return ZoneInfo("UTC")


def day_bounds_for_timezone(tz_name: str | None) -> tuple[datetime, datetime]:
    """Return naive UTC [start, end) for the current calendar day in *tz_name*."""
    tz = _resolve_tz(tz_name)
    now = datetime.now(tz)
    start_local = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc


def month_bounds_for_timezone(
    year: int,
    month: int,
    tz_name: str | None,
) -> tuple[datetime, datetime]:
    """Return naive UTC [start, end) for the calendar month in *tz_name*."""
    if month < 1 or month > 12:
        raise ValueError("month must be 1-12")
    if year < 1970 or year > 2100:
        raise ValueError("year out of range")

    tz = _resolve_tz(tz_name)
    start_local = datetime(year, month, 1, 0, 0, 0, 0, tzinfo=tz)
    if month == 12:
        end_local = datetime(year + 1, 1, 1, 0, 0, 0, 0, tzinfo=tz)
    else:
        end_local = datetime(year, month + 1, 1, 0, 0, 0, 0, tzinfo=tz)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc


def date_range_bounds_for_timezone(
    date_from: date,
    date_to: date,
    tz_name: str | None,
) -> tuple[datetime, datetime]:
    """Return naive UTC [start, end) for an inclusive local calendar date range."""
    if date_to < date_from:
        raise ValueError("date_to must be on or after date_from")
    tz = _resolve_tz(tz_name)
    start_local = datetime(date_from.year, date_from.month, date_from.day, 0, 0, 0, 0, tzinfo=tz)
    end_day = date_to + timedelta(days=1)
    end_local = datetime(end_day.year, end_day.month, end_day.day, 0, 0, 0, 0, tzinfo=tz)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc


def days_in_month(year: int, month: int) -> list[date]:
    """Return every calendar date in the given month."""
    _, last = monthrange(year, month)
    return [date(year, month, day) for day in range(1, last + 1)]


def list_recent_months(n: int = 12, tz_name: str | None = None) -> list[dict]:
    """Return the last *n* calendar months ending at the current month in *tz_name*."""
    if n < 1 or n > 36:
        raise ValueError("n must be 1-36")
    tz = _resolve_tz(tz_name)
    now = datetime.now(tz)
    year, month = now.year, now.month
    months: list[dict] = []
    for _ in range(n):
        label = datetime(year, month, 1).strftime("%B %Y")
        months.append({"year": year, "month": month, "label": label})
        month -= 1
        if month < 1:
            month = 12
            year -= 1
    return months
