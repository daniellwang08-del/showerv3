import pytest
import uuid
import sys
from unittest.mock import AsyncMock, patch
from app.services.extraction_service import ExtractionService
from app.models.schemas import ExtractionMethod, JobDescriptionSchema
from app.storage.database import init_database, close_database, get_session
from app.storage.repository import JobExtractionRepository


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

    async def content(self):
        return "<html><body><h1 class='job-title'>Software Engineer</h1><div class='company-name'>Tech Corp</div><div class='job-description'>Really a great job. This position requires experience with Python, APIs, and async programming. Excellent team culture, remote-friendly, growth opportunities are strong.</div></body></html>"


class DummyAcquirePageContext:
    def __init__(self):
        self.page = DummyPage()

    async def __aenter__(self):
        return self.page

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return False


class DummyPool:
    def acquire_page(self):
        return DummyAcquirePageContext()

@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()

@pytest.mark.asyncio
async def test_extraction_service_success_mock_ai():
    # Setup
    service = ExtractionService()
    url = f"https://example.com/job-{uuid.uuid4()}"
    
    # Create job in DB
    async with get_session() as session:
        repo = JobExtractionRepository(session)
        job = await repo.create(url, url, "example.com")
        job_id = job.id

    # Mock HTTP Service — description must be "rich" (>=900 chars) so we stay on the fast static-HTML path
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

    # Mock AI Parser to return valid job data
    mock_parser = AsyncMock()
    mock_parser.parse.return_value = (
        JobDescriptionSchema(
            title="Software Engineer",
            company="Tech Corp",
            location="Remote",
            description="We need a developer. Requirements: Python. Responsibilities: Coding.",
            requirements=["Python"],
            responsibilities=["Coding"],
            employment_type="Full-time",
            salary_range="$100k-$150k"
        ),
        0.95
    )

    # Patch get_ai_parser used in the service
    with patch("app.services.extraction_service.get_ai_parser", return_value=mock_parser):
        # Patch extractors to ensure they don't actually run complex logic if we want to control flow
        # But letting them run on simple HTML is fine if AI mock handles the "parsing"
        
        result = await service.process_job(job_id, url)

    # Verify
    assert result["status"] == "completed"
    assert result["job_id"] == job_id
    assert result.get("confidence") == 0.95
    
    # Check DB
    async with get_session() as session:
        repo = JobExtractionRepository(session)
        updated_job = await repo.get_by_id(job_id)
        assert updated_job.status.value == "completed"
        assert updated_job.title == "Software Engineer"
        assert updated_job.company == "Tech Corp"

@pytest.mark.asyncio
async def test_extraction_service_failure():
    # Setup
    service = ExtractionService()
    url = f"https://example.com/fail-{uuid.uuid4()}"
    
    # Create job in DB
    async with get_session() as session:
        repo = JobExtractionRepository(session)
        job = await repo.create(url, url, "example.com")
        job_id = job.id

    # Mock HTTP Service to raise exception
    mock_http = AsyncMock()
    mock_http.fetch.side_effect = Exception("Network Error")
    service.http_service = mock_http

    result = await service.process_job(job_id, url)

    # Verify
    assert result["status"] == "failed"
    assert "Network Error" in result["error"]

    # Check DB
    async with get_session() as session:
        repo = JobExtractionRepository(session)
        updated_job = await repo.get_by_id(job_id)
        assert updated_job.status.value == "failed"
        assert updated_job.retry_count == 0


@pytest.mark.asyncio
async def test_browser_extractor_integration_structured(monkeypatch):
    from app.extractors.browser_extractor import BrowserExtractor
    from app.extractors.browser_extractor import get_browser_pool

    # Ensure browser pool is available via monkeypatch to avoid Playwright init in unit test
    monkeypatch.setattr("app.extractors.browser_extractor.get_browser_pool", lambda: DummyPool())

    extractor = BrowserExtractor()
    result = await extractor.extract("https://example.com/job")

    assert result.success is True
    assert result.structured_data is not None
    assert result.structured_data.get("title") == "Software Engineer"
    assert "great job" in (result.structured_data.get("description") or "")


@pytest.mark.asyncio
async def test_extract_job_auto_rerun_low_confidence(monkeypatch):
    from app.tasks.worker import extract_job

    mock_service = AsyncMock()
    mock_service.process_job.return_value = {
        "job_id": "test-job-id",
        "status": "completed",
        "method": "STATIC_HTML",
        "confidence": 0.45,
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

    enqueued = []
    class DummyPool:
        async def enqueue_job(self, *args):
            enqueued.append(args)

        async def close(self):
            pass

    monkeypatch.setattr("app.tasks.worker.get_redis_pool", AsyncMock(return_value=DummyPool()))

    result = await extract_job({}, "test-job-id", "https://example.com/job", "user-1")

    assert result["status"] == "completed"
    assert result["confidence"] == 0.45
    assert len(enqueued) == 1
    assert enqueued[0][0] == "analyze_job_match"


@pytest.mark.asyncio
async def test_parse_posted_date():
    service = ExtractionService()
    
    # Test timezone-aware string
    result = service._parse_posted_date("2026-03-23T17:21:00.000Z")
    assert result is not None
    assert result.tzinfo is None
    assert result.year == 2026
    assert result.month == 3
    assert result.day == 23
    
    # Test already naive datetime
    from datetime import datetime
    naive_dt = datetime(2026, 3, 23, 17, 21, 0)
    result = service._parse_posted_date(naive_dt)
    assert result == naive_dt
    
    # Test timezone-aware datetime
    import datetime as dt
    aware_dt = dt.datetime(2026, 3, 23, 17, 21, 0, tzinfo=dt.timezone.utc)
    result = service._parse_posted_date(aware_dt)
    assert result.tzinfo is None
    assert result == dt.datetime(2026, 3, 23, 17, 21, 0)
    
    # Test invalid
    result = service._parse_posted_date("invalid")
    assert result is None
