import asyncio

import pytest

from app.models.schemas import JobDescriptionSchema
from app.services import match_quality_check as qc
from app.services.job_add_batches import users_who_can_see_job


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def prefs(monkeypatch):
    state = {"mode": "rescore", "min": 70}

    async def fake(_user_id):
        return state["mode"], state["min"]

    monkeypatch.setattr(qc, "user_quality_check_prefs", fake)
    return state


def test_normalize_mode_and_min_score():
    assert qc.normalize_mode("AUTO") == "auto"
    assert qc.normalize_mode("bogus") == "rescore"
    assert qc.normalize_mode(None) == "rescore"
    assert qc.normalize_min_score(150) == 100
    assert qc.normalize_min_score(-5) == 0
    assert qc.normalize_min_score("x") == 70


def test_explicit_request_wins_over_setting(prefs):
    prefs["mode"] = "off"
    assert run(qc.resolve_rescore_request("u", requested=True, rescore=False)) is True
    prefs["mode"] = "auto"
    assert run(qc.resolve_rescore_request("u", requested=False, rescore=True)) is False


def test_rescore_follows_setting(prefs):
    for mode, expected in (("off", False), ("rescore", True), ("auto", True)):
        prefs["mode"] = mode
        assert run(qc.resolve_rescore_request("u", requested=None, rescore=True)) is expected


def test_first_score_never_triggers_check(prefs):
    prefs["mode"] = "auto"
    assert run(qc.resolve_rescore_request("u", requested=None, rescore=False)) is False


def test_auto_check_needs_auto_mode_and_threshold(prefs):
    free = {"match_engine": "vector", "overall_score": 80, "is_job_posting": True}
    prefs["mode"] = "rescore"
    assert run(qc.wants_auto_check("u", free)) is False
    prefs["mode"] = "auto"
    assert run(qc.wants_auto_check("u", free)) is True
    prefs["min"] = 81
    assert run(qc.wants_auto_check("u", free)) is False


def test_only_free_results_are_eligible():
    assert qc.eligible_free_result({"match_engine": "vector", "is_job_posting": True})
    assert not qc.eligible_free_result({"match_engine": "llm"})
    assert not qc.eligible_free_result({"match_engine": "llm_check"})


BODY = (
    "Senior Data Engineer at Acme Robotics. Location: Austin, TX. "
    "This is a hybrid role with 3 days per week in the office. "
    "Full-time position. Salary: $150,000 - $180,000 per year."
)


def test_supported_fields_keeps_backed_values():
    structured = JobDescriptionSchema(
        description=BODY,
        title="Senior Data Engineer",
        company="Acme Robotics",
        location="Austin, TX",
        salary_range="$150,000 - $180,000",
        employment_type="Full-time",
        work_mode="hybrid",
    )
    out = qc.supported_fields(structured, BODY)
    assert out == {
        "title": "Senior Data Engineer",
        "company": "Acme Robotics",
        "location": "Austin, TX",
        "salary_range": "$150,000 - $180,000",
        "employment_type": "Full-time",
        "work_mode": "hybrid",
    }


def test_supported_fields_drops_invented_values():
    structured = JobDescriptionSchema(
        description=BODY,
        title="Untitled",
        company="Globex",
        location="Berlin, Germany",
        salary_range="$90,000 - $110,000",
        employment_type="Contract",
        work_mode="remote",
    )
    assert qc.supported_fields(structured, BODY) == {}


def test_supported_fields_empty_inputs():
    assert qc.supported_fields(None, BODY) == {}
    assert qc.supported_fields(JobDescriptionSchema(description=BODY, title="X"), "  ") == {}


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _ScriptedSession:
    """Answers ``execute`` calls in order; records how many were made."""

    def __init__(self, *results):
        self._results = list(results)
        self.calls = 0

    async def execute(self, _stmt):
        self.calls += 1
        return _Rows(self._results.pop(0))


def test_unbatched_job_is_public():
    session = _ScriptedSession([])
    assert run(users_who_can_see_job(session, "j", ["a", "b"])) == {"a", "b"}


def test_private_batch_only_reaches_owner():
    session = _ScriptedSession([("b1", "owner", "private")])
    assert run(users_who_can_see_job(session, "j", ["owner", "other"])) == {"owner"}
    assert session.calls == 1


def test_all_scope_reaches_everyone():
    session = _ScriptedSession([("b1", "owner", "private"), ("b2", "x", "all")])
    assert run(users_who_can_see_job(session, "j", ["owner", "other"])) == {"owner", "other"}


def test_team_scope_uses_approved_members():
    session = _ScriptedSession([("b1", "owner", "team")], [("teammate",)])
    assert run(users_who_can_see_job(session, "j", ["owner", "teammate", "admin"])) == {"owner", "teammate"}


def test_users_scope_uses_share_list():
    session = _ScriptedSession([("b1", "owner", "users")], [("friend",)])
    assert run(users_who_can_see_job(session, "j", ["owner", "friend", "stranger"])) == {"owner", "friend"}


def test_no_candidates_skips_queries():
    session = _ScriptedSession()
    assert run(users_who_can_see_job(session, "j", [])) == set()
    assert session.calls == 0
