from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.utils.date_bounds import day_bounds_for_timezone


def test_day_bounds_utc_midnight():
    start, end = day_bounds_for_timezone("UTC")
    assert start.tzinfo is None
    assert end.tzinfo is None
    assert end > start
    assert (end - start).total_seconds() == 86400


def test_day_bounds_unknown_timezone_falls_back_to_utc():
    start, end = day_bounds_for_timezone("Not/A_Real_Zone")
    assert (end - start).total_seconds() == 86400


def test_day_bounds_local_timezone_produces_valid_window():
    tz = "America/New_York"
    start, end = day_bounds_for_timezone(tz)
    now_local = datetime.now(ZoneInfo(tz))
    start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    expected_start = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    assert start == expected_start
    assert end == expected_start + timedelta(days=1)
