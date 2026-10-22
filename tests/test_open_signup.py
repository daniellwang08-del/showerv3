import asyncio
from contextlib import asynccontextmanager

import pytest

from app.models.database import CreditLedgerEntry, User
from app.services import session_auth, store_service
from app.storage.user_repository import UserRepository


def run(coro):
    return asyncio.run(coro)


class _Result:
    def __init__(self, scalar=None, rowcount=0):
        self._scalar = scalar
        self.rowcount = rowcount

    def scalar_one(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._scalar


class _Session:
    def __init__(self, *results):
        self._results = list(results)
        self.added = []

    async def execute(self, _stmt):
        return self._results.pop(0)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass


def test_a_new_signup_can_use_nao_at_once_with_the_welcome_credits():
    session = _Session(
        _Result(scalar=1),  # one admin already exists
        _Result(scalar=store_service.SIGNUP_CREDITS),  # balance after the bonus
        _Result(rowcount=0),  # packages waiting for this email
    )
    user = run(UserRepository(session).create("  New@Example.com ", "Str0ng-password"))

    assert user.email == "new@example.com"
    assert user.approval_status == "approved" and user.approved_at is not None
    assert user.is_active and not user.is_admin
    (entry,) = [o for o in session.added if isinstance(o, CreditLedgerEntry)]
    assert (entry.delta, entry.balance_after, entry.reason) == (50, 50, "signup_bonus")
    assert session._results == []


def test_the_first_account_becomes_the_admin_without_credits():
    session = _Session(_Result(scalar=0))
    user = run(UserRepository(session).create("owner@example.com", "Str0ng-password"))

    assert user.is_admin and user.approval_status == "approved"
    assert not [o for o in session.added if isinstance(o, CreditLedgerEntry)]


def test_signups_per_ip_are_capped_tighter_than_logins(monkeypatch):
    from fastapi import HTTPException
    from starlette.requests import Request

    from app.api import rate_limit, routes
    from app.models.auth_schemas import SignupRequest

    seen = {}

    async def capture(_request, **kwargs):
        seen.update(kwargs)
        raise HTTPException(status_code=429, detail="slow down")

    monkeypatch.setattr(rate_limit, "enforce_auth_rate_limit", capture)
    body = SignupRequest(email="new@example.com", password="Str0ng-password")
    with pytest.raises(HTTPException):
        run(routes.signup(body, None, Request({"type": "http", "headers": []})))
    assert seen["scope"] == "signup"
    assert (seen["per_ip"], seen["per_ip_window"]) == (10, 3600)


def _resolve(monkeypatch, user):
    from app.services import token_denylist

    @asynccontextmanager
    async def session_cm():
        yield None

    async def not_revoked(_jti):
        return False

    async def by_id(_self, _uid):
        return user

    monkeypatch.setattr(session_auth.AuthService, "verify_token", staticmethod(lambda _t: {"user_id": "u1"}))
    monkeypatch.setattr(token_denylist, "is_jti_revoked", not_revoked)
    monkeypatch.setattr(session_auth, "get_session", session_cm)
    monkeypatch.setattr(UserRepository, "get_by_id", by_id)
    return run(session_auth.resolve_session("token"))


@pytest.mark.parametrize("status", ["approved", "pending"])
def test_every_account_that_is_not_blocked_gets_a_session(monkeypatch, status):
    user = User(id="u1", email="a@x.io", is_active=True, approval_status=status)
    assert _resolve(monkeypatch, user).user is user


def test_a_blocked_account_is_signed_out(monkeypatch):
    user = User(id="u1", email="a@x.io", is_active=True, approval_status="rejected")
    with pytest.raises(session_auth.SessionAuthError) as err:
        _resolve(monkeypatch, user)
    assert err.value.status_code == 401 and err.value.auth_status == "rejected"
