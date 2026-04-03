import pytest
import uuid
from unittest.mock import AsyncMock, patch
from app.services.extraction_service import ExtractionService
from app.storage.database import init_database, close_database, get_session
from app.storage.repository import JobExtractionRepository


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


@pytest.mark.asyncio
async def test_extraction_service_success():
    service = ExtractionService()
    url = f"https://example.com/job-{uuid.uuid4()}"

    async with get_session() as session:
        repo = JobExtractionRepository(session)
        job = await repo.create(url, url, "example.com")
        job_id = job.id

    long_body = (
        "We need a developer. Requirements: Python. Responsibilities: Coding. "
        * 25
    )
    mock_http = AsyncMock()
    mock_http.fetch.return_value = (
        f"<html><body><h1>Job Title</h1><div class='job-description'>{long_body}</div></body></html>",
        200,
        {},
    )
    service.http_service = mock_http

    mock_cache = AsyncMock()
    service.cache = mock_cache

    result = await service.process_job(job_id, url)

    assert result["status"] == "extracted"
    assert result["job_id"] == job_id
    assert result["content_length"] > 0
    mock_cache.store.assert_called_once()

    async with get_session() as session:
        repo = JobExtractionRepository(session)
        updated_job = await repo.get_by_id(job_id)
        assert updated_job.status.value == "extracted"


@pytest.mark.asyncio
async def test_extraction_service_failure():
    service = ExtractionService()
    url = f"https://example.com/fail-{uuid.uuid4()}"

    async with get_session() as session:
        repo = JobExtractionRepository(session)
        job = await repo.create(url, url, "example.com")
        job_id = job.id

    mock_http = AsyncMock()
    mock_http.fetch.side_effect = Exception("Network Error")
    service.http_service = mock_http

    result = await service.process_job(job_id, url)

    assert result["status"] == "failed"
    assert "Network Error" in result["error"]

    async with get_session() as session:
        repo = JobExtractionRepository(session)
        updated_job = await repo.get_by_id(job_id)
        assert updated_job.status.value == "failed"


@pytest.mark.asyncio
async def test_browser_extractor_returns_plain_text(monkeypatch):
    from app.extractors.browser_extractor import BrowserExtractor

    class DummyPage:
        async def goto(self, url, wait_until, timeout):
            return None
        async def wait_for_selector(self, *args, **kwargs):
            return None
        async def wait_for_load_state(self, *args, **kwargs):
            return None
        async def evaluate(self, *args, **kwargs):
            return 800
        @property
        def main_frame(self):
            return self
        @property
        def frames(self):
            return [self]
        @property
        def url(self):
            return "https://example.com/job"
        async def content(self):
            return "<html><body><h1>Software Engineer</h1><p>Great job description with details about the role and requirements for applicants.</p></body></html>"

    class DummyAcquire:
        def __init__(self):
            self.page = DummyPage()
        async def __aenter__(self):
            return self.page
        async def __aexit__(self, *args):
            return False

    class DummyPool:
        def acquire_page(self):
            return DummyAcquire()

    monkeypatch.setattr("app.extractors.browser_extractor.get_browser_pool", lambda: DummyPool())

    extractor = BrowserExtractor()
    result = await extractor.extract("https://example.com/job")

    assert result.success is True
    assert result.raw_content is not None
    assert "Software Engineer" in result.raw_content
    assert result.structured_data is None


@pytest.mark.asyncio
async def test_worker_enqueues_analysis_after_extraction(monkeypatch):
    from app.tasks.worker import extract_job

    mock_service = AsyncMock()
    mock_service.process_job.return_value = {
        "job_id": "test-job-id",
        "status": "extracted",
        "method": "static_html",
        "content_length": 500,
    }
    monkeypatch.setattr("app.tasks.worker.ExtractionService", lambda: mock_service)

    class MockValidJobRepo:
        def __init__(self, session):
            pass
        async def get_by_extraction_id(self, extraction_id):
            return type("VJ", (), {"id": "valid-job-1"})()

    class MockProgressRepo:
        def __init__(self, session):
            pass
        async def add(self, valid_job_id, user_id):
            return None
        async def remove(self, valid_job_id, user_id):
            return None

    class DummySession:
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc, tb):
            return False
        async def commit(self):
            return None

    def dummy_session_context():
        return DummySession()

    monkeypatch.setattr("app.tasks.worker.get_session", dummy_session_context)
    monkeypatch.setattr("app.tasks.worker.ValidJobRepository", MockValidJobRepo)
    monkeypatch.setattr("app.tasks.worker.JobMatchInProgressRepository", MockProgressRepo)
    monkeypatch.setattr("app.tasks.worker.publish_ws_event", AsyncMock())

    enqueued = []
    class DummyPool:
        async def enqueue_job(self, *args):
            enqueued.append(args)
        async def close(self):
            pass

    monkeypatch.setattr("app.tasks.worker.get_analysis_pool", AsyncMock(return_value=DummyPool()))

    result = await extract_job({}, "test-job-id", "https://example.com/job", "user-1")

    assert result["status"] == "extracted"
    assert len(enqueued) == 1
    assert enqueued[0][0] == "analyze_job_match"
