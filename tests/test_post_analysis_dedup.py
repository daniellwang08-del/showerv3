"""Tests for post-analysis deduplication engine."""

import uuid

import pytest
from sqlalchemy import select

from app.models.database import Job, JobMatchResult, User, UserJobStatus
from app.services.job_exclusion_types import (
    BELOW_MIN_SCORE_EXCLUSION,
    LOWER_SCORE_EXCLUSION,
    SAME_URL_EXCLUSION,
    STRICT_SIMILARITY_EXCLUSION,
)
from app.services.post_analysis_dedup import run_post_analysis_dedup
from app.storage.database import close_database, get_session, init_database


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _seed_user(session) -> str:
    uid = str(uuid.uuid4())
    session.add(User(id=uid, email=f"{uid}@test.example.com", password_hash="x"))
    await session.commit()
    return uid


def _match_data(score: int) -> dict:
    return {
        "overall_score": score,
        "dimension_scores": {"role_fit": score},
        "summary": "summary",
        "strengths": [],
        "gaps": [],
        "recommendation": "moderate_match",
    }


async def _add_job(
    session,
    *,
    user_id: str,
    url: str,
    company: str,
    title: str,
    with_active_ujs: bool = True,
) -> Job:
    job = Job(
        id=str(uuid.uuid4()),
        source_url=url,
        normalized_url=url,
        domain="example.com",
        title=title,
        company=company,
        status="active",
    )
    session.add(job)
    await session.flush()
    if with_active_ujs:
        session.add(
            UserJobStatus(
                id=str(uuid.uuid4()),
                user_id=user_id,
                job_id=job.id,
                status="active",
            )
        )
    await session.commit()
    return job


async def _add_match(session, job_id: str, user_id: str, score: int) -> None:
    session.add(
        JobMatchResult(
            id=str(uuid.uuid4()),
            job_id=job_id,
            user_id=user_id,
            overall_score=score,
            dimension_scores={"role_fit": score},
            summary="s",
            strengths=[],
            gaps=[],
            recommendation="moderate_match",
        )
    )
    await session.commit()


@pytest.mark.asyncio
async def test_same_url_duplicate_is_hidden_in_duplicates_tab():
    url = f"https://boards.example.com/jobs/{uuid.uuid4()}"
    async with get_session() as session:
        user_id = await _seed_user(session)
        existing = await _add_job(
            session,
            user_id=user_id,
            url=url,
            company="Acme Corp",
            title="Software Engineer",
        )
        incoming = await _add_job(
            session,
            user_id=user_id,
            url=url,
            company="Acme Corp",
            title="Software Engineer",
        )
        incoming_id = incoming.id
        existing_id = existing.id

    result = await run_post_analysis_dedup(
        incoming_id,
        user_id,
        _match_data(80),
        extraction_id=None,
    )
    assert result["action"] == "saved_duplicated"
    assert result["exclusion_type"] == SAME_URL_EXCLUSION

    async with get_session() as session:
        row = await session.execute(
            select(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == incoming_id,
            )
        )
        ujs = row.scalar_one()
        assert ujs.status == "duplicated"
        assert ujs.exclusion_type == SAME_URL_EXCLUSION
        assert ujs.duplicated_because_id == existing_id


@pytest.mark.asyncio
async def test_strict_similarity_marks_second_job_duplicated():
    async with get_session() as session:
        user_id = await _seed_user(session)
        first = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/a/{uuid.uuid4()}",
            company="Acme Corp",
            title="Software Engineer",
        )
        second = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/b/{uuid.uuid4()}",
            company="Acme Corp",
            title="Software Engineer",
        )
        await _add_match(session, first.id, user_id, 70)
        first_id = first.id
        second_id = second.id

    result = await run_post_analysis_dedup(
        second_id,
        user_id,
        _match_data(68),
        extraction_id=None,
    )
    assert result["action"] == "saved_duplicated"
    assert result["exclusion_type"] == STRICT_SIMILARITY_EXCLUSION

    async with get_session() as session:
        row = await session.execute(
            select(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.job_id == first_id,
            )
        )
        assert row.scalar_one().status == "active"


@pytest.mark.asyncio
async def test_unknown_company_with_same_url_still_deduplicates():
    url = f"https://careers.example.com/posting/{uuid.uuid4()}"
    async with get_session() as session:
        user_id = await _seed_user(session)
        await _add_job(
            session,
            user_id=user_id,
            url=url,
            company="Unknown",
            title="Untitled",
        )
        incoming = await _add_job(
            session,
            user_id=user_id,
            url=url,
            company="Unknown",
            title="Untitled",
        )
        incoming_id = incoming.id

    result = await run_post_analysis_dedup(
        incoming_id,
        user_id,
        _match_data(55),
        extraction_id=None,
    )
    assert result["action"] == "saved_duplicated"
    assert result["exclusion_type"] == SAME_URL_EXCLUSION


@pytest.mark.asyncio
async def test_below_min_score_uses_low_score_exclusion():
    async with get_session() as session:
        user_id = await _seed_user(session)
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/{uuid.uuid4()}",
            company="Acme Corp",
            title="Engineer",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(40),
        extraction_id=None,
        min_match_score=50,
    )
    assert result["exclusion_type"] == BELOW_MIN_SCORE_EXCLUSION


@pytest.mark.asyncio
async def test_lower_score_duplicate_when_company_matches():
    async with get_session() as session:
        user_id = await _seed_user(session)
        first = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/a/{uuid.uuid4()}",
            company="Acme Corp",
            title="Backend Engineer",
        )
        second = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/b/{uuid.uuid4()}",
            company="Acme Corp",
            title="Frontend Engineer",
        )
        await _add_match(session, first.id, user_id, 80)
        second_id = second.id

    result = await run_post_analysis_dedup(
        second_id,
        user_id,
        _match_data(60),
        extraction_id=None,
    )
    assert result["action"] == "saved_duplicated"
    assert result["exclusion_type"] == LOWER_SCORE_EXCLUSION
