"""Redis URL helpers, worker retry settings, and fail-loud production enqueue."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.core.redis_support import (
    allow_in_process_job_fallback,
    broker_redis_url,
    cache_redis_url,
    pipeline_job_id,
    pubsub_redis_url,
    require_redis_for_jobs,
    with_redis_db,
)
from app.tasks.worker import (
    AnalysisWorkerSettings,
    ExtractionWorkerSettings,
    SaveWorkerSettings,
    TailoringWorkerSettings,
)


def test_with_redis_db_rewrites_path():
    assert with_redis_db("redis://localhost:6379/0", 1) == "redis://localhost:6379/1"
    assert with_redis_db("redis://:secret@host:6380/9", 2) == "redis://:secret@host:6380/2"


def test_pipeline_job_id_joins_parts():
    assert pipeline_job_id("extract", "abc") == "extract:abc"
    assert pipeline_job_id("analyze", "j1", "u1") == "analyze:j1:u1"
    assert pipeline_job_id("a", None, "b", "") == "a:b"


def test_role_urls_fall_back_to_broker():
    settings = MagicMock()
    settings.redis_url = "redis://localhost:6379/0"
    settings.redis_cache_url = None
    settings.redis_pubsub_url = None
    with patch("app.core.redis_support.get_settings", return_value=settings):
        assert broker_redis_url() == "redis://localhost:6379/0"
        assert cache_redis_url() == "redis://localhost:6379/0"
        assert pubsub_redis_url() == "redis://localhost:6379/0"


def test_role_urls_use_overrides_when_set():
    settings = MagicMock()
    settings.redis_url = "redis://localhost:6379/0"
    settings.redis_cache_url = "redis://localhost:6379/1"
    settings.redis_pubsub_url = "redis://localhost:6379/2"
    with patch("app.core.redis_support.get_settings", return_value=settings):
        assert cache_redis_url() == "redis://localhost:6379/1"
        assert pubsub_redis_url() == "redis://localhost:6379/2"


@pytest.mark.parametrize(
    "app_env,override,expected",
    [
        ("local", None, False),
        ("production", None, True),
        ("prod", None, True),
        ("local", True, True),
        ("production", False, False),
    ],
)
def test_require_redis_for_jobs(app_env, override, expected):
    settings = MagicMock()
    settings.app_env = app_env
    settings.redis_require_for_jobs = override
    with patch("app.core.redis_support.get_settings", return_value=settings):
        assert require_redis_for_jobs() is expected
        assert allow_in_process_job_fallback() is (not expected)


def test_extraction_and_analysis_retry_transient_failures():
    assert ExtractionWorkerSettings.max_tries >= 3
    assert AnalysisWorkerSettings.max_tries >= 3
    assert TailoringWorkerSettings.max_tries >= 3
    assert SaveWorkerSettings.max_tries == 1
    assert ExtractionWorkerSettings.keep_result == 0
    assert AnalysisWorkerSettings.keep_result == 0


@pytest.mark.asyncio
async def test_enqueue_extraction_fails_loud_when_redis_required():
    from app.api import routes as routes_mod

    with (
        patch.object(routes_mod, "try_get_extraction_pool", new=AsyncMock(return_value=None)),
        patch("app.core.redis_support.allow_in_process_job_fallback", return_value=False),
        patch("app.core.redis_support.require_redis_for_jobs", return_value=True),
    ):
        with pytest.raises(HTTPException) as exc:
            await routes_mod.enqueue_extraction("eid", "https://example.com/job")
        assert exc.value.status_code == 503
