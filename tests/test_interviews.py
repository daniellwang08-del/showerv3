from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

from app.core.config import get_settings
from app.services import interview_extraction as ex
from app.services import interview_service as svc
from app.services import nylas_service as nylas


class TestPrefilter:
    @pytest.mark.parametrize(
        "subject,snippet,sender",
        [
            ("Interview invitation: Software Engineer", "", "jane@acme.com"),
            ("Next steps with Acme", "Please share your availability for a call", "recruiting@acme.com"),
            ("Invitation: Technical round @ Tue Oct 20", "", "calendar-notification@google.com"),
            ("Your application to Acme", "Unfortunately we will not be moving forward", "no-reply@greenhouse.io"),
            ("Acme coding challenge", "Complete your HackerRank assessment", "hr@acme.com"),
        ],
    )
    def test_keeps_hiring_mail(self, subject, snippet, sender):
        assert ex.is_candidate(subject, snippet, sender)

    @pytest.mark.parametrize(
        "subject,snippet,sender",
        [
            ("30 new jobs for you", "Interview-ready roles", "jobalerts-noreply@linkedin.com"),
            ("Job alert: Software Engineer", "Schedule a call", "alerts@indeed.com"),
            ("Weekly digest", "next steps in AI", "digest@medium.com"),
            ("Lunch on Friday?", "Are you free?", "friend@example.com"),
        ],
    )
    def test_drops_noise(self, subject, snippet, sender):
        assert not ex.is_candidate(subject, snippet, sender)


def test_company_key_groups_variants():
    assert ex.company_key("Acme, Inc.") == ex.company_key("ACME") == "acme"
    assert ex.company_key("Foo Bar LLC") == "foo bar"
    assert ex.company_key("  ") == ""


class TestParsing:
    def test_scheduled_at_with_offset_becomes_naive_utc(self):
        assert ex.parse_scheduled_at("2026-10-20T14:00:00-04:00", "UTC") == datetime(2026, 10, 20, 18, 0)

    def test_naive_time_uses_candidate_timezone(self):
        assert ex.parse_scheduled_at("2026-10-20T14:00:00", "America/New_York") == datetime(2026, 10, 20, 18, 0)

    def test_bad_times(self):
        assert ex.parse_scheduled_at("next Tuesday", "UTC") is None
        assert ex.parse_scheduled_at("1999-01-01T00:00:00Z", "UTC") is None
        assert ex.parse_scheduled_at(None, "UTC") is None

    def test_normalize_result_cleans_values(self):
        out = ex.normalize_result(
            {
                "relevant": True,
                "company": "  Acme  ",
                "role": "Backend Engineer",
                "kind": "technical",
                "status": "scheduled",
                "scheduled_at": "2026-10-20T14:00:00Z",
                "duration_minutes": 45,
                "meeting_url": "zoom.us/j/1",
                "remaining_steps": ["Onsite", "", 3, "Final"],
                "summary": "Technical round booked",
            },
            "UTC",
        )
        assert out["company"] == "Acme"
        assert out["scheduled_at"] == datetime(2026, 10, 20, 14, 0)
        assert out["meeting_url"] is None
        assert out["remaining_steps"] == ["Onsite", "Final"]

    def test_normalize_result_rejects_irrelevant_and_fixes_enums(self):
        assert ex.normalize_result({"relevant": False, "company": "Acme"}, "UTC") is None
        assert ex.normalize_result({"relevant": True, "company": None}, "UTC") is None
        out = ex.normalize_result({"relevant": True, "company": "Acme", "kind": "lunch", "status": "scheduled"}, "UTC")
        assert out["kind"] == "other"
        assert out["status"] == "info"

    def test_parse_results_handles_fences(self):
        text = "```json\n" + json.dumps({"results": [{"id": "m1", "relevant": True}]}) + "\n```"
        assert ex.parse_results(text) == {"m1": {"id": "m1", "relevant": True}}


class TestStages:
    def test_moves_forward_only(self):
        assert svc.stage_after_event("screening", "active", "technical") == ("interviewing", "active")
        assert svc.stage_after_event("final", "active", "recruiter_screen") == ("final", "active")
        assert svc.stage_after_event("final", "active", "scheduling") == ("final", "active")

    def test_rejection_closes_and_new_round_reopens(self):
        assert svc.stage_after_event("interviewing", "active", "rejection") == ("rejected", "closed")
        assert svc.stage_after_event("rejected", "closed", "technical") == ("interviewing", "active")
        assert svc.stage_after_event("rejected", "closed", "other") == ("rejected", "closed")

    def test_initial_stage(self):
        assert svc.initial_stage("onsite") == "final"
        assert svc.initial_stage("scheduling") == "screening"


def _proc(role, status="active"):
    return SimpleNamespace(role_title=role, status=status)


class TestPickProcess:
    def test_matches_same_role(self):
        a, b = _proc("Data Engineer"), _proc("Backend Engineer")
        assert svc.pick_process([a, b], "backend engineer") is b

    def test_unknown_role_goes_to_latest_active(self):
        a, b = _proc("Data Engineer", "closed"), _proc("Backend Engineer")
        assert svc.pick_process([a, b], None) is b

    def test_new_role_starts_new_process(self):
        assert svc.pick_process([_proc("Data Engineer")], "Designer") is None
        assert svc.pick_process([_proc(None)], "Designer").role_title is None


def test_html_to_text_keeps_links_and_lines():
    text = nylas.html_to_text(
        '<html><head><style>p{}</style></head><body><p>Hi Jane,</p>'
        '<p>Join <a href="https://zoom.us/j/1">here</a></p></body></html>'
    )
    assert "Hi Jane," in text
    assert "https://zoom.us/j/1" in text
    assert "p{}" not in text


def test_sender_label_and_message_time():
    assert nylas.sender_label([{"name": "Jane", "email": "jane@acme.com"}]) == "Jane <jane@acme.com>"
    assert nylas.message_datetime({"date": 0}) == datetime(1970, 1, 1)


def test_authorize_url_and_state_round_trip(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "nylas_api_key", "key")
    monkeypatch.setattr(s, "nylas_client_id", "client")
    monkeypatch.setattr(s, "nylas_api_uri", "https://api.us.nylas.com/")
    monkeypatch.setattr(s, "auth_secret_key", "s" * 32)
    url = nylas.build_authorize_url(user_id="u1", redirect_uri="https://app/cb")
    parsed = urlparse(url)
    q = parse_qs(parsed.query)
    assert parsed.netloc == "api.us.nylas.com" and parsed.path == "/v3/connect/auth"
    assert q["client_id"] == ["client"] and q["redirect_uri"] == ["https://app/cb"]
    assert len(q["state"][0]) <= 256
    assert nylas.verify_oauth_state(q["state"][0]) == "u1"


def test_not_configured_raises(monkeypatch):
    monkeypatch.setattr(get_settings(), "nylas_api_key", "")
    assert not nylas.configured()
    with pytest.raises(nylas.MailNotConfiguredError):
        nylas.build_authorize_url(user_id="u1", redirect_uri="https://app/cb")


class _Result:
    def scalars(self):
        return iter(())

    def scalar_one_or_none(self):
        return None

    def all(self):
        return []


class _RecordingSession:
    """Records add/flush order; every query returns no rows."""

    def __init__(self):
        self.calls: list[str] = []

    async def execute(self, _stmt):
        return _Result()

    def add(self, obj):
        self.calls.append(f"add:{type(obj).__name__}")

    async def flush(self):
        self.calls.append("flush")


def test_new_process_is_flushed_before_its_event():
    session = _RecordingSession()
    message = {"id": "m1", "subject": "Interview", "from": "hr@acme.com", "date": datetime(2026, 10, 6, 12, 0)}
    result = ex.normalize_result(
        {
            "relevant": True,
            "company": "Acme",
            "kind": "recruiter_screen",
            "status": "scheduled",
            "scheduled_at": "2026-10-08T18:00:00Z",
        },
        "UTC",
    )
    outcome = asyncio.run(svc.apply_extraction(session, "u1", message, result))
    assert outcome == "created"
    assert session.calls.index("add:InterviewProcess") < session.calls.index("flush") < session.calls.index(
        "add:InterviewEvent"
    )


def test_summarize_counts():
    soon = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    later = (datetime.now(timezone.utc) + timedelta(days=20)).isoformat()
    processes = [
        {"status": "active", "stage": "interviewing", "needs_action": True,
         "events": [{"status": "scheduled", "scheduled_at": soon}, {"status": "scheduled", "scheduled_at": later}]},
        {"status": "active", "stage": "offer", "needs_action": False, "events": []},
        {"status": "closed", "stage": "rejected", "needs_action": False, "events": []},
    ]
    assert svc.summarize(processes) == {"active": 2, "upcoming_week": 1, "needs_action": 1, "offers": 1, "closed": 1}
