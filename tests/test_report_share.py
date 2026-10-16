from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.services import report_share as rs
from app.utils.secret_encryption import decrypt_secret


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

    def test_tokens_hash_consistently(self):
        token, digest = rs.new_token()
        assert len(token) >= 32
        assert rs.hash_token(token) == digest
        assert rs.new_token()[0] != token


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


class _FakeSession:
    def __init__(self):
        self.added = []

    def add(self, row):
        self.added.append(row)

    async def flush(self):
        return None


class TestShareWith:
    def _run(self, monkeypatch, existing, emails, **kw):
        async def fake_list(session, owner_id):
            return existing

        monkeypatch.setattr(rs, "list_shares", fake_list)
        session = _FakeSession()
        owner = SimpleNamespace(id="u1", email="me@x.com")
        opts = {"expires_in_days": 30, "include_notes": False, "message": None, **kw}
        return session, asyncio.run(rs.share_with(session, owner, emails, **opts))

    def test_creates_one_link_per_person(self, monkeypatch):
        session, shares = self._run(monkeypatch, [], ["a@x.com", "b@x.com"], message="  Hi  ")
        assert [s.email for s in shares] == ["a@x.com", "b@x.com"]
        assert len(session.added) == 2
        assert shares[0].token_hash != shares[1].token_hash
        assert rs.hash_token(decrypt_secret(shares[0].token_enc)) == shares[0].token_hash
        assert shares[0].message == "Hi"
        assert shares[0].expires_at is not None

    def test_reinvite_keeps_the_link_and_renews_access(self, monkeypatch):
        old = SimpleNamespace(email="a@x.com", token_hash="h", token_enc="t", include_notes=False, expires_at=None, message=None)
        session, shares = self._run(monkeypatch, [old], ["a@x.com"], expires_in_days=7, include_notes=True)
        assert shares == [old] and session.added == []
        assert old.token_hash == "h" and old.include_notes is True and old.expires_at is not None

    def test_limit(self, monkeypatch):
        existing = [SimpleNamespace(email=f"p{i}@x.com") for i in range(rs.MAX_SHARES)]
        with pytest.raises(rs.ShareError, match="up to"):
            self._run(monkeypatch, existing, ["new@x.com"])
