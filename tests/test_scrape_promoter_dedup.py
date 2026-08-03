"""Exact source-URL promotion drops must not create or re-extract jobs."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services import scrape_promoter as promoter


@pytest.mark.asyncio
async def test_promote_drops_exact_url_duplicate_without_enqueue():
    existing = SimpleNamespace(
        id="job-existing",
        extraction_id="ext-existing",
        source_url="https://boards.greenhouse.io/acme/jobs/1",
        normalized_url="https://boards.greenhouse.io/acme/jobs/1",
        status="active",
    )
    row = {
        "id": "scraped-1",
        "source": "jobright",
        "source_job_id": "abc",
        "url": "https://jobright.ai/jobs/abc",
        "origin_url": "https://boards.greenhouse.io/acme/jobs/1",
        "title": "Engineer",
        "company_name": "Acme",
    }

    session = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()

    class _SessionCtx:
        async def __aenter__(self):
            return session

        async def __aexit__(self, *args):
            return False

    enqueue = AsyncMock(return_value=True)

    with (
        patch.object(promoter, "get_session", return_value=_SessionCtx()),
        patch.object(promoter, "_find_existing_job_by_url", AsyncMock(return_value=existing)),
        patch.object(promoter, "_stamp_promoted", AsyncMock()) as stamp,
        patch.object(promoter, "_enqueue_extraction", enqueue),
        patch.object(promoter, "_is_blocked_domain", return_value=None),
    ):
        outcome = await promoter.promote_single_scraped_row(
            row, scrape_run_id="run-1", enqueue=True, user_id=None
        )

    assert outcome["bucket"] == "exact_duplicate_dropped"
    assert outcome["enqueued"] is False
    assert outcome["job_id"] == "job-existing"
    assert outcome["extraction_id"] == "ext-existing"
    stamp.assert_awaited_once()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_promote_creates_new_when_url_unknown():
    row = {
        "id": "scraped-2",
        "source": "remoterocketship",
        "source_job_id": "xyz",
        "url": "https://boards.greenhouse.io/newco/jobs/99",
        "origin_url": None,
        "title": "Designer",
        "company_name": "NewCo",
        "location": "Remote",
        "description": "Build things",
        "posted_at": None,
        "experience_level": None,
        "salary_raw": None,
        "salary_min_cents": None,
        "salary_max_cents": None,
        "salary_currency": None,
        "salary_period": None,
        "is_remote": True,
        "job_type": None,
        "tags": [],
        "scraped_at": None,
    }

    created_extraction = SimpleNamespace(id="ext-new")

    class _FakeRepo:
        def __init__(self, session):
            self.session = session

        async def create(self, **kwargs):
            return created_extraction

    class _Session:
        def __init__(self):
            self.added = []
            self._flushed = False

        def add(self, obj):
            if getattr(obj, "id", None) is None:
                obj.id = "job-new"
            self.added.append(obj)

        async def flush(self):
            self._flushed = True

        async def commit(self):
            return None

        async def rollback(self):
            return None

        async def execute(self, *args, **kwargs):
            return None

    session = _Session()

    class _SessionCtx:
        async def __aenter__(self):
            return session

        async def __aexit__(self, *args):
            return False

    enqueue = AsyncMock(return_value=True)

    with (
        patch.object(promoter, "get_session", return_value=_SessionCtx()),
        patch.object(promoter, "_find_existing_job_by_url", AsyncMock(return_value=None)),
        patch.object(promoter, "_stamp_promoted", AsyncMock()),
        patch.object(promoter, "_enqueue_extraction", enqueue),
        patch.object(promoter, "_is_blocked_domain", return_value=None),
        patch.object(promoter, "JobExtractionRepository", _FakeRepo),
    ):
        outcome = await promoter.promote_single_scraped_row(
            row, scrape_run_id="run-2", enqueue=True, user_id=None
        )

    assert outcome["bucket"] == "new"
    assert outcome["enqueued"] is True
    assert outcome["extraction_id"] == "ext-new"
    enqueue.assert_awaited_once()
