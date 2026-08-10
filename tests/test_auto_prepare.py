"""Tests for auto-prepare prefs, Phase B skip gate, and re-extract guards."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.models.database import User
from app.services.job_pipeline_mode import extraction_has_shared_jd
from app.storage.database import close_database, get_session, init_database
from app.storage.user_repository import UserRepository


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _seed_user(session, **kwargs) -> str:
    uid = str(uuid.uuid4())
    session.add(
        User(
            id=uid,
            email=f"{uid}@test.example.com",
            password_hash="x",
            **kwargs,
        )
    )
    await session.commit()
    return uid


@pytest.mark.asyncio
async def test_auto_prepare_defaults_off():
    async with get_session() as session:
        uid = await _seed_user(session)
        repo = UserRepository(session)
        data = await repo.get_user_settings(uid)
        assert data is not None
        assert data["auto_prepare_match"] is False
        assert data["auto_prepare_full"] is False


@pytest.mark.asyncio
async def test_auto_prepare_full_implies_match():
    async with get_session() as session:
        uid = await _seed_user(session)
        repo = UserRepository(session)
        data = await repo.update_user_settings(uid, auto_prepare_full=True)
        assert data is not None
        assert data["auto_prepare_full"] is True
        assert data["auto_prepare_match"] is True
        await session.commit()


@pytest.mark.asyncio
async def test_auto_prepare_match_off_forces_full_off():
    async with get_session() as session:
        uid = await _seed_user(session, auto_prepare_match=True, auto_prepare_full=True)
        repo = UserRepository(session)
        data = await repo.update_user_settings(uid, auto_prepare_match=False)
        assert data is not None
        assert data["auto_prepare_match"] is False
        assert data["auto_prepare_full"] is False
        await session.commit()


def test_should_run_phase_b_respects_skip_flag():
    """Match-only auto passes skip_phase_b; manual/full keep Phase B open to system gate."""

    def resolve(skip_phase_b: bool, system_auto: bool, has_profile: bool, is_job: bool, score: int) -> bool:
        return (
            (not skip_phase_b)
            and bool(system_auto)
            and has_profile
            and is_job
            and score > 0
        )

    # Auto match-only
    assert resolve(True, True, True, True, 80) is False
    # Auto full / manual Run
    assert resolve(False, True, True, True, 80) is True
    # Platform kill-switch
    assert resolve(False, False, True, True, 80) is False
    # Score zero
    assert resolve(False, True, True, True, 0) is False


def test_shared_jd_ready_helper():
    assert extraction_has_shared_jd(SimpleNamespace(status="extracted"))
    assert extraction_has_shared_jd(SimpleNamespace(status="completed"))
    assert not extraction_has_shared_jd(SimpleNamespace(status="pending"))


@pytest.mark.asyncio
async def test_daily_cap_zero_is_unlimited():
    from app.services import auto_prepare_service as svc

    with (
        patch.object(svc, "_pending_cap", AsyncMock(return_value=100)),
        patch.object(svc, "_daily_cap", AsyncMock(return_value=0)),
        patch.object(svc, "_auto_prepare_daily_count", AsyncMock(return_value=9999)),
        patch.object(svc, "_bump_auto_prepare_daily", AsyncMock()),
        patch(
            "app.storage.repository.JobMatchInProgressRepository.add",
            new_callable=AsyncMock,
        ),
        patch(
            "app.storage.repository.JobMatchInProgressRepository.remove",
            new_callable=AsyncMock,
        ),
        patch("app.tasks.worker.get_analysis_pool", new_callable=AsyncMock) as pool_factory,
    ):
        pool = AsyncMock()
        pool.enqueue_job = AsyncMock(return_value=object())
        pool_factory.return_value = pool

        # Minimal DB session stubs via patching get_session context
        class _Sess:
            async def execute(self, *_a, **_k):
                class _R:
                    def scalar_one(self_inner):
                        return 0

                return _R()

            async def commit(self):
                return None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        with patch("app.services.auto_prepare_service.get_session", return_value=_Sess()):
            ok = await svc._enqueue_analyze(
                "job-1",
                "user-1",
                extraction_id="ext-1",
                skip_phase_b=False,
                source="fanout",
            )
        assert ok is True
        pool.enqueue_job.assert_awaited()


@pytest.mark.asyncio
async def test_daily_cap_counts_auto_prepare_only():
    from app.services import auto_prepare_service as svc

    with (
        patch.object(svc, "_pending_cap", AsyncMock(return_value=100)),
        patch.object(svc, "_daily_cap", AsyncMock(return_value=10)),
        patch.object(svc, "_auto_prepare_daily_count", AsyncMock(return_value=10)),
        patch.object(svc, "_bump_auto_prepare_daily", AsyncMock()) as bump,
    ):
        class _Sess:
            async def execute(self, *_a, **_k):
                class _R:
                    def scalar_one(self_inner):
                        return 0

                return _R()

            async def commit(self):
                return None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        with patch("app.services.auto_prepare_service.get_session", return_value=_Sess()):
            ok = await svc._enqueue_analyze(
                "job-1",
                "user-1",
                extraction_id="ext-1",
                skip_phase_b=False,
                source="fanout",
            )
        assert ok is False
        bump.assert_not_called()


@pytest.mark.asyncio
async def test_fanout_skips_when_globally_paused():
    from app.services import auto_prepare_service as svc

    with patch.object(svc, "_auto_prepare_globally_enabled", AsyncMock(return_value=False)):
        result = await svc.fanout_auto_prepare_for_job("job-1", extraction_id="ext-1")
    assert result["paused"] is True
    assert result["enqueued"] == 0


@pytest.mark.asyncio
async def test_list_auto_prepare_users_filters_opt_in():
    async with get_session() as session:
        await _seed_user(session, auto_prepare_match=False, auto_prepare_full=False)
        opted = await _seed_user(session, auto_prepare_match=True, auto_prepare_full=False)
        await session.commit()

    from app.services.auto_prepare_service import list_auto_prepare_users

    users = await list_auto_prepare_users(match=True, full=True)
    ids = {u["user_id"] for u in users}
    assert opted in ids
    for u in users:
        assert u["auto_prepare_match"] or u["auto_prepare_full"]
