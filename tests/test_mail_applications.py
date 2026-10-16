from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.models.database import InterviewEvent, MailApplication
from app.services import interview_extraction as ex
from app.services import interview_service as svc
from app.services import mail_applications as apps


class TestRoleMatching:
    @pytest.mark.parametrize(
        "a,b",
        [
            ("Software Engineer", "software engineer"),
            ("Software Engineer (Remote)", "Software Engineer"),
            ("Senior Backend Engineer - Remote, US", "Senior Backend Engineer"),
            ("Data Analyst, Full Time", "Data Analyst 12345"),
        ],
    )
    def test_same_role(self, a, b):
        assert apps.roles_match(a, b)

    @pytest.mark.parametrize(
        "a,b",
        [
            ("Senior Software Engineer", "Software Engineer"),
            ("Product Designer", "Product Manager"),
            ("Software Engineer", None),
            (None, None),
        ],
    )
    def test_different_role(self, a, b):
        assert not apps.roles_match(a, b)


class TestConfirmationPrefilter:
    @pytest.mark.parametrize(
        "subject,snippet,sender",
        [
            ("Thank you for applying to Acme", "", "no-reply@greenhouse.io"),
            ("Raoyinc, your application was sent to Acme", "", "jobs-noreply@linkedin.com"),
            ("Application submitted: Data Analyst", "", "indeedapply@indeed.com"),
            ("Acme careers", "We have received your application for Engineer", "careers@acme.com"),
        ],
    )
    def test_keeps_confirmations(self, subject, snippet, sender):
        assert ex.is_candidate(subject, snippet, sender)

    def test_job_alerts_still_dropped(self):
        assert not ex.is_candidate("30 new jobs for you", "apply now", "jobs-noreply@linkedin.com")


class TestEmailUrl:
    def _conn(self, provider, email="me@example.com"):
        return SimpleNamespace(provider=provider, email=email)

    def test_gmail_opens_the_message_in_the_right_account(self):
        url = apps.email_url(self._conn("google", "me+jobs@gmail.com"), "1a1117759990d2f9", "t1")
        assert url == "https://mail.google.com/mail/?authuser=me%2Bjobs@gmail.com#all/1a1117759990d2f9"

    def test_outlook_deeplink(self):
        url = apps.email_url(self._conn("microsoft"), "AAMk/abc=")
        assert url == "https://outlook.office.com/mail/deeplink/read/AAMk%2Fabc%3D"

    def test_unknown_provider_or_manual_event_has_no_link(self):
        assert apps.email_url(self._conn("imap"), "m1") is None
        assert apps.email_url(self._conn("google"), None) is None
        assert apps.email_url(None, "m1") is None


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _AppSession:
    def __init__(self, rows):
        self.rows = rows
        self.added: list = []

    async def execute(self, _stmt):
        return _Rows(self.rows)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass


def _confirmation(company="Acme", role="Software Engineer"):
    return ex.normalize_result(
        {"relevant": True, "company": company, "role": role, "kind": "application_received", "status": "info"},
        "UTC",
    )


def _stored(role="Software Engineer", at=datetime(2026, 10, 1, 9), message_id="old"):
    return MailApplication(
        id="a1", user_id="u1", company="Acme", company_key="acme", role_title=role,
        applied_at=at, message_id=message_id,
    )


class TestRecordApplication:
    def test_new_confirmation_is_stored(self):
        session = _AppSession([])
        message = {"id": "m1", "subject": "Thanks for applying", "from": "jobs@acme.com", "date": datetime(2026, 10, 5)}
        row = asyncio.run(apps.record_application(session, "u1", message, _confirmation("Acme, Inc.")))
        assert row is not None and session.added == [row]
        assert (row.company_key, row.role_title, row.applied_at) == ("acme", "Software Engineer", datetime(2026, 10, 5))

    def test_second_email_for_the_same_application_is_ignored(self):
        session = _AppSession([_stored()])
        message = {"id": "m2", "subject": "Application received", "date": datetime(2026, 10, 2, 9)}
        assert asyncio.run(apps.record_application(session, "u1", message, _confirmation())) is None
        assert session.added == []

    def test_other_role_at_the_same_company_is_a_new_application(self):
        session = _AppSession([_stored()])
        message = {"id": "m2", "subject": "Application received", "date": datetime(2026, 10, 2, 9)}
        assert asyncio.run(apps.record_application(session, "u1", message, _confirmation(role="Data Engineer")))

    def test_reapplying_later_counts_again(self):
        session = _AppSession([_stored()])
        message = {"id": "m2", "subject": "Application received", "date": datetime(2026, 10, 1, 9) + timedelta(days=20)}
        assert asyncio.run(apps.record_application(session, "u1", message, _confirmation()))

    def test_without_company_nothing_is_stored(self):
        session = _AppSession([])
        message = {"id": "m1", "date": datetime(2026, 10, 5)}
        result = {"company": "  ", "role": "Engineer", "kind": "application_received"}
        assert asyncio.run(apps.record_application(session, "u1", message, result)) is None


def test_dedup_reason_names_company_role_and_date():
    assert apps.dedup_reason(_stored()) == (
        "You applied to Acme (Software Engineer) on Oct 01, 2026, found in your email."
    )


def _event(id, status, message_id="m", email_date=None, scheduled_at=None):
    return InterviewEvent(
        id=id, process_id="p1", user_id="u1", kind="technical", status=status,
        message_id=message_id, email_date=email_date, scheduled_at=scheduled_at,
    )


class TestPrimaryEmail:
    def test_upcoming_round_wins(self):
        upcoming = _event("e2", "scheduled", "m2", datetime(2026, 10, 1), datetime(2099, 1, 1))
        events = [_event("e1", "info", "m1", datetime(2026, 10, 9)), upcoming]
        assert svc.primary_email_event(events, [upcoming]) is upcoming

    def test_open_request_beats_newer_info(self):
        request = _event("e1", "needs_scheduling", "m1", datetime(2026, 10, 1))
        events = [request, _event("e2", "info", "m2", datetime(2026, 10, 9))]
        assert svc.primary_email_event(events, []) is request

    def test_falls_back_to_latest_email_and_ignores_manual_steps(self):
        latest = _event("e2", "completed", "m2", datetime(2026, 10, 9))
        events = [_event("e1", "completed", "m1", datetime(2026, 10, 1)), latest, _event("e3", "info", None)]
        assert svc.primary_email_event(events, []) is latest
        assert svc.primary_email_event([_event("e3", "info", None)], []) is None


class _FakeClient:
    def __init__(self, responses, calls):
        self._responses = responses
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def request(self, method, url, **kwargs):
        self._calls.append(method)
        return self._responses.pop(0)


def _patch_client(monkeypatch, responses):
    import httpx

    from app.services import nylas_service

    calls: list[str] = []
    monkeypatch.setattr(nylas_service, "RETRY_BASE_DELAY", 0.0)
    monkeypatch.setattr(nylas_service.httpx, "AsyncClient", lambda **_: _FakeClient(responses, calls))
    return nylas_service, httpx, calls


def test_reads_retry_gateway_timeouts(monkeypatch):
    import httpx

    responses = [httpx.Response(504, text="timeout"), httpx.Response(200, json={"data": [{"id": "m1"}]})]
    nylas, _, calls = _patch_client(monkeypatch, responses)
    data = asyncio.run(nylas._request("GET", "/v3/grants/g1/messages"))
    assert data == {"data": [{"id": "m1"}]}
    assert calls == ["GET", "GET"]


def test_writes_are_not_retried(monkeypatch):
    import httpx

    nylas, _, calls = _patch_client(monkeypatch, [httpx.Response(503), httpx.Response(200, json={})])
    with pytest.raises(nylas.MailError):
        asyncio.run(nylas._request("POST", "/v3/grants/g1/thing"))
    assert calls == ["POST"]


def test_event_payload_carries_email_link():
    conn = SimpleNamespace(provider="google", email="me@gmail.com")
    payload = svc.event_public(_event("e1", "info", "abc", datetime(2026, 10, 1)), conn)
    assert payload["email_url"] == "https://mail.google.com/mail/?authuser=me@gmail.com#all/abc"
    assert svc.event_public(_event("e2", "info", None))["email_url"] is None
