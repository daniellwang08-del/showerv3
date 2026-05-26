"""Tests for extraction failure hidden-job handling."""

import uuid

import pytest
from sqlalchemy import select

from app.models.database import Job, User, UserJobStatus
from app.services.extraction_failure_handler import mark_extraction_failed_for_user
from app.services.job_exclusion_types import EXTRACTION_FAILED_EXCLUSION
from app.storage.database import close_database, get_session, init_database


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


@pytest.mark.asyncio
async def test_mark_extraction_failed_hides_job_for_user():
    async with get_session() as session:
        user_id = str(uuid.uuid4())
        job_id = str(uuid.uuid4())
        session.add(User(id=user_id, email=f"{user_id}@test.example.com", password_hash="x"))
        session.add(
            Job(
                id=job_id,
                source_url="https://example.com/expired",
                normalized_url="https://example.com/expired",
                domain="example.com",
                title="Untitled",
                company="Unknown",
                status="active",
            )
        )
        session.add(
            UserJobStatus(
                id=str(uuid.uuid4()),
                user_id=user_id,
                job_id=job_id,
                status="active",
            )
        )
        await session.commit()

        await mark_extraction_failed_for_user(
            session,
            job_id=job_id,
            user_id=user_id,
            error="Job posting expired or removed",
        )
        await session.commit()

        job_row = await session.execute(select(Job).where(Job.id == job_id))
        job = job_row.scalar_one()
        assert job.status == "extraction_failed"

        ujs_row = await session.execute(
            select(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == job_id,
            )
        )
        ujs = ujs_row.scalar_one()
        assert ujs.status == "duplicated"
        assert ujs.exclusion_type == EXTRACTION_FAILED_EXCLUSION
        assert "expired" in (ujs.reason or "").lower()
