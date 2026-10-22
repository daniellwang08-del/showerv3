from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.services import report_share as rs


def _user(uid, email, **kw):
    fields = {"is_active": True, "is_admin": False, "approval_status": "approved", "name": None, "name_first": None, "name_last": None}
    return SimpleNamespace(id=uid, email=email, **{**fields, **kw})


class TestFields:
    def test_normalize_email(self):
        assert rs.normalize_email("  Sam@Example.COM ") == "sam@example.com"
        assert rs.normalize_email("<sam@example.com>") == "sam@example.com"
        assert rs.normalize_email("sam@example") is None
        assert rs.normalize_email("not an email") is None
        assert rs.normalize_email(None) is None

    def test_clean_emails_dedupes_and_rejects_bad_input(self):
        assert rs.clean_emails(["a@x.com", "A@x.com", "b@y.org"], "me@x.com") == ["a@x.com", "b@y.org"]
        with pytest.raises(rs.ShareError, match="not a valid email"):
            rs.clean_emails(["a@x.com", "nope"], "me@x.com")
        with pytest.raises(rs.ShareError, match="your own email"):
            rs.clean_emails(["ME@x.com"], "me@x.com")
        with pytest.raises(rs.ShareError, match="up to"):
            rs.clean_emails([f"p{i}@x.com" for i in range(rs.MAX_EMAILS_PER_REQUEST + 1)], None)

    def test_expiry(self):
        now = datetime(2026, 10, 16)
        assert rs.expiry_from_days(None, now) is None
        assert rs.expiry_from_days(7, now) == now + timedelta(days=7)
        with pytest.raises(rs.ShareError):
            rs.expiry_from_days(5, now)

    def test_is_active(self):
        now = datetime(2026, 10, 16)
        assert rs.is_active(SimpleNamespace(expires_at=None), now)
        assert rs.is_active(SimpleNamespace(expires_at=now + timedelta(seconds=1)), now)
        assert not rs.is_active(SimpleNamespace(expires_at=now), now)

    def test_display_name(self):
        user = lambda **kw: SimpleNamespace(**{"name": None, "name_first": None, "name_last": None, "email": "sam@x.com", **kw})
        assert rs.display_name(user(name="Sam Lee")) == "Sam Lee"
        assert rs.display_name(user(name="sam@x.com", name_first="Sam", name_last="Lee")) == "Sam Lee"
        assert rs.display_name(user()) == "sam"
        assert rs.display_name(None) == "A NAO user"

    def test_active_accounts_that_are_not_blocked_can_receive_reports(self):
        assert rs.can_view_shares(_user("u", "a@x.com"))
        assert rs.can_view_shares(_user("u", "a@x.com", is_admin=True))
        assert rs.can_view_shares(_user("u", "a@x.com", approval_status="pending"))
        assert not rs.can_view_shares(None)
        assert not rs.can_view_shares(_user("u", "a@x.com", is_active=False))
        assert not rs.can_view_shares(_user("u", "a@x.com", approval_status="rejected"))

    def test_resolve_viewers_names_missing_accounts(self):
        users = {
            "a@x.com": _user("ua", "a@x.com"),
            "admin@x.com": _user("ad", "admin@x.com", is_admin=True),
            "wait@x.com": _user("uw", "wait@x.com", approval_status="rejected"),
        }
        assert [u.id for u in rs.resolve_viewers(["a@x.com", "admin@x.com"], users)] == ["ua", "ad"]
        with pytest.raises(rs.ShareError, match="b@x.com does not have a NAO account"):
            rs.resolve_viewers(["a@x.com", "b@x.com"], users)
        with pytest.raises(rs.ShareError, match="b@x.com, wait@x.com"):
            rs.resolve_viewers(["b@x.com", "wait@x.com"], users)


def test_only_owner_routes_require_an_applicant_account():
    from app.api.report_share_routes import router
    from app.api.routes import require_applicant

    owner_only = {
        (method, route.path)
        for route in router.routes
        for method in route.methods
        if any(d.call is require_applicant for d in route.dependant.dependencies)
    }
    viewer = {(m, r.path) for r in router.routes for m in r.methods} - owner_only
    assert viewer == {("GET", "/report-shares/incoming"), ("GET", "/report-shares/incoming/{share_id}")}
    assert ("POST", "/report-shares") in owner_only and ("GET", "/report-shares/preview") in owner_only


class TestReport:
    def _event(self, **kw):
        return {
            "id": "e1",
            "status": "scheduled",
            "scheduled_at": None,
            "meeting_url": "https://zoom.us/j/1",
            "email_url": "https://mail.google.com/x",
            "email_from": "recruiter@acme.com",
            "email_subject": "Interview",
            **kw,
        }

    def test_sanitize_drops_private_fields(self):
        process = {
            "id": "p1",
            "notes": "salary 200k",
            "email_url": "https://mail.google.com/y",
            "events": [self._event()],
            "next_event": self._event(),
        }
        out = rs.sanitize_process(process, include_notes=False)
        assert out["notes"] is None
        assert out["email_url"] is None
        for e in (out["events"][0], out["next_event"]):
            assert e["meeting_url"] is None and e["email_url"] is None and e["email_from"] is None
            assert e["email_subject"] == "Interview"
        assert rs.sanitize_process(process, include_notes=True)["notes"] == "salary 200k"
        assert process["events"][0]["meeting_url"]

    def test_link_applications_by_job_then_company(self):
        processes = [
            {"id": "p-old", "company": "Acme Inc.", "stage": "rejected", "status": "closed", "job": None, "last_activity_at": "2026-09-01T00:00:00Z"},
            {"id": "p-new", "company": "ACME", "stage": "interviewing", "status": "active", "job": None, "last_activity_at": "2026-10-10T00:00:00Z"},
            {"id": "p-job", "company": "Globex", "stage": "screening", "status": "active", "job": {"id": "j9"}, "last_activity_at": None},
        ]
        apps = [
            {"id": "a", "job_id": None, "company": "Acme"},
            {"id": "b", "job_id": "j9", "company": "Something else"},
            {"id": "c", "job_id": None, "company": "Initech"},
        ]
        out = {a["id"]: a for a in rs.link_applications(apps, processes)}
        assert (out["a"]["stage"], out["a"]["process_id"], out["a"]["process_active"]) == ("interviewing", "p-new", True)
        assert (out["b"]["stage"], out["b"]["process_id"]) == ("screening", "p-job")
        assert (out["c"]["stage"], out["c"]["process_id"], out["c"]["process_active"]) == ("applied", None, False)


class TestAppliedSummary:
    ACTIVITY = {
        "series": [{"applied": 1} for _ in range(23)] + [{"applied": 5} for _ in range(7)],
        "totals": {"applied": 58},
    }

    def _run(self, monkeypatch, from_inbox):
        async def fake_inbox(session, owner_id):
            return from_inbox

        counts = iter([300, 40, 90] if from_inbox else [1037, 40, 90])

        async def fake_count(session, *where):
            return next(counts)

        monkeypatch.setattr(rs.mail_applications, "counts_from_inbox", fake_inbox)
        monkeypatch.setattr(rs, "_count", fake_count)
        return asyncio.run(rs.applied_summary(None, "u1", self.ACTIVITY, "America/New_York"))

    def test_week_and_month_come_from_the_chart_series(self, monkeypatch):
        out = self._run(monkeypatch, from_inbox=True)
        assert out["source"] == "email"
        assert (out["last_7_days"], out["last_30_days"], out["all_time"]) == (35, 58, 300)
        assert out["marked_in_nao"] == {"last_7_days": 40, "last_30_days": 90}

    def test_falls_back_to_marks_without_a_synced_inbox(self, monkeypatch):
        out = self._run(monkeypatch, from_inbox=False)
        assert out["source"] == "nao"
        assert out["all_time"] == 1037


class _FakeSession:
    def __init__(self):
        self.added = []

    def add(self, row):
        self.added.append(row)

    async def flush(self):
        return None


class TestShareWith:
    ACCOUNTS = {
        "a@x.com": _user("ua", "A@x.com"),
        "b@x.com": _user("ub", "b@x.com"),
        "new@x.com": _user("un", "new@x.com"),
    }

    def _run(self, monkeypatch, existing, emails, **kw):
        async def fake_list(session, owner_id):
            return existing

        async def fake_users(session, wanted):
            return {e: self.ACCOUNTS[e] for e in wanted if e in self.ACCOUNTS}

        monkeypatch.setattr(rs, "list_shares", fake_list)
        monkeypatch.setattr(rs, "users_by_email", fake_users)
        session = _FakeSession()
        owner = SimpleNamespace(id="u1", email="me@x.com")
        opts = {"expires_in_days": None, "include_notes": False, "message": None, **kw}
        return session, asyncio.run(rs.share_with(session, owner, emails, **opts))

    def test_shares_with_each_account(self, monkeypatch):
        session, rows = self._run(monkeypatch, [], ["a@x.com", "b@x.com"], message="  Hi  ", expires_in_days=30)
        shares = [s for s, _ in rows]
        assert [s.viewer_id for s in shares] == ["ua", "ub"]
        assert [s.email for s in shares] == ["a@x.com", "b@x.com"]
        assert len(session.added) == 2
        assert shares[0].message == "Hi"
        assert shares[0].expires_at is not None

    def test_no_end_date_by_default(self, monkeypatch):
        _, rows = self._run(monkeypatch, [], ["a@x.com"])
        assert rows[0][0].expires_at is None

    def test_unknown_email_is_rejected_and_nothing_is_saved(self, monkeypatch):
        with pytest.raises(rs.ShareError, match="nobody@x.com does not have a NAO account"):
            self._run(monkeypatch, [], ["a@x.com", "nobody@x.com"])

    def test_sharing_again_updates_access(self, monkeypatch):
        old = SimpleNamespace(viewer_id="ua", email="a@x.com", include_notes=False, expires_at=None, message=None)
        session, rows = self._run(monkeypatch, [(old, self.ACCOUNTS["a@x.com"])], ["a@x.com"], expires_in_days=7, include_notes=True)
        assert rows[0][0] is old and session.added == []
        assert old.include_notes is True and old.expires_at is not None

    def test_limit(self, monkeypatch):
        existing = [(SimpleNamespace(viewer_id=f"v{i}"), None) for i in range(rs.MAX_SHARES)]
        with pytest.raises(rs.ShareError, match="up to"):
            self._run(monkeypatch, existing, ["new@x.com"])
