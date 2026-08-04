"""Unit tests for admin Data Analysis series helpers (no DB)."""

from datetime import date

from app.services.data_management_activity import _normalize_activity_metrics, _platform_key
from app.services.data_management_stats import fill_month, rows_to_day_map


def test_fill_month_sums_and_zero_fills():
    days = [date(2026, 8, 1), date(2026, 8, 2), date(2026, 8, 3)]
    maps = {
        "fetched_count": {date(2026, 8, 1): 4, date(2026, 8, 3): 1},
        "applied_count": {date(2026, 8, 2): 2},
    }
    out_days, totals = fill_month(days, maps)
    assert len(out_days) == 3
    assert out_days[0] == {"date": "2026-08-01", "fetched_count": 4, "applied_count": 0}
    assert out_days[1] == {"date": "2026-08-02", "fetched_count": 0, "applied_count": 2}
    assert out_days[2] == {"date": "2026-08-03", "fetched_count": 1, "applied_count": 0}
    assert totals == {"fetched_count": 5, "applied_count": 2}


def test_rows_to_day_map_skips_null_days():
    class Row:
        def __init__(self, day, cnt):
            self.day = day
            self.cnt = cnt

    mapped = rows_to_day_map(
        [Row(None, 9), Row(date(2026, 8, 1), 3), Row("2026-08-02", 7)]
    )
    assert mapped[date(2026, 8, 1)] == 3
    assert mapped[date(2026, 8, 2)] == 7
    assert None not in mapped


def test_normalize_activity_metrics_aliases_and_dedupes():
    assert _normalize_activity_metrics(["jobs_added", "board_added", "applied", "sheet_posted"]) == [
        "board_added",
        "applied",
    ]
    assert _normalize_activity_metrics(["pumble_posted", "sheet_posted"]) == []


def test_platform_key_is_recharts_safe():
    key = _platform_key("Greenhouse / Boards")
    assert key.startswith("src_")
    assert ":" not in key
    assert " " not in key
