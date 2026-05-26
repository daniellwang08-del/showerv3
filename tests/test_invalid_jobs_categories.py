"""Integration tests for hidden-jobs tab filtering (duplicates vs low_score vs extraction_failed)."""

import uuid

import pytest
from sqlalchemy import func, select

from app.models.database import Job, User, UserJobStatus
from app.services.job_exclusion_types import (
    BELOW_MIN_SCORE_EXCLUSION,
    EXTRACTION_FAILED_EXCLUSION,
    LOWER_SCORE_EXCLUSION,
    STRICT_SIMILARITY_EXCLUSION,
)
from app.storage.database import close_database, get_session, init_database


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _seed_hidden_job(
    session,
    *,
    user_id: str,
    exclusion_type: str | None,
) -> str:
    job_id = str(uuid.uuid4())
    session.add(
        Job(
            id=job_id,
            source_url=f"https://example.com/{job_id}",
            normalized_url=f"https://example.com/{job_id}",
            domain="example.com",
            title="Engineer",
            company="Acme",
            status="active",
        )
    )
    session.add(
        UserJobStatus(
            id=str(uuid.uuid4()),
            user_id=user_id,
            job_id=job_id,
            status="duplicated",
            exclusion_type=exclusion_type,
        )
    )
    await session.commit()
    return job_id


def _duplicates_tab_filter():
    return (
        (UserJobStatus.exclusion_type.is_(None))
        | (
            (UserJobStatus.exclusion_type != BELOW_MIN_SCORE_EXCLUSION)
            & (UserJobStatus.exclusion_type != EXTRACTION_FAILED_EXCLUSION)
        )
    )


async def _count_for_user(session, user_id: str, *, filter_clause) -> int:
    stmt = (
        select(func.count())
        .select_from(UserJobStatus)
        .where(
            UserJobStatus.user_id == user_id,
            UserJobStatus.status == "duplicated",
            filter_clause,
        )
    )
    return (await session.execute(stmt)).scalar_one()


@pytest.mark.asyncio
async def test_duplicates_tab_excludes_low_score_and_extraction_failed():
    async with get_session() as session:
        user_id = str(uuid.uuid4())
        session.add(User(id=user_id, email=f"{user_id}@test.example.com", password_hash="x"))
        await session.commit()

        strict_id = await _seed_hidden_job(
            session, user_id=user_id, exclusion_type=STRICT_SIMILARITY_EXCLUSION
        )
        lower_id = await _seed_hidden_job(
            session, user_id=user_id, exclusion_type=LOWER_SCORE_EXCLUSION
        )
        low_score_id = await _seed_hidden_job(
            session, user_id=user_id, exclusion_type=BELOW_MIN_SCORE_EXCLUSION
        )
        failed_id = await _seed_hidden_job(
            session, user_id=user_id, exclusion_type=EXTRACTION_FAILED_EXCLUSION
        )

        dup_count = await _count_for_user(session, user_id, filter_clause=_duplicates_tab_filter())
        low_count = await _count_for_user(
            session,
            user_id,
            filter_clause=UserJobStatus.exclusion_type == BELOW_MIN_SCORE_EXCLUSION,
        )
        failed_count = await _count_for_user(
            session,
            user_id,
            filter_clause=UserJobStatus.exclusion_type == EXTRACTION_FAILED_EXCLUSION,
        )

        assert dup_count == 2
        assert low_count == 1
        assert failed_count == 1

        dup_rows = await session.execute(
            select(UserJobStatus.job_id).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "duplicated",
                _duplicates_tab_filter(),
            )
        )
        dup_job_ids = {row[0] for row in dup_rows.all()}
        assert dup_job_ids == {strict_id, lower_id}
        assert low_score_id not in dup_job_ids
        assert failed_id not in dup_job_ids
