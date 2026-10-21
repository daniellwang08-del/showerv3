from __future__ import annotations

from datetime import datetime

from app.services import calendar_invite as ci
from app.services import interview_extraction as ex
from app.services import interview_service as svc
from app.services import nylas_service as nylas

OUTLOOK = "\r\n".join(
    [
        "BEGIN:VCALENDAR",
        "METHOD:REQUEST",
        "BEGIN:VTIMEZONE",
        "TZID:Eastern Standard Time",
        "BEGIN:STANDARD",
        "DTSTART:16010101T020000",
        "TZOFFSETTO:-0500",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        'ORGANIZER;CN="Ibarra, Renato":mailto:rlavat@onwardsearch.com',
        "SUMMARY;LANGUAGE=en-US:Onward Search-AI Engineer",
        "DTSTART;TZID=Eastern Standard Time:20261022T170000",
        "DTEND;TZID=Eastern Standard Time:20261022T171500",
        "BEGIN:VALARM",
        "DESCRIPTION:REMINDER",
        "END:VALARM",
        "LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting",
        "DESCRIPTION;LANGUAGE=en-US:Microsoft Teams meeting\\nJoin: https://teams.microsoft.com/meet/29877",
        " 21789936946?p=abc\\nMeeting ID: 298",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
)


def test_outlook_invite_with_windows_timezone():
    invite = ci.parse_invite(OUTLOOK)
    assert invite is not None
    assert invite.title == "Onward Search-AI Engineer"
    assert invite.start == datetime(2026, 10, 22, 21, 0)
    assert invite.duration_minutes == 15
    assert invite.organizer == "Ibarra, Renato <rlavat@onwardsearch.com>"
    assert invite.meeting_url == "https://teams.microsoft.com/meet/2987721789936946?p=abc"
    assert not invite.cancelled
    text = invite.describe()
    assert "Starts: 2026-10-22T21:00:00+00:00" in text and "Duration: 15 minutes" in text


def test_utc_iana_unknown_zone_and_cancel():
    utc = ci.parse_invite("BEGIN:VEVENT\nSUMMARY:Screen\nDTSTART:20261106T230000Z\nEND:VEVENT")
    assert utc.start == datetime(2026, 11, 6, 23, 0)
    iana = ci.parse_invite("BEGIN:VEVENT\nDTSTART;TZID=America/Los_Angeles:20261106T150000\nEND:VEVENT")
    assert iana.start == datetime(2026, 11, 6, 23, 0)
    odd = ci.parse_invite("BEGIN:VEVENT\nSUMMARY:Chat\nDTSTART;TZID=Custom Zone 7:20261106T150000\nEND:VEVENT")
    assert odd.start is None and odd.start_local == "2026-11-06 15:00 (Custom Zone 7)"
    cancel = ci.parse_invite("METHOD:CANCEL\nBEGIN:VEVENT\nSUMMARY:Screen\nDTSTART:20261106T230000Z\nEND:VEVENT")
    assert cancel.cancelled and "CANCELLED" in cancel.describe()
    assert ci.parse_invite("not a calendar") is None


def test_prefilter_keeps_teams_invites_and_still_drops_noise():
    snippet = "________ Microsoft Teams meeting Join: https://teams.microsoft.com/meet/2987721789936946"
    assert ex.is_candidate("Onward Search-AI Engineer", snippet, "Renato Ibarra <rlavat@onwardsearch.com>")
    assert ex.is_candidate("Onward Search-AI Engineer", "", "rlavat@onwardsearch.com", invite=True)
    assert not ex.is_candidate("Job alert: AI Engineer", "", "alerts@indeed.com", invite=True)
    assert not ex.is_candidate("Lunch on Friday?", "Are you free?", "friend@example.com")


def test_invite_attachment_is_found_in_headers():
    raw = {"attachments": [{"id": "a1", "filename": "invite.ics", "content_type": 'text/calendar; method=REQUEST', "size": 4941}]}
    assert nylas.calendar_invite(raw) == {"id": "a1", "size": 4941}
    assert nylas.calendar_invite({"attachments": [{"id": "a2", "filename": "cv.pdf", "content_type": "application/pdf"}]}) is None
    assert nylas.calendar_invite({}) is None


def _result(**kw):
    base = {"company": "Onward Search", "kind": "recruiter_screen", "status": "info", "scheduled_at": None,
            "duration_minutes": None, "meeting_url": None}
    return {**base, **kw}


def test_invite_time_overrides_the_model():
    invite = ci.parse_invite(OUTLOOK)
    result = _result(scheduled_at=datetime(2026, 10, 22, 17, 0))
    svc.apply_invite(result, invite)
    assert result["status"] == "scheduled"
    assert result["scheduled_at"] == datetime(2026, 10, 22, 21, 0)
    assert result["duration_minutes"] == 15
    assert result["meeting_url"].startswith("https://teams.microsoft.com/")

    confirmation = _result(kind="application_received")
    svc.apply_invite(confirmation, invite)
    assert confirmation["status"] == "info" and confirmation["scheduled_at"] is None
