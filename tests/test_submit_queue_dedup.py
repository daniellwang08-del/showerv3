"""Tests for exact-URL submit dedup (in-flight extraction / match analysis)."""

import uuid

import pytest
from sqlalchemy import select

from app.models.database import JobExtraction, JobMatchInProgress, User, ValidJob
from app.models.schemas import ExtractionStatus
from app.services.submit_queue_dedup import find_inflight_valid_job_with_same_url
from app.storage.database import close_database, get_session, init_database


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _user(session) -> str:
    uid = str(uuid.uuid4())
    session.add(User(id=uid, email=f"{uid}@t.example.com", password_hash="x"))
    await session.commit()
    return uid


def _url():
    return f"https://example.com/job/{uuid.uuid4()}"


@pytest.mark.asyncio
async def test_no_match_when_no_jobs():
    u = _url()
    async with get_session() as session:
        uid = await _user(session)
        found = await find_inflight_valid_job_with_same_url(session, source_url=u, user_id=uid)
        assert found is None


@pytest.mark.asyncio
async def test_finds_pending_extraction_same_exact_url():
    url = _url()
    async with get_session() as session:
        uid = await _user(session)
        ext = JobExtraction(
            source_url=url,
            normalized_url=url,
            domain="example.com",
            status=ExtractionStatus.PENDING,
        )
        session.add(ext)
        await session.flush()
        vj = ValidJob(
            source_url=url,
            normalized_url=url,
            domain="example.com",
            title="T",
            company="C",
            extraction_id=ext.id,
        )
        session.add(vj)
        await session.commit()
        vid = vj.id

    async with get_session() as session:
        found = await find_inflight_valid_job_with_same_url(session, source_url=url, user_id=uid)
        assert found is not None
        assert found.id == vid


@pytest.mark.asyncio
async def test_no_match_when_extraction_completed_and_no_match_progress():
    url = _url()
    async with get_session() as session:
        uid = await _user(session)
        ext = JobExtraction(
            source_url=url,
            normalized_url=url,
            domain="example.com",
            status=ExtractionStatus.COMPLETED,
        )
        session.add(ext)
        await session.flush()
        vj = ValidJob(
            source_url=url,
            normalized_url=url,
            domain="example.com",
            title="T",
            company="C",
            extraction_id=ext.id,
        )
        session.add(vj)
        await session.commit()

    async with get_session() as session:
        found = await find_inflight_valid_job_with_same_url(session, source_url=url, user_id=uid)
        assert found is None


@pytest.mark.asyncio
async def test_finds_when_match_in_progress():
    url = _url()
    async with get_session() as session:
        uid = await _user(session)
        ext = JobExtraction(
            source_url=url,
            normalized_url=url,
            domain="example.com",
            status=ExtractionStatus.COMPLETED,
        )
        session.add(ext)
        await session.flush()
        vj = ValidJob(
            source_url=url,
            normalized_url=url,
            domain="example.com",
            title="T",
            company="C",
            extraction_id=ext.id,
        )
        session.add(vj)
        await session.flush()
        session.add(
            JobMatchInProgress(
                id=str(uuid.uuid4()),
                valid_job_id=vj.id,
                user_id=uid,
            )
        )
        await session.commit()
        vid = vj.id

    async with get_session() as session:
        found = await find_inflight_valid_job_with_same_url(session, source_url=url, user_id=uid)
        assert found is not None
        assert found.id == vid


@pytest.mark.asyncio
async def test_string_must_match_exactly_not_normalized():
    stored = "https://EXAMPLE.com/a"
    submitted = "https://example.com/a"
    async with get_session() as session:
        uid = await _user(session)
        ext = JobExtraction(
            source_url=stored,
            normalized_url=stored,
            domain="example.com",
            status=ExtractionStatus.PENDING,
        )
        session.add(ext)
        await session.flush()
        session.add(
            ValidJob(
                source_url=stored,
                normalized_url=stored,
                domain="example.com",
                title="T",
                company="C",
                extraction_id=ext.id,
            )
        )
        await session.commit()

    async with get_session() as session:
        found = await find_inflight_valid_job_with_same_url(session, source_url=submitted, user_id=uid)
        assert found is None
