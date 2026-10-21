import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.services import auto_prepare_service as aps


def run(coro):
    return asyncio.run(coro)


class _Result:
    def __init__(self, rows=None, scalar=None):
        self._rows = rows or []
        self._scalar = scalar

    def all(self):
        return self._rows

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return self


class _Session:
    def __init__(self, *results):
        self._results = list(results)

    async def execute(self, _stmt):
        return self._results.pop(0)


def _patch_session(monkeypatch, session):
    @asynccontextmanager
    async def fake():
        yield session

    monkeypatch.setattr(aps, "get_session", fake)


@pytest.mark.parametrize(
    "mode, expected",
    [("extract", None), ("match", True), ("full", False), (None, False), ("bogus", False)],
)
def test_member_add_depth_follows_the_add_preference(mode, expected):
    assert aps.member_add_skip_phase_b(mode) is expected


def test_member_add_depths_only_covers_jobs_a_member_added():
    session = _Session(
        _Result(
            rows=[
                ("j1", {"submitted_by_user_id": "owner"}),
                ("j2", {"source": "linkedin"}),
                ("j3", {"submitted_by_user_id": "admin", "submitted_by_admin": True}),
            ]
        )
    )
    depths = run(aps._member_add_depths(session, ["j1", "j2", "j3"], "full"))
    assert depths == {"j1": False}


def test_member_add_depths_empty_list_skips_the_query():
    assert run(aps._member_add_depths(_Session(), [], "full")) == {}


def test_member_add_fanout_runs_each_person_by_their_own_preference(monkeypatch):
    users = [
        SimpleNamespace(id="full_user", manual_submit_pipeline="full"),
        SimpleNamespace(id="match_user", manual_submit_pipeline="match"),
        SimpleNamespace(id="extract_user", manual_submit_pipeline="extract"),
        SimpleNamespace(id="hidden_user", manual_submit_pipeline="full"),
        SimpleNamespace(id="scored_user", manual_submit_pipeline="full"),
        SimpleNamespace(id="outsider", manual_submit_pipeline="full"),
    ]
    session = _Session(
        _Result(scalar=SimpleNamespace()),  # extraction
        _Result(rows=users),
        _Result(rows=["scored_user"]),  # match results
        _Result(rows=["hidden_user"]),  # non-active statuses
    )
    _patch_session(monkeypatch, session)
    monkeypatch.setattr(aps, "extraction_has_shared_jd", lambda _e: True)

    async def visible(_s, _job, candidates):
        return {c for c in candidates if c != "outsider"}

    async def scorable(_s, ids):
        return set(ids)

    calls = []

    async def enqueue(job_id, user_id, *, extraction_id, skip_phase_b, source, defer_by=None):
        calls.append((user_id, skip_phase_b, source))
        return True

    async def paused():
        raise AssertionError("a member's add ignores the auto-prepare pause")

    monkeypatch.setattr(aps, "users_who_can_see_job", visible)
    monkeypatch.setattr(aps, "_scorable_user_ids", scorable)
    monkeypatch.setattr(aps, "_enqueue_analyze", enqueue)
    monkeypatch.setattr(aps, "_auto_prepare_globally_enabled", paused)

    out = run(aps._fanout_member_add("job", "owner", "ext", user_ids=None, source="fanout"))

    assert calls == [("full_user", False, "member_add:fanout"), ("match_user", True, "member_add:fanout")]
    assert out["enqueued"] == 2
    assert out["skipped"] == 3
    assert out["users"] == 5


def test_member_add_fanout_waits_for_the_shared_jd(monkeypatch):
    _patch_session(monkeypatch, _Session(_Result(scalar=None)))
    monkeypatch.setattr(aps, "extraction_has_shared_jd", lambda _e: False)
    out = run(aps._fanout_member_add("job", "owner", "ext", user_ids=None, source="fanout"))
    assert out["error"] == "jd_not_ready"
    assert out["enqueued"] == 0


def test_fanout_routes_a_member_add_to_the_member_path(monkeypatch):
    _patch_session(monkeypatch, _Session(_Result(scalar={"submitted_by_user_id": "owner"})))
    seen = {}

    async def member(job_id, owner_id, extraction_id, *, user_ids, source):
        seen.update(job_id=job_id, owner_id=owner_id, user_ids=user_ids)
        return {"member_add": True}

    monkeypatch.setattr(aps, "_fanout_member_add", member)
    out = run(aps.fanout_auto_prepare_for_job("job", "ext", user_ids=["a"], source="share"))
    assert out == {"member_add": True}
    assert seen == {"job_id": "job", "owner_id": "owner", "user_ids": ["a"]}
