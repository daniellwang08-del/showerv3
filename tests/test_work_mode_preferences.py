"""Work-mode board preferences: normalize + visibility matching."""

from __future__ import annotations

from types import SimpleNamespace

from app.services.work_mode_preferences import (
    job_matches_work_mode_preferences,
    normalize_work_mode_preferences,
)


def test_normalize_work_mode_preferences_order_and_dedupe():
    assert normalize_work_mode_preferences(["onsite", "REMOTE", "hybrid", "remote", "wfh"]) == [
        "remote",
        "hybrid",
        "onsite",
    ]
    assert normalize_work_mode_preferences([]) == []
    assert normalize_work_mode_preferences(None) == []
    assert normalize_work_mode_preferences(["on-site"]) == ["onsite"]


def _job(*, work_mode=None, location=None, is_remote=False):
    return SimpleNamespace(
        work_mode=work_mode,
        location=location,
        title=None,
        raw_metadata={"is_remote": is_remote} if is_remote else {},
    )


def test_empty_allow_list_keeps_all_modes():
    assert job_matches_work_mode_preferences(_job(work_mode="onsite"), []) is True
    assert job_matches_work_mode_preferences(_job(work_mode="hybrid"), ["remote", "hybrid", "onsite"]) is True


def test_remote_only_hides_hybrid_and_onsite():
    allowed = ["remote"]
    assert job_matches_work_mode_preferences(_job(work_mode="remote"), allowed) is True
    assert job_matches_work_mode_preferences(_job(work_mode="hybrid"), allowed) is False
    assert job_matches_work_mode_preferences(_job(work_mode="onsite"), allowed) is False
    # Unknown stays visible (country-pref style).
    assert job_matches_work_mode_preferences(_job(work_mode=None, location="Austin, TX"), allowed) is True


def test_location_signals_resolve_when_work_mode_missing():
    allowed = ["remote"]
    assert job_matches_work_mode_preferences(
        _job(work_mode=None, location="Remote, United States"), allowed
    ) is True
    assert job_matches_work_mode_preferences(
        _job(work_mode=None, location="Austin, TX (Hybrid)"), allowed
    ) is False


def test_parse_work_modes_query_accepts_csv_and_remote_only():
    from app.api.routes import _parse_work_modes_query

    assert _parse_work_modes_query("remote,hybrid") == ["remote", "hybrid"]
    assert _parse_work_modes_query(None, remote_only=True) == ["remote"]
    assert _parse_work_modes_query("remote", remote_only=True) == ["remote"]
    assert _parse_work_modes_query(None, remote_only=False) == []
