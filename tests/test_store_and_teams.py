import asyncio
import re

import pytest
from sqlalchemy.dialects import postgresql

from app.models.database import TeamInvite, TeamMember, TeamSpace, User, UserPackage
from app.services import store_service, team_service
from app.services.job_add_batches import job_share_visibility_clause


def run(coro):
    return asyncio.run(coro)


class _Result:
    def __init__(self, rows=None, scalar=None, rowcount=0):
        self._rows = rows or []
        self._scalar = scalar
        self.rowcount = rowcount

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None

    def scalar_one_or_none(self):
        return self._scalar

    def scalar_one(self):
        return self._scalar

    def scalars(self):
        return iter(self._rows)


class _Session:
    """Scripted ``execute`` results in order, plus an id map for ``get``."""

    def __init__(self, *results, objects=None):
        self._results = list(results)
        self.objects = objects or {}
        self.added = []
        self.flushed = 0

    async def execute(self, _stmt):
        return self._results.pop(0)

    async def get(self, _model, key):
        return self.objects.get(key)

    def add(self, obj):
        self.added.append(obj)

    def add_all(self, objs):
        self.added.extend(objs)

    async def flush(self):
        self.flushed += 1

    async def refresh(self, _obj):
        return None


def _user(uid="u1", email="me@example.com", **kw):
    return User(id=uid, email=email, is_admin=kw.pop("is_admin", False), is_active=kw.pop("is_active", True), **kw)


# ── Catalog and validation ─────────────────────────────────────────────────


def test_catalog_matches_the_published_prices():
    prices = {c["code"]: (c["kind"], c["credits"], c["price_cents"]) for c in store_service.catalog_public()}
    assert prices == {
        "starter": ("credits", 250, 2500),
        "growth": ("credits", 500, 4500),
        "pro": ("credits", 1000, 8000),
        "scale": ("credits", 10000, 50000),
        "team": ("team", 0, 2000),
    }


def test_email_normalization():
    assert store_service.normalize_email("  Pat@Example.COM ") == "pat@example.com"
    assert store_service.normalize_email("<pat@example.com>") == "pat@example.com"
    assert store_service.normalize_email("not-an-email") is None
    assert store_service.normalize_email("") is None


def test_space_names_are_trimmed_and_bounded():
    assert team_service.clean_name("  Growth   squad ") == "Growth squad"
    with pytest.raises(team_service.TeamError):
        team_service.clean_name("   ")
    with pytest.raises(team_service.TeamError):
        team_service.clean_name("x" * 81)


def test_share_values_are_checked():
    assert team_service.clean_share("TEAM") == "team"
    with pytest.raises(team_service.TeamError):
        team_service.clean_share("users")


def test_invite_emails_are_deduplicated_and_exclude_the_lead():
    assert team_service.clean_invite_emails(["a@x.io", "A@x.io", "b@x.io"], "lead@x.io") == ["a@x.io", "b@x.io"]
    with pytest.raises(team_service.TeamError, match="You lead this space"):
        team_service.clean_invite_emails(["lead@x.io"], "Lead@x.io")
    with pytest.raises(team_service.TeamError, match="not a valid email"):
        team_service.clean_invite_emails(["nope"], "lead@x.io")
    with pytest.raises(team_service.TeamError, match="up to 10"):
        team_service.clean_invite_emails([f"p{i}@x.io" for i in range(11)], "lead@x.io")


def test_public_id_is_nao_plus_eight_digits_and_retries_on_collision():
    session = _Session(_Result(scalar="taken"), _Result(scalar=None))
    public_id = run(team_service.new_public_id(session))
    assert re.fullmatch(r"nao-\d{8}", public_id)
    assert session._results == []


# ── Credits ────────────────────────────────────────────────────────────────


def test_spending_more_than_the_balance_is_refused():
    session = _Session(_Result(scalar=None))
    with pytest.raises(store_service.StoreError, match="Not enough credits"):
        run(store_service.add_credits(session, "u1", -5, reason="test"))
    assert session.added == []


def test_credit_change_writes_a_ledger_row_with_the_new_balance():
    session = _Session(_Result(scalar=300))
    assert run(store_service.add_credits(session, "u1", 250, reason="package", note="Starter package")) == 300
    (entry,) = session.added
    assert (entry.user_id, entry.delta, entry.balance_after, entry.reason) == ("u1", 250, 300, "package")


# ── Gifts ──────────────────────────────────────────────────────────────────


def test_gift_to_own_email_is_refused_before_touching_the_package():
    with pytest.raises(store_service.StoreError, match="your own email"):
        run(store_service.gift(_Session(), _user(), "p1", "ME@example.com"))


def test_gift_to_an_admin_is_refused():
    pkg = UserPackage(id="p1", code="pro", kind="credits", owner_user_id="u1", status="held")
    admin = _user("a1", "boss@example.com", is_admin=True)
    session = _Session(_Result(scalar=admin), objects={"p1": pkg})
    with pytest.raises(store_service.StoreError, match="Admin accounts"):
        run(store_service.gift(session, _user(), "p1", "boss@example.com"))


def test_used_packages_cannot_be_given_or_redeemed():
    pkg = UserPackage(id="p1", code="pro", kind="credits", owner_user_id="u1", status="redeemed")
    session = _Session(objects={"p1": pkg})
    with pytest.raises(store_service.StoreError, match="already used"):
        run(store_service.mark_redeemed(session, "u1", "p1", kind="credits"))


def test_someone_elses_package_is_not_found():
    pkg = UserPackage(id="p1", code="pro", kind="credits", owner_user_id="other", status="held")
    with pytest.raises(store_service.StoreNotFound):
        run(store_service.mark_redeemed(_Session(objects={"p1": pkg}), "u1", "p1", kind="credits"))


def test_a_team_package_cannot_be_redeemed_as_credits():
    pkg = UserPackage(id="p1", code="team", kind="team", owner_user_id="u1", status="held")
    with pytest.raises(store_service.StoreError, match="cannot be used that way"):
        run(store_service.mark_redeemed(_Session(objects={"p1": pkg}), "u1", "p1", kind="credits"))


def test_double_redeem_race_is_caught_by_the_conditional_update():
    pkg = UserPackage(id="p1", code="pro", kind="credits", owner_user_id="u1", status="held")
    session = _Session(_Result(rowcount=0), objects={"p1": pkg})
    with pytest.raises(store_service.StoreError, match="already used"):
        run(store_service.mark_redeemed(session, "u1", "p1", kind="credits"))


def test_admin_grant_rejects_unknown_codes_and_admin_recipients():
    with pytest.raises(store_service.StoreError, match="Unknown package"):
        run(store_service.grant(_Session(), "admin", _user(), "gold"))
    with pytest.raises(store_service.StoreError, match="Admin accounts"):
        run(store_service.grant(_Session(), "admin", _user(is_admin=True), "pro"))


def test_admin_grant_creates_one_held_package_per_unit():
    session = _Session(_Result(rows=[]))
    out = run(store_service.grant(session, "admin", _user(), "team", 2))
    assert len(out) == 2
    assert all(p["kind"] == "team" and p["status"] == "held" and p["price_cents"] == 2000 for p in out)


def test_recipient_lists_are_split_deduplicated_and_checked():
    emails, invalid = store_service.split_recipients(["A@x.io, b@x.io;\nnot-an-email", "a@x.io  <c@x.io>"])
    assert emails == ["a@x.io", "b@x.io", "c@x.io"]
    assert invalid == [{"email": "not-an-email", "reason": "Not a valid email address."}]


def test_admins_and_disabled_accounts_are_skipped_but_new_emails_are_kept():
    accounts = {
        "lead@x.io": _user("u1", "lead@x.io"),
        "boss@x.io": _user("u2", "boss@x.io", is_admin=True),
        "gone@x.io": _user("u3", "gone@x.io", is_active=False),
    }
    targets, skipped = store_service.classify_recipients(
        ["lead@x.io", "boss@x.io", "gone@x.io", "new@x.io"], accounts
    )
    assert [(t.email, t.user.id if t.user else None) for t in targets] == [("lead@x.io", "u1"), ("new@x.io", None)]
    assert [s["email"] for s in skipped] == ["boss@x.io", "gone@x.io"]


def test_bulk_grant_gives_every_recipient_the_whole_bundle():
    session = _Session(_Result(rows=[_user("u1", "lead@x.io")]))
    out = run(
        store_service.grant_many(
            session, "admin", ["lead@x.io", "new@x.io", "bad"], [("pro", 2), ("team", 1)], note="  Welcome   aboard "
        )
    )
    assert out["total_packages"] == 6
    assert [(g["email"], g["pending"], g["count"]) for g in out["granted"]] == [
        ("lead@x.io", False, 3),
        ("new@x.io", True, 3),
    ]
    assert out["skipped"] == [{"email": "bad", "reason": "Not a valid email address."}]
    pending = [p for p in session.added if p.owner_user_id is None]
    assert len(pending) == 3 and all(p.owner_email == "new@x.io" for p in pending)
    assert {p.note for p in session.added} == {"Welcome aboard"}
    assert all(p.source == "admin_grant" and p.granted_by_user_id == "admin" for p in session.added)


def test_bulk_grant_needs_packages_and_someone_who_can_receive_them():
    with pytest.raises(store_service.StoreError, match="at least one package"):
        run(store_service.grant_many(_Session(), "admin", ["a@x.io"], []))
    with pytest.raises(store_service.StoreError, match="Nobody on that list"):
        run(store_service.grant_many(_Session(_Result(rows=[_user(is_admin=True)])), "admin", ["me@example.com"], [("pro", 1)]))
    with pytest.raises(store_service.StoreError, match="between 1 and 20"):
        run(store_service.grant_many(_Session(), "admin", ["a@x.io"], [("pro", 21)]))


def test_only_unused_packages_can_be_revoked():
    used = UserPackage(id="p1", code="pro", kind="credits", status="redeemed", owner_user_id="u1")
    with pytest.raises(store_service.StoreError, match="already used"):
        run(store_service.revoke(_Session(_Result(rowcount=0), objects={"p1": used}), "admin", "p1", None))
    with pytest.raises(store_service.StoreNotFound):
        run(store_service.revoke(_Session(), "admin", "missing", None))


def test_revoking_a_held_package_reports_who_revoked_it():
    pkg = UserPackage(
        id="p1", code="pro", kind="credits", credits=1000, price_cents=8000, status="held",
        source="admin_grant", owner_user_id="u1", granted_by_user_id="a1",
    )
    session = _Session(
        _Result(rowcount=1),
        _Result(rows=[_user("u1")]),
        _Result(rows=[_user("a1", "admin@x.io", is_admin=True)]),
        objects={"p1": pkg},
    )
    out = run(store_service.revoke(session, "a1", "p1", "Granted by mistake"))
    assert out["id"] == "p1"
    assert out["granted_by"]["email"] == "admin@x.io"


# ── Team spaces ────────────────────────────────────────────────────────────


def test_creating_a_space_consumes_the_team_package():
    pkg = UserPackage(id="p1", code="team", kind="team", owner_user_id="u1", status="held")
    lead = _user()
    session = _Session(_Result(rowcount=1), _Result(scalar=None), objects={"p1": pkg})
    space = run(team_service.create_space(session, lead, "p1", "  Sales  team "))
    assert space["name"] == "Sales team"
    assert re.fullmatch(r"nao-\d{8}", space["public_id"])
    assert space["lead"]["id"] == "u1"
    (row,) = [o for o in session.added if isinstance(o, TeamSpace)]
    assert row.package_id == "p1" and pkg.redeemed_ref == row.id


def test_a_credit_package_cannot_open_a_space():
    pkg = UserPackage(id="p1", code="pro", kind="credits", owner_user_id="u1", status="held")
    with pytest.raises(team_service.TeamError):
        run(team_service.create_space(_Session(objects={"p1": pkg}), _user(), "p1", "Team"))


def test_only_the_lead_can_manage_a_space():
    space = TeamSpace(id="s1", public_id="nao-00000001", name="T", owner_user_id="lead")
    with pytest.raises(team_service.TeamNotFound):
        run(team_service.space_detail(_Session(objects={"s1": space}), _user("intruder"), "s1"))


def test_invite_for_another_email_is_not_found():
    invite = TeamInvite(id="i1", team_space_id="s1", email="someone@x.io", status="pending")
    with pytest.raises(team_service.TeamNotFound):
        run(team_service.respond_invite(_Session(objects={"i1": invite}), _user(), "i1", accept=True))


def test_a_member_can_join_a_second_team():
    invite = TeamInvite(id="i1", team_space_id="s2", email="me@example.com", status="pending")
    target = TeamSpace(id="s2", public_id="nao-00000002", name="New", owner_user_id="lead2")
    current = TeamSpace(id="s1", public_id="nao-00000001", name="Old", owner_user_id="lead1")
    session = _Session(
        _Result(rows=[(TeamMember(user_id="u1", team_space_id="s1", share_locked=False), current)]),
        objects={"i1": invite, "s2": target, "lead2": _user("lead2", "l2@x.io")},
    )
    out = run(team_service.respond_invite(session, _user(), "i1", accept=True))
    assert out["status"] == "accepted" and out["space"]["id"] == "s2"
    (member,) = [o for o in session.added if isinstance(o, TeamMember)]
    assert member.team_space_id == "s2"
    assert invite.status == "accepted"


def test_a_sharing_lock_from_another_team_is_kept_on_joining():
    invite = TeamInvite(id="i1", team_space_id="s2", email="me@example.com", status="pending")
    target = TeamSpace(
        id="s2", public_id="nao-00000002", name="New", owner_user_id="lead2", default_share_scope="all"
    )
    current = TeamSpace(id="s1", public_id="nao-00000001", name="Old", owner_user_id="lead1")
    me = _user(job_share_default="team")
    session = _Session(
        _Result(rows=[(TeamMember(user_id="u1", team_space_id="s1", share_locked=True), current)]),
        objects={"i1": invite, "s2": target, "lead2": _user("lead2", "l2@x.io")},
    )
    run(team_service.respond_invite(session, me, "i1", accept=True))
    assert me.job_share_default == "team"


def test_accepting_a_team_you_are_already_on_adds_no_row():
    invite = TeamInvite(id="i1", team_space_id="s1", email="me@example.com", status="pending")
    space = TeamSpace(id="s1", public_id="nao-00000001", name="T", owner_user_id="lead")
    session = _Session(
        _Result(rows=[(TeamMember(user_id="u1", team_space_id="s1"), space)]),
        objects={"i1": invite, "s1": space, "lead": _user("lead", "l@x.io")},
    )
    assert run(team_service.respond_invite(session, _user(), "i1", accept=True))["status"] == "accepted"
    assert not [o for o in session.added if isinstance(o, TeamMember)]
    assert invite.status == "accepted"


def test_leaving_one_team_needs_that_membership():
    with pytest.raises(team_service.TeamNotFound):
        run(team_service.leave(_Session(_Result(rowcount=0)), _user(), "s9"))
    session = _Session(_Result(rowcount=1))
    run(team_service.leave(session, _user(), "s1"))
    assert session.flushed == 1


def test_accepting_applies_the_space_sharing_policy():
    invite = TeamInvite(id="i1", team_space_id="s1", email="me@example.com", status="pending")
    space = TeamSpace(
        id="s1",
        public_id="nao-00000001",
        name="T",
        owner_user_id="lead",
        default_share_scope="team",
        default_share_locked=True,
    )
    me = _user(job_share_default="private")
    session = _Session(_Result(rows=[]), objects={"i1": invite, "s1": space, "lead": _user("lead", "l@x.io")})
    out = run(team_service.respond_invite(session, me, "i1", accept=True))
    assert out["status"] == "accepted"
    (member,) = [o for o in session.added if isinstance(o, TeamMember)]
    assert member.share_locked is True and me.job_share_default == "team"
    assert invite.status == "accepted"


def test_declining_marks_the_invite():
    invite = TeamInvite(id="i1", team_space_id="s1", email="me@example.com", status="pending")
    space = TeamSpace(id="s1", public_id="nao-00000001", name="T", owner_user_id="lead")
    session = _Session(objects={"i1": invite, "s1": space})
    assert run(team_service.respond_invite(session, _user(), "i1", accept=False)) == {"status": "declined"}
    assert invite.status == "declined"


def test_locked_scope_reads_the_members_default():
    assert run(team_service.locked_share_scope(_Session(_Result(rows=[("all",)])), "u1")) == "all"
    assert run(team_service.locked_share_scope(_Session(_Result(rows=[("bogus",)])), "u1")) == "private"
    assert run(team_service.locked_share_scope(_Session(_Result(rows=[])), "u1")) is None


def test_lock_info_names_every_team_that_locked_it():
    rows = [("Sales", "nao-00000001"), ("Growth", "nao-00000002")]
    info = run(team_service.sharing_lock_info(_Session(_Result(rows=rows)), "u1"))
    assert info == {"job_share_locked": True, "team_space_name": "Sales, Growth", "team_space_public_id": "nao-00000001"}
    assert run(team_service.sharing_lock_info(_Session(_Result(rows=[])), "u1"))["job_share_locked"] is False


def test_team_visibility_is_scoped_to_shared_spaces():
    sql = str(
        job_share_visibility_clause("viewer").compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )
    assert "team_members" in sql and "team_spaces" in sql


def test_locked_member_cannot_reshare_a_batch(monkeypatch):
    from app.models.database import JobAddBatch
    from app.services import job_add_batches

    batch = JobAddBatch(id="b1", user_id="u1", share_scope="team", job_count=1)

    async def owned(_session, _user_id, _batch_id):
        return batch

    async def locked(_session, _user_id):
        return "team"

    monkeypatch.setattr(job_add_batches, "get_owned_batch", owned)
    monkeypatch.setattr(team_service, "locked_share_scope", locked)
    with pytest.raises(ValueError, match="team lead"):
        run(job_add_batches.update_share(_Session(), "u1", "b1", share_scope="all"))


# ── Lead insights ──────────────────────────────────────────────────────────


def test_lead_can_view_only_members_of_their_own_spaces():
    assert run(team_service.lead_can_view(_Session(_Result(scalar="m1")), "lead", "u2")) is True
    assert run(team_service.lead_can_view(_Session(_Result(scalar=None)), "lead", "u2")) is False


def _patch_access(monkeypatch, allowed):
    from contextlib import asynccontextmanager

    from app.api import team_access

    calls = []

    @asynccontextmanager
    async def session_cm():
        yield _Session()

    async def can_view(_session, lead_id, member_id):
        calls.append((lead_id, member_id))
        return allowed

    monkeypatch.setattr(team_access, "get_session", session_cm)
    monkeypatch.setattr(team_service, "lead_can_view", can_view)
    return team_access, calls


def test_insights_default_to_the_viewer_without_a_lookup(monkeypatch):
    team_access, calls = _patch_access(monkeypatch, allowed=False)
    assert run(team_access.insights_subject("lead", None)) == "lead"
    assert run(team_access.insights_subject("lead", "lead")) == "lead"
    assert calls == []


def test_a_lead_reads_their_member_and_anyone_else_gets_404(monkeypatch):
    from fastapi import HTTPException

    team_access, _ = _patch_access(monkeypatch, allowed=True)
    assert run(team_access.insights_subject("lead", "u2")) == "u2"

    team_access, _ = _patch_access(monkeypatch, allowed=False)
    with pytest.raises(HTTPException) as err:
        run(team_access.insights_subject("stranger", "u2"))
    assert err.value.status_code == 404


def test_team_insights_are_for_the_lead_only():
    space = TeamSpace(id="s1", public_id="nao-00000001", name="T", owner_user_id="lead")
    with pytest.raises(team_service.TeamNotFound):
        run(team_service.team_insights(_Session(objects={"s1": space}), _user("intruder"), "s1", 30, None))


def test_team_insights_bucket_member_activity_by_local_day(monkeypatch):
    from datetime import datetime

    space = TeamSpace(id="s1", public_id="nao-00000001", name="Growth", owner_user_id="lead")
    member = TeamMember(user_id="u2", team_space_id="s1")
    pat = _user("u2", "pat@example.com")
    now = datetime(2026, 10, 20, 15, 0)
    monkeypatch.setattr(team_service, "utcnow", lambda: now)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now.replace(tzinfo=tz) if tz else now

    monkeypatch.setattr(team_service, "datetime", _Frozen)
    session = _Session(
        _Result(rows=[(member, pat)]),
        # Job adds: one today, one from 3:00 UTC which is yesterday evening in New York.
        _Result(rows=[("u2", datetime(2026, 10, 20, 14, 0), 4), ("u2", datetime(2026, 10, 20, 3, 0), 2)]),
        _Result(rows=[("u2", datetime(2026, 10, 20, 13, 0))]),
        _Result(rows=[("u2", datetime(2026, 10, 18, 13, 0))]),
        _Result(rows=[("u2", datetime(2026, 10, 19, 16, 0))]),
        # Window stats: adds, marks, outside applications, active processes, upcoming interviews.
        _Result(rows=[]),
        _Result(rows=[]),
        _Result(rows=[]),
        _Result(rows=[("u2", 1, datetime(2026, 10, 20, 12, 0))]),
        _Result(rows=[("u2", "p1", datetime(2026, 10, 22, 15, 0)), ("u2", "p2", datetime(2026, 10, 23, 15, 0))]),
        objects={"s1": space},
    )
    data = run(team_service.team_insights(session, _user("lead"), "s1", 7, "America/New_York"))

    assert data["days"] == 7
    assert data["dates"][-1] == "2026-10-20"
    series = data["members"][0]["series"]
    assert series["added"][-1] == 4 and series["added"][-2] == 2
    assert series["applied"][-1] == 1 and series["applied"][-3] == 1
    assert series["interviews"][-2] == 1
    totals = data["totals"]
    assert totals == {
        "members": 1,
        "active_members": 1,
        "jobs_added": 6,
        "applied": 2,
        "interview_updates": 1,
        "active_interviews": 1,
        "upcoming_interviews": 2,
    }


def test_team_insights_fall_back_to_thirty_days_for_unknown_ranges():
    space = TeamSpace(id="s1", public_id="nao-00000001", name="T", owner_user_id="lead")
    data = run(team_service.team_insights(_Session(_Result(rows=[]), objects={"s1": space}), _user("lead"), "s1", 45, None))
    assert data["days"] == 30 and len(data["dates"]) == 30 and data["members"] == []
