from __future__ import annotations

import base64
import contextlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

from app.models.database import InterviewEvent
from app.services import calendar_invite as ci
from app.services import interview_extraction as ex
from app.services import interview_service as svc
from app.services import nylas_service as nylas

NOW = datetime(2026, 10, 21, 22, 0)


def _epoch(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


def _raw(event_id: str, title: str, start: datetime, *, minutes: int = 30, **extra) -> dict:
    return {
        "id": event_id,
        "calendar_id": "me@example.com",
        "title": title,
        "status": "confirmed",
        "when": {"object": "timespan", "start_time": _epoch(start), "end_time": _epoch(start + timedelta(minutes=minutes))},
        "organizer": {"name": "", "email": "me@example.com"},
        "created_at": _epoch(NOW - timedelta(days=1)),
        "updated_at": _epoch(NOW - timedelta(days=1)),
        **extra,
    }


SYMETRA = _raw(
    "sym1",
    "Recruiter Interview with Symetra - Developer Advocate, AI Enablement (Remote)-9427",
    datetime(2026, 10, 30, 21, 0),
    conferencing={"provider": "Microsoft Teams", "details": {"url": "https://teams.microsoft.com/l/meetup-join/abc"}},
    text_description="Please find Interview Details for Developer Advocate at Symetra",
)


# ── Reading events ──────────────────────────────────────────────────────────


def test_event_becomes_invite_with_time_link_and_organizer():
    invite = ci.from_calendar_event(SYMETRA)
    assert invite.start == datetime(2026, 10, 30, 21, 0)
    assert invite.duration_minutes == 30
    assert invite.meeting_url == "https://teams.microsoft.com/l/meetup-join/abc"
    assert invite.organizer == "me@example.com"
    assert not invite.cancelled


def test_meeting_link_falls_back_to_location_and_description():
    raw = _raw("z", "Interview with Archive", NOW, location="https://us06web.zoom.us/j/876?pwd=x")
    assert ci.from_calendar_event(raw).meeting_url == "https://us06web.zoom.us/j/876?pwd=x"


def test_all_day_and_cancelled_events():
    all_day = {"id": "a", "title": "Holiday", "when": {"object": "date", "date": "2026-10-18"}}
    assert ci.from_calendar_event(all_day) is None
    assert ci.from_calendar_event({**SYMETRA, "status": "cancelled"}).cancelled


def test_calendar_item_shape_and_skips():
    item = svc.calendar_item(SYMETRA)
    assert item["id"] == "cal:sym1"
    assert item["thread_id"] == "me@example.com"
    assert item["source"] == "calendar"
    assert item["subject"].startswith("Recruiter Interview with Symetra")
    assert svc.calendar_item({**SYMETRA, "recurrence": ["RRULE:FREQ=WEEKLY"]}) is None


def test_describe_heading_for_calendar_events():
    text = ci.from_calendar_event(SYMETRA).describe("Calendar event:")
    assert text.splitlines()[0] == "Calendar event:"
    assert "Starts: 2026-10-30T21:00:00+00:00" in text


@pytest.mark.parametrize(
    ("title", "description", "expected"),
    [
        ("Recruiter Interview with Symetra", "", True),
        ("Onward Search-AI Engineer", "Microsoft Teams meeting Join: https://teams.microsoft.com/meet/1", True),
        ("Call with hiring manager", "", True),
        ("Dentist", "", False),
        ("Gym", "Leg day", False),
        ("", "interview", False),
    ],
)
def test_calendar_prefilter(title, description, expected):
    assert ex.is_calendar_candidate(title, description) is expected


def test_prompt_marks_calendar_items():
    assert "=== Calendar event id" in ex.SYSTEM_PROMPT
    text = ex._user_message([{"id": "m1", "source": "calendar", "subject": "Interview"}, {"id": "m2"}], "UTC")
    assert "=== Calendar event id: m1" in text and "=== Email id: m2" in text


async def test_model_sees_short_ids_and_results_map_back(monkeypatch):
    long_id = "cal:_60q30c1g60o30e1i60o4ac1g60rj8gpl88rj2c1h84s34h9g60s30c1g60o30c1g60o30c1g8gpj2dhi74qk2g9g6ook8"
    seen_prompt: list[str] = []

    async def client(*_a, **_k):
        return object()

    async def complete(_client, *, messages, **_k):
        seen_prompt.append(messages[1]["content"])
        return '{"results": [{"id": "m1", "relevant": true, "company": "Acme", "kind": "technical", "status": "info"}]}', None

    monkeypatch.setattr(ex, "get_llm_client_for_user", client)
    monkeypatch.setattr(ex, "chat_completion_with_empty_retry", complete)
    out = await ex.extract_batch("u1", [{"id": long_id, "subject": "Interview"}, {"id": "x2"}], tz_name="UTC")
    assert long_id not in seen_prompt[0]
    assert out[long_id]["company"] == "Acme"
    assert out["x2"] is None


# ── Following changes ───────────────────────────────────────────────────────


def _row(**kw) -> InterviewEvent:
    base = dict(id="e1", process_id="p1", user_id="u1", kind="recruiter_screen", status="scheduled",
                scheduled_at=datetime(2026, 10, 30, 21, 0), duration_minutes=30, meeting_url=None,
                message_id="cal:sym1", thread_id="me@example.com")
    base.update(kw)
    return InterviewEvent(**base)


def test_moved_event_updates_time():
    row = _row()
    moved = ci.from_calendar_event(_raw("sym1", "x", datetime(2026, 10, 31, 18, 0), minutes=45))
    assert svc.update_from_calendar(row, moved)
    assert row.scheduled_at == datetime(2026, 10, 31, 18, 0)
    assert row.duration_minutes == 45


def test_cancelled_then_restored():
    row = _row()
    assert svc.update_from_calendar(row, ci.from_calendar_event({**SYMETRA, "status": "cancelled"}))
    assert row.status == "cancelled"
    assert svc.update_from_calendar(row, ci.from_calendar_event(SYMETRA))
    assert row.status == "scheduled"


def test_unchanged_event_is_left_alone():
    row = _row(meeting_url="https://teams.microsoft.com/l/meetup-join/abc")
    assert not svc.update_from_calendar(row, ci.from_calendar_event(SYMETRA))


def test_calendar_source_and_links():
    google = SimpleNamespace(provider="google", email="me@example.com")
    row = _row()
    assert svc.event_source(row) == "calendar"
    url = svc.event_url(google, row)
    eid = unquote(url.split("eid=")[1])
    assert base64.b64decode(eid + "=" * (-len(eid) % 4)).decode() == "sym1 me@example.com"
    outlook = SimpleNamespace(provider="microsoft", email="me@example.com")
    assert svc.event_url(outlook, row) == "https://outlook.office.com/calendar/item/sym1"
    email_row = _row(message_id="m1", thread_id="t1")
    assert svc.event_source(email_row) == "email"
    assert "mail.google.com" in svc.event_url(google, email_row)
    assert svc.event_source(_row(message_id=None)) == "manual"


async def test_calendar_errors_do_not_flag_mail_for_reauth(monkeypatch):
    async def denied(*a, **k):
        raise nylas.MailAuthError("expired")

    monkeypatch.setattr(nylas, "_request", denied)
    with pytest.raises(nylas.CalendarUnavailable):
        await nylas.list_calendars("g1")


def test_own_calendars_skip_holidays():
    cals = [
        {"id": "holidays", "is_primary": False, "read_only": True, "is_owned_by_user": False},
        {"id": "side", "is_primary": False, "read_only": False, "is_owned_by_user": True},
        {"id": "me", "is_primary": True, "read_only": False, "is_owned_by_user": True},
    ]
    assert [c["id"] for c in nylas.own_calendars(cals)] == ["me", "side"]


# ── Sync ────────────────────────────────────────────────────────────────────


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return iter(self._rows)


class _Session:
    def __init__(self, stored):
        self.stored = stored
        self.commits = 0

    async def execute(self, _stmt):
        return _Rows(self.stored)

    async def commit(self):
        self.commits += 1

    def begin_nested(self):
        return contextlib.nullcontext()


def _setup(monkeypatch, events, *, stored=(), seen=None, booked=None, results=None):
    conn = SimpleNamespace(calendar_seen=seen)
    session = _Session(list(stored))
    applied: list[tuple[dict, dict]] = []
    sent: list[list[str]] = []

    @contextlib.asynccontextmanager
    async def get_session():
        yield session

    async def list_calendars(_g):
        return [{"id": "me@example.com", "is_primary": True}]

    async def list_events(_g, _c, *, start, end):
        return events

    async def get_connection(_s, _u):
        return conn

    async def scheduled_at(_s, _u, at):
        return booked

    async def extract_batch(_u, batch, *, tz_name):
        sent.append([m["id"] for m in batch])
        return {m["id"]: (results or {}).get(m["id"]) for m in batch}

    async def apply_extraction(_s, _u, message, result):
        applied.append((message, result))
        return "created"

    monkeypatch.setattr(svc, "_utcnow", lambda: NOW)
    monkeypatch.setattr(svc, "get_session", get_session)
    monkeypatch.setattr(nylas, "list_calendars", list_calendars)
    monkeypatch.setattr(nylas, "list_events", list_events)
    monkeypatch.setattr(nylas, "get_connection", get_connection)
    monkeypatch.setattr(svc, "_scheduled_at", scheduled_at)
    monkeypatch.setattr(ex, "extract_batch", extract_batch)
    monkeypatch.setattr(svc, "apply_extraction", apply_extraction)
    return conn, applied, sent


def _stats():
    return {"relevant": 0, "created": 0, "updated": 0}


def _result(**kw):
    base = {"company": "Symetra", "role": "Developer Advocate", "kind": "recruiter_screen", "status": "scheduled",
            "title": "Recruiter interview", "scheduled_at": None, "duration_minutes": None, "meeting_url": None}
    base.update(kw)
    return base


async def test_calendar_only_interview_is_added(monkeypatch):
    dentist = _raw("d1", "Dentist", NOW + timedelta(days=2))
    conn, applied, sent = _setup(monkeypatch, [SYMETRA, dentist], results={"cal:sym1": _result()})
    stats = _stats()
    await svc.sync_calendar("u1", "g1", "America/Los_Angeles", stats)

    assert sent == [["cal:sym1"]]
    (message, result), = applied
    assert message["source"] == "calendar"
    assert result["scheduled_at"] == datetime(2026, 10, 30, 21, 0)
    assert result["duration_minutes"] == 30
    assert result["meeting_url"] == "https://teams.microsoft.com/l/meetup-join/abc"
    assert stats["calendar"] == "ok" and stats["created"] == 1 and stats["calendar_events"] == 2
    assert conn.calendar_seen == {"cal:sym1": str(SYMETRA["updated_at"])}


def test_event_link_beats_the_models_copy():
    result = _result(meeting_url="https://teams.microsoft.com/l/meetup-join/ab")
    svc.apply_invite(result, ci.from_calendar_event(SYMETRA))
    assert result["meeting_url"] == "https://teams.microsoft.com/l/meetup-join/abc"


async def test_unrelated_events_are_not_sent_again(monkeypatch):
    call = _raw("c1", "Interview prep with friend", NOW + timedelta(days=1))
    conn, applied, sent = _setup(monkeypatch, [call], results={})
    await svc.sync_calendar("u1", "g1", "UTC", _stats())
    assert sent == [["cal:c1"]] and applied == []

    _, applied, sent = _setup(monkeypatch, [call], seen=conn.calendar_seen)
    await svc.sync_calendar("u1", "g1", "UTC", _stats())
    assert sent == [] and applied == []


async def test_event_already_booked_from_email_only_fills_details(monkeypatch):
    booked = _row(message_id="email-1", meeting_url=None, duration_minutes=None)
    _, applied, sent = _setup(monkeypatch, [SYMETRA], booked=booked)
    await svc.sync_calendar("u1", "g1", "UTC", _stats())
    assert sent == [] and applied == []
    assert booked.meeting_url == "https://teams.microsoft.com/l/meetup-join/abc"
    assert booked.duration_minutes == 30


async def test_deleted_event_cancels_the_stored_round(monkeypatch):
    stored = _row(scheduled_at=NOW + timedelta(days=3))
    _, _, sent = _setup(monkeypatch, [], stored=[stored])
    stats = _stats()
    await svc.sync_calendar("u1", "g1", "UTC", stats)
    assert stored.status == "cancelled" and stats["updated"] == 1 and sent == []


async def test_stored_event_follows_a_move_without_the_model(monkeypatch):
    stored = _row(scheduled_at=datetime(2026, 10, 29, 21, 0))
    _, applied, sent = _setup(monkeypatch, [SYMETRA], stored=[stored])
    await svc.sync_calendar("u1", "g1", "UTC", _stats())
    assert stored.scheduled_at == datetime(2026, 10, 30, 21, 0)
    assert sent == [] and applied == []


async def test_no_calendar_scope_is_reported(monkeypatch):
    _setup(monkeypatch, [])

    async def denied(_g):
        raise nylas.CalendarUnavailable()

    monkeypatch.setattr(nylas, "list_calendars", denied)
    stats = _stats()
    await svc.sync_calendar("u1", "g1", "UTC", stats)
    assert stats["calendar"] == "no_access"
