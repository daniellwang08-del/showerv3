"""Production-path performance hardening: save lock defer, pools, resume parallel, autopost."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import Settings
from app.tasks.worker import (
    AUTOPOST_QUEUE,
    SAVE_LOCK_MAX_ATTEMPTS,
    SAVE_QUEUE,
    AutoPostWorkerSettings,
    SaveWorkerSettings,
    _get_shared_pool,
    _shared_pools,
    close_shared_pools,
    save_analyzed_job,
)


def test_browser_pool_aligned_with_extraction_concurrency():
    # Assert configured defaults (ignore local .env overrides).
    browser = Settings.model_fields["browser_pool_size"].default
    extract = Settings.model_fields["extraction_worker_max_jobs"].default
    rate = Settings.model_fields["rate_limit_requests_per_second"].default
    burst = Settings.model_fields["rate_limit_burst"].default
    assert browser >= extract
    assert float(rate) >= float(extract)
    assert burst >= extract


def test_autopost_worker_settings_are_dedicated():
    assert AutoPostWorkerSettings.queue_name == AUTOPOST_QUEUE
    assert AutoPostWorkerSettings.queue_name != SAVE_QUEUE
    assert AutoPostWorkerSettings.max_tries >= 1
    assert AutoPostWorkerSettings.functions[0].__name__ == "run_match_auto_posts_task"


def test_save_worker_still_single_try():
    assert SaveWorkerSettings.max_tries == 1


@pytest.mark.asyncio
async def test_get_shared_pool_does_not_ping_on_cache_hit():
    await close_shared_pools()
    fake = MagicMock()
    fake.ping = AsyncMock(side_effect=AssertionError("ping must not be called on hot path"))
    _shared_pools["job_save"] = fake
    try:
        got = await _get_shared_pool("job_save")
        assert got is fake
        fake.ping.assert_not_called()
    finally:
        _shared_pools.pop("job_save", None)


@pytest.mark.asyncio
async def test_save_lock_busy_defers_instead_of_sleeping():
    redis = AsyncMock()
    redis.set = AsyncMock(return_value=False)
    redis.delete = AsyncMock()

    save_pool = AsyncMock()
    save_pool.enqueue_job = AsyncMock(return_value=MagicMock())

    with (
        patch("app.tasks.worker.get_save_pool", new=AsyncMock(return_value=save_pool)),
        patch("app.tasks.worker.clear_job_match_progress", new=AsyncMock()),
        patch("app.tasks.worker.publish_ws_event", new=AsyncMock()),
        patch("asyncio.sleep", new=AsyncMock(side_effect=AssertionError("must not sleep"))),
    ):
        result = await save_analyzed_job(
            {"redis": redis},
            "job-1",
            "user-1",
            None,
            {"overall_score": 80, "should_run_phase_b": True},
            0,
        )

    assert result == {"deferred": "lock_busy", "lock_attempt": 1}
    save_pool.enqueue_job.assert_awaited_once()
    kwargs = save_pool.enqueue_job.await_args.kwargs
    assert kwargs.get("_defer_by") == 1.5
    redis.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_save_lock_keeps_deferring_after_soft_threshold():
    """Completed analysis must never be discarded when the per-user lock is busy."""
    redis = AsyncMock()
    redis.set = AsyncMock(return_value=False)

    save_pool = AsyncMock()
    save_pool.enqueue_job = AsyncMock(return_value=MagicMock())

    with (
        patch("app.tasks.worker.get_save_pool", new=AsyncMock(return_value=save_pool)),
        patch("app.tasks.worker.clear_job_match_progress", new=AsyncMock()) as clear_progress,
        patch("app.tasks.worker.publish_ws_event", new=AsyncMock()) as publish,
    ):
        result = await save_analyzed_job(
            {"redis": redis},
            "job-1",
            "user-1",
            None,
            {"overall_score": 80},
            SAVE_LOCK_MAX_ATTEMPTS,
        )

    assert result == {"deferred": "lock_busy", "lock_attempt": SAVE_LOCK_MAX_ATTEMPTS + 1}
    save_pool.enqueue_job.assert_awaited_once()
    clear_progress.assert_not_awaited()
    publish.assert_not_awaited()
    kwargs = save_pool.enqueue_job.await_args.kwargs
    assert kwargs.get("_defer_by") == 1.5


@pytest.mark.asyncio
async def test_save_releases_lock_before_phase_b_and_autopost():
    redis = AsyncMock()
    redis.set = AsyncMock(return_value=True)
    redis.delete = AsyncMock()

    order: list[str] = []

    async def _dedup(*_a, **_k):
        order.append("dedup")
        return {"action": "saved_active"}

    async def _delete(*_a, **_k):
        order.append("unlock")

    redis.delete = AsyncMock(side_effect=_delete)

    tailor_pool = AsyncMock()
    async def _enqueue_tailor(*_a, **_k):
        order.append("tailor")
        return MagicMock()

    tailor_pool.enqueue_job = AsyncMock(side_effect=_enqueue_tailor)

    autopost_pool = AsyncMock()
    async def _enqueue_autopost(*_a, **_k):
        order.append("autopost")
        return MagicMock()

    autopost_pool.enqueue_job = AsyncMock(side_effect=_enqueue_autopost)

    with (
        patch("app.services.post_analysis_dedup.run_post_analysis_dedup", new=_dedup),
        patch("app.tasks.worker.clear_job_match_progress", new=AsyncMock()),
        patch("app.tasks.worker.publish_ws_event", new=AsyncMock()),
        patch("app.tasks.worker.get_tailoring_pool", new=AsyncMock(return_value=tailor_pool)),
        patch("app.tasks.worker.get_autopost_pool", new=AsyncMock(return_value=autopost_pool)),
    ):
        result = await save_analyzed_job(
            {"redis": redis},
            "job-1",
            "user-1",
            "ext-1",
            {"overall_score": 90, "should_run_phase_b": True, "recommendation": "apply"},
            0,
        )

    assert result == {"action": "saved_active"}
    assert order == ["dedup", "unlock", "tailor", "autopost"]
    assert autopost_pool.enqueue_job.await_args.args[0] == "run_match_auto_posts_task"


def test_resume_build_orchestrator_uses_gather():
    import inspect
    import app.services.resume_build_orchestrator as orch

    src = inspect.getsource(orch.run_resume_build)
    assert "asyncio.gather" in src
    assert "_sync_build_resume_docx" in src
    assert "_sync_build_cover_letter_docx" in src
    assert "convert_docx_to_pdf" in src
