"""Job-site sync activity: the phases behind the Integrations and Jobs progress bars."""

from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.services import job_site_connection_sync as sync


def _row(**over):
    base = dict(
        id="c1",
        user_id="u1",
        sync_phase=None,
        sync_started_at=None,
        last_sync_jobs=None,
        last_success_at=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture
def unsettled(monkeypatch):
    calls = []
    state = {"pending": 0}

    async def fake(session, user_id, job_ids, analyze):
        calls.append((user_id, list(job_ids), analyze))
        return state["pending"]

    monkeypatch.setattr(sync, "_count_unsettled_jobs", fake)
    return SimpleNamespace(calls=calls, state=state)


@pytest.mark.asyncio
async def test_fresh_fetch_phase_is_reported(unsettled):
    now = sync._now()
    out = await sync.connection_sync_activity(None, [_row(sync_phase="fetching", sync_started_at=now)])
    assert out == {"c1": {"phase": "fetching", "total": 0, "done": 0, "started_at": now}}
    assert unsettled.calls == []


@pytest.mark.asyncio
async def test_stale_fetch_phase_is_ignored(unsettled):
    started = sync._now() - sync.STALE_SYNC_PHASE - timedelta(seconds=1)
    out = await sync.connection_sync_activity(None, [_row(sync_phase="queued", sync_started_at=started)])
    assert out == {}


@pytest.mark.asyncio
async def test_scoring_progress_counts_settled_jobs(unsettled):
    unsettled.state["pending"] = 3
    now = sync._now()
    row = _row(last_success_at=now, last_sync_jobs={"job_ids": ["a", "b", "c", "d"], "analyze": False})
    out = await sync.connection_sync_activity(None, [row])
    assert out["c1"]["phase"] == "analyzing"
    assert (out["c1"]["total"], out["c1"]["done"]) == (4, 1)
    assert unsettled.calls == [("u1", ["a", "b", "c", "d"], False)]


@pytest.mark.asyncio
async def test_idle_when_every_job_settled_or_window_passed(unsettled):
    now = sync._now()
    jobs = {"job_ids": ["a"], "analyze": True}
    assert await sync.connection_sync_activity(None, [_row(last_success_at=now, last_sync_jobs=jobs)]) == {}

    unsettled.state["pending"] = 1
    old = now - sync.ANALYSIS_PROGRESS_WINDOW - timedelta(minutes=1)
    assert await sync.connection_sync_activity(None, [_row(last_success_at=old, last_sync_jobs=jobs)]) == {}
    assert await sync.connection_sync_activity(None, [_row(last_success_at=now, last_sync_jobs={"job_ids": []})]) == {}
