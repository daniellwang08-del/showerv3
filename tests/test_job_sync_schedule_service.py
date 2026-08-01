from datetime import datetime, timezone

import pytest

from app.services.job_sync_schedule_service import (
    build_sync_args,
    compute_next_run_at,
    default_schedule,
    is_schedule_due,
    normalize_schedule,
)


def test_normalize_default():
    s = normalize_schedule(None)
    assert s["enabled"] is False
    assert s["cadence"] == "daily"
    assert s["daily_time"] == "04:30"
    assert s["timezone"] == "America/Los_Angeles"


def test_normalize_interval_and_time():
    s = normalize_schedule(
        {
            "enabled": True,
            "cadence": "interval",
            "interval_hours": 2,
            "daily_time": "4:05",
            "timezone": "America/New_York",
            "sync_mode": "incremental",
            "spider_names": ["adzuna", "jobright"],
        }
    )
    assert s["interval_hours"] == 2
    assert s["daily_time"] == "04:05"
    assert s["spider_names"] == ["adzuna", "jobright"]


def test_normalize_rejects_bad_timezone():
    with pytest.raises(ValueError, match="timezone"):
        normalize_schedule({"timezone": "PST"})


def test_daily_next_run_tomorrow_when_past():
    schedule = normalize_schedule(
        {
            "enabled": True,
            "cadence": "daily",
            "daily_time": "04:30",
            "timezone": "America/Los_Angeles",
            "last_run_at": None,
        }
    )
    # 2026-08-01 20:00 UTC = 13:00 PDT — past 04:30 local
    now = datetime(2026, 8, 1, 20, 0, tzinfo=timezone.utc)
    nxt = compute_next_run_at(schedule, now=now)
    assert nxt is not None
    assert nxt > now
    assert not is_schedule_due(schedule, now=now)


def test_daily_due_after_target_without_today_run():
    schedule = normalize_schedule(
        {
            "enabled": True,
            "cadence": "daily",
            "daily_time": "04:30",
            "timezone": "America/Los_Angeles",
            # Last run yesterday morning Pacific
            "last_run_at": "2026-07-31T11:30:00Z",
        }
    )
    # 2026-08-01 12:00 UTC = 05:00 PDT — after 04:30
    now = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    assert is_schedule_due(schedule, now=now)


def test_interval_due_after_hours():
    schedule = normalize_schedule(
        {
            "enabled": True,
            "cadence": "interval",
            "interval_hours": 4,
            "last_run_at": "2026-08-01T10:00:00Z",
        }
    )
    assert not is_schedule_due(
        schedule, now=datetime(2026, 8, 1, 13, 0, tzinfo=timezone.utc)
    )
    assert is_schedule_due(
        schedule, now=datetime(2026, 8, 1, 14, 0, tzinfo=timezone.utc)
    )


def test_interval_first_run_immediate():
    schedule = normalize_schedule(
        {
            "enabled": True,
            "cadence": "interval",
            "interval_hours": 2,
            "last_run_at": None,
        }
    )
    now = datetime(2026, 8, 1, 15, 0, tzinfo=timezone.utc)
    assert is_schedule_due(schedule, now=now)
    assert compute_next_run_at(schedule, now=now) == now


def test_build_sync_args_incremental():
    schedule = default_schedule()
    schedule.update(
        {
            "sync_mode": "incremental",
            "spider_names": ["adzuna"],
            "run_as_user_id": "user-1",
        }
    )
    args = build_sync_args(schedule)
    assert args["sync_mode"] == "incremental"
    assert args["posted_since"] is None
    assert args["spider_names"] == ["adzuna"]
    assert args["user_id"] == "user-1"


def test_build_sync_args_date_backfill_lookback():
    schedule = default_schedule()
    schedule.update({"sync_mode": "date_backfill", "lookback_days": 3})
    args = build_sync_args(schedule)
    assert args["sync_mode"] == "date_backfill"
    assert args["posted_since"] is not None
    assert args["posted_until"] is not None
