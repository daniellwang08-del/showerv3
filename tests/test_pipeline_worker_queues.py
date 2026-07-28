"""Worker queue separation + arq pending depth helpers."""

from __future__ import annotations

import asyncio

import pytest

from app.api.admin_routes import _arq_queue_pending
from app.tasks.worker import (
    ANALYSIS_QUEUE,
    TAILORING_QUEUE,
    AnalysisWorkerSettings,
    TailoringWorkerSettings,
    generate_tailored_content,
    _forward_phase_b_to_tailoring_queue,
)
from run_worker import _install_main_event_loop


def test_phase_a_and_phase_b_use_separate_queues():
    assert ANALYSIS_QUEUE != TAILORING_QUEUE
    assert AnalysisWorkerSettings.queue_name == ANALYSIS_QUEUE
    assert TailoringWorkerSettings.queue_name == TAILORING_QUEUE


def test_analysis_worker_only_forwards_legacy_phase_b():
    names = []
    for item in AnalysisWorkerSettings.functions:
        name = getattr(item, "name", None) or getattr(item, "__name__", None)
        names.append(name)
    assert "analyze_job_match" in names
    assert "generate_tailored_content" in names
    # Real Phase B coroutine lives on the tailoring worker.
    assert generate_tailored_content in TailoringWorkerSettings.functions
    assert generate_tailored_content not in AnalysisWorkerSettings.functions
    assert any(
        getattr(item, "coroutine", None) is _forward_phase_b_to_tailoring_queue
        or item is _forward_phase_b_to_tailoring_queue
        for item in AnalysisWorkerSettings.functions
    )


@pytest.mark.asyncio
async def test_arq_queue_pending_reads_zset_not_llen():
    class FakeRedis:
        def __init__(self):
            self.calls = []

        async def type(self, key):
            self.calls.append(("type", key))
            return b"zset"

        async def zcard(self, key):
            self.calls.append(("zcard", key))
            return 7

        async def llen(self, key):
            self.calls.append(("llen", key))
            raise AssertionError("llen must not be used for arq zset queues")

    pending = await _arq_queue_pending(FakeRedis(), "job_tailoring")
    assert pending == 7


def test_install_main_event_loop_recovers_after_asyncio_run():
    """Regression: asyncio.run() closes the loop; arq needs get_event_loop()."""

    async def _noop() -> int:
        return 1

    asyncio.run(_noop())
    with pytest.raises(RuntimeError):
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("closed")

    loop = _install_main_event_loop()
    assert loop is asyncio.get_event_loop()
    assert not loop.is_closed()
