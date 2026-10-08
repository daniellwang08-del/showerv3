import asyncio
from types import SimpleNamespace

from app.services.job_add_batches import (
    initial_scope_from_default,
    job_visibility_map,
    normalize_share_default,
    normalize_share_scope,
)


def test_normalize_share_default():
    assert normalize_share_default("ask") == "private"
    assert normalize_share_default("TEAM") == "team"
    assert normalize_share_default("nope") == "private"
    assert normalize_share_default(None) == "private"


def test_initial_scope_follows_the_saved_default():
    assert initial_scope_from_default("ask") == "private"
    assert initial_scope_from_default("all") == "all"
    assert initial_scope_from_default("team") == "team"


def test_normalize_share_scope():
    assert normalize_share_scope("users") == "users"
    assert normalize_share_scope("bogus") == "private"


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeSession:
    """Answers the batch query, then the share-user query, in order."""

    def __init__(self, *answers):
        self._answers = list(answers)

    async def execute(self, _stmt):
        return _Result(self._answers.pop(0))


def _job(job_id, owner=None):
    meta = {"submitted_by_user_id": owner} if owner else {}
    return SimpleNamespace(id=job_id, raw_metadata=meta)


def test_job_visibility_map_mirrors_the_share_rules():
    jobs = [
        _job("scraped"),
        _job("mine-unbatched", owner="u1"),
        _job("mine-private", owner="u1"),
        _job("widest-wins", owner="u1"),
        _job("people", owner="u1"),
    ]
    batch_rows = [
        ("mine-private", "b1", "private"),
        ("widest-wins", "b2", "private"),
        ("widest-wins", "b3", "team"),
        ("people", "b4", "users"),
        ("people", "b5", "users"),
    ]
    share_rows = [("b4", "u2"), ("b4", "u3"), ("b5", "u3"), ("b5", "u4")]
    got = asyncio.run(job_visibility_map(_FakeSession(batch_rows, share_rows), jobs))
    assert got == {
        "scraped": ("all", 0),
        "mine-unbatched": ("private", 0),
        "mine-private": ("private", 0),
        "widest-wins": ("team", 0),
        "people": ("users", 3),
    }
