from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.models.database import InterviewEvent, Job, MailApplication
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
            ("Sr. Back-End Engineer", "Senior Backend Engineer"),
            ("Software Engineer III - R37", "Software Engineer III"),
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
            (
                "Senior Software Engineer, Backend (Batch Infrastructure)",
                "Senior Software Engineer, Backend (Card)",
            ),
            ("Senior Staff Machine Learning Engineer", "Staff Machine Learning Engineer"),
            (
                "Senior Backend Engineer - Databases Tempo | US | Remote",
                "Senior Backend Engineer - Databases Tempo | Canada | Remote",
            ),
        ],
    )
    def test_different_role(self, a, b):
        assert not apps.roles_match(a, b)

    def test_compatible_with_a_job_the_user_marked(self):
        assert apps.roles_compatible(None, "Senior Engineer, Payments")
        assert apps.roles_compatible("Software Engineer", "Software Engineer, AI & Automation")
        assert apps.roles_compatible("Software Engineer - Video", "US")
        assert not apps.roles_compatible(
            "Staff Software Engineer, Backend (Capacity Modeling)",
            "Senior Software Engineer, Backend (Reliability Platform)",
        )

    @pytest.mark.parametrize(
        "subject",
        [
            "Welcome to Randstad!",
            "Confirm your Meta Career Profile email address",
            "Finish your Humana application today",
            "Thank you and Survey Request",
        ],
    )
    def test_account_and_survey_mail_is_a_follow_up(self, subject):
        assert apps.is_follow_up(subject)

    def test_confirmations_are_not_follow_ups(self):
        assert not apps.is_follow_up("Thank you for applying to Acme")
        assert not apps.is_follow_up(None)


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


def _stored(role="Software Engineer", at=datetime(2026, 10, 1, 9), message_id="old", company="Acme", subject=None, sender=None):
    return MailApplication(
        id="a1", user_id="u1", company=company, company_key=ex.company_key(company), role_title=role,
        applied_at=at, message_id=message_id, email_subject=subject, email_from=sender,
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

    def test_same_title_in_another_team_is_a_new_application(self):
        session = _AppSession([_stored(role="Senior Software Engineer, Backend (Card)")])
        message = {"id": "m2", "subject": "Application received", "date": datetime(2026, 10, 2, 9)}
        result = _confirmation(role="Senior Software Engineer, Backend (Lakehouse)")
        assert asyncio.run(apps.record_application(session, "u1", message, result))

    @pytest.mark.parametrize("stored_role,new_role", [(None, "Software Engineer"), ("Software Engineer", None)])
    def test_email_without_a_role_repeats_the_application(self, stored_role, new_role):
        stored = _stored(role=stored_role)
        session = _AppSession([stored])
        message = {"id": "m2", "subject": "Thanks for applying to Acme", "date": datetime(2026, 10, 1, 10)}
        assert asyncio.run(apps.record_application(session, "u1", message, _confirmation(role=new_role))) is None
        assert stored.role_title == "Software Engineer"

    def test_account_email_after_a_confirmation_repeats_it(self):
        session = _AppSession([_stored(company="Randstad USA", at=datetime(2026, 10, 3, 19, 12))])
        message = {"id": "m2", "subject": "Welcome to Randstad!", "date": datetime(2026, 10, 3, 19, 13)}
        result = _confirmation(company="Randstad", role=None)
        assert asyncio.run(apps.record_application(session, "u1", message, result)) is None
        assert session.added == []

    def test_follow_up_that_is_the_only_confirmation_is_stored(self):
        session = _AppSession([])
        message = {"id": "m1", "subject": "Finish your Humana application today", "date": datetime(2026, 9, 25)}
        result = _confirmation(company="Humana", role="Lead Full Stack Engineer")
        assert asyncio.run(apps.record_application(session, "u1", message, result))

    def test_confirmation_after_an_account_email_takes_over_its_row(self):
        welcome = _stored(role=None, company="Randstad", subject="Welcome to Randstad!")
        session = _AppSession([welcome])
        message = {"id": "m2", "subject": "Thank you for applying with Randstad USA", "date": datetime(2026, 10, 1, 9, 1)}
        result = _confirmation(company="Randstad USA", role="Software Engineer III")
        assert asyncio.run(apps.record_application(session, "u1", message, result)) is None
        assert (welcome.company_key, welcome.role_title, welcome.email_subject) == (
            "randstad usa", "Software Engineer III", "Thank you for applying with Randstad USA"
        )

    def test_follow_up_for_another_role_is_a_new_application(self):
        session = _AppSession([_stored(role="Data Engineer", company="Meta")])
        message = {"id": "m2", "subject": "Confirm your Meta Career Profile email address", "date": datetime(2026, 10, 1, 10)}
        result = _confirmation(company="Meta", role="Data Scientist")
        assert asyncio.run(apps.record_application(session, "u1", message, result))

    def test_employer_note_through_a_platform_replaces_the_platform_row(self):
        platform = _stored(
            role="Senior Integrations Engineer", company="Clera", at=datetime(2026, 10, 1, 9),
            subject="Thanks for applying to Clera!", sender="Clera Hiring Team <no-reply@ashbyhq.com>",
        )
        session = _AppSession([platform])
        message = {
            "id": "m2", "subject": "Your application through Clera", "from": "PAXAFE <no-reply@paxafe.com>",
            "date": datetime(2026, 10, 1, 9, 3),
        }
        result = _confirmation(company="PAXAFE, Inc.", role="Senior Integrations Engineer")
        assert asyncio.run(apps.record_application(session, "u1", message, result)) is None
        assert (platform.company, platform.company_key) == ("PAXAFE, Inc.", "paxafe")

    def test_platform_note_after_the_employer_is_ignored(self):
        employer = _stored(
            role="Staff Fullstack Engineer", company="Aleph", subject="Your application through Clera",
            sender="Aleph <no-reply@aleph.com>",
        )
        session = _AppSession([employer])
        message = {"id": "m2", "subject": "Thanks for applying to Clera!", "date": datetime(2026, 10, 1, 9, 2)}
        result = _confirmation(company="Clera", role="Staff Fullstack Engineer")
        assert asyncio.run(apps.record_application(session, "u1", message, result)) is None
        assert employer.company == "Aleph"

    def test_unrelated_company_with_the_same_title_is_a_new_application(self):
        session = _AppSession([_stored(company="Globex", subject="Thanks for applying to Globex")])
        message = {"id": "m2", "subject": "Thanks for applying to Acme", "date": datetime(2026, 10, 1, 9, 5)}
        assert asyncio.run(apps.record_application(session, "u1", message, _confirmation()))


def _job(id, title, company="Acme", posted=datetime(2026, 9, 20)):
    return Job(id=id, title=title, company=company, posted_date=posted, raw_metadata={})


class TestLinkPicking:
    def test_email_without_a_role_confirms_the_nearby_nao_mark(self):
        app = _stored(role=None, at=datetime(2026, 10, 9, 0, 2))
        marked = [
            (_job("j1", "Senior Software Engineer"), datetime(2026, 10, 9, 0, 1), "Jiadong"),
            (_job("j2", "Data Engineer"), datetime(2026, 9, 20), "Jiadong"),
        ]
        assert apps._pick_marked(app, marked, set()).id == "j1"

    def test_mark_at_another_company_or_already_claimed_is_skipped(self):
        app = _stored(role=None, at=datetime(2026, 10, 9))
        marked = [
            (_job("j1", "Engineer", company="Globex"), datetime(2026, 10, 9), "Jiadong"),
            (_job("j2", "Engineer"), datetime(2026, 10, 9), "Jiadong"),
        ]
        assert apps._pick_marked(app, marked, {"j2"}) is None

    def test_users_own_mark_beats_an_email_mark_on_a_duplicate_posting(self):
        app = _stored(role="Senior Engineer", at=datetime(2026, 10, 9, 0, 19))
        marked = [
            (_job("copy", "Senior Engineer"), datetime(2026, 10, 9, 0, 19), apps.EMAIL_APPLIED_LABEL),
            (_job("mine", "Senior Engineer"), datetime(2026, 10, 9, 0, 18), "Jiadong"),
        ]
        assert apps._pick_marked(app, marked, set()).id == "mine"

    def test_one_pool_job_per_email_and_only_the_same_team(self):
        app = _stored(role="Senior Software Engineer, Backend (Batch Infrastructure)")
        jobs = [
            _job("card", "Senior Software Engineer, Backend (Card)"),
            _job("old", "Senior Software Engineer, Backend (Batch Infrastructure)", posted=datetime(2026, 9, 1)),
            _job("new", "Senior Software Engineer, Backend (Batch Infrastructure)", posted=datetime(2026, 9, 25)),
        ]
        assert apps._pick_pool_job(app, jobs, set()).id == "new"
        assert apps._pick_pool_job(app, jobs, {"new", "old"}) is None


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
