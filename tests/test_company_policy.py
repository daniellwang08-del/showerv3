"""Tests for company-level dedupe after match analysis (enforce_company_priority_after_match)."""

import uuid

import pytest
from sqlalchemy import select

from app.models.database import InvalidJob, JobMatchResult, User, ValidJob, ValidJobUserApplication
from app.services.company_policy import enforce_company_priority_after_match
from app.storage.database import close_database, get_session, init_database


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _seed_user(session) -> str:
    uid = str(uuid.uuid4())
    session.add(
        User(
            id=uid,
            email=f"{uid}@test.example.com",
            password_hash="x",
        )
    )
    await session.commit()
    return uid


def _vj(company: str, url: str) -> ValidJob:
    return ValidJob(
        id=str(uuid.uuid4()),
        source_url=url,
        normalized_url=url,
        domain="example.com",
        title="Engineer",
        company=company,
        description="Desc",
    )


async def _add_match(session, valid_job_id: str, user_id: str, score: int) -> None:
    session.add(
        JobMatchResult(
            valid_job_id=valid_job_id,
            user_id=user_id,
            overall_score=score,
            dimension_scores={
                "role_fit": score,
                "skills_match": score,
                "experience_level": score,
                "education_certifications": score,
                "location_work_style": score,
            },
            summary="s",
            strengths=[],
            gaps=[],
            recommendation="moderate_match",
        )
    )


@pytest.mark.asyncio
async def test_new_higher_score_demotes_previous():
    async with get_session() as session:
        user_id = await _seed_user(session)

        old = _vj("Acme Corp", f"https://ex.com/{uuid.uuid4()}")
        new = _vj("Acme Corp", f"https://ex.com/{uuid.uuid4()}")
        session.add(old)
        session.add(new)
        await session.flush()

        await _add_match(session, old.id, user_id, 50)
        await session.commit()

        async with get_session() as s2:
            await enforce_company_priority_after_match(
                s2, new.id, user_id=user_id, new_match_score=80, company_name="Acme Corp"
            )

    async with get_session() as s3:
        o = (await s3.execute(select(ValidJob).where(ValidJob.id == old.id))).scalar_one()
        n = (await s3.execute(select(ValidJob).where(ValidJob.id == new.id))).scalar_one()
        assert o.is_active is False
        assert n.is_active is True
        inv = (
            await s3.execute(select(InvalidJob).where(InvalidJob.duplicate_of_job_id == new.id))
        ).scalars().first()
        assert inv is not None
        assert inv.duplicate_of_job_id == new.id


@pytest.mark.asyncio
async def test_new_lower_score_demotes_new():
    async with get_session() as session:
        user_id = await _seed_user(session)

        old = _vj("Beta Inc", f"https://ex.com/{uuid.uuid4()}")
        new = _vj("Beta Inc", f"https://ex.com/{uuid.uuid4()}")
        session.add(old)
        session.add(new)
        await session.flush()

        await _add_match(session, old.id, user_id, 80)
        await session.commit()

        async with get_session() as s2:
            await enforce_company_priority_after_match(
                s2, new.id, user_id=user_id, new_match_score=50, company_name="Beta Inc"
            )

    async with get_session() as s3:
        o = (await s3.execute(select(ValidJob).where(ValidJob.id == old.id))).scalar_one()
        n = (await s3.execute(select(ValidJob).where(ValidJob.id == new.id))).scalar_one()
        assert o.is_active is True
        assert n.is_active is False


@pytest.mark.asyncio
async def test_applied_previous_demotes_new():
    async with get_session() as session:
        user_id = await _seed_user(session)

        old = _vj("Gamma LLC", f"https://ex.com/{uuid.uuid4()}")
        new = _vj("Gamma LLC", f"https://ex.com/{uuid.uuid4()}")
        session.add(old)
        session.add(new)
        await session.flush()

        await _add_match(session, old.id, user_id, 40)
        session.add(
            ValidJobUserApplication(
                id=str(uuid.uuid4()),
                user_id=user_id,
                valid_job_id=old.id,
                applied_by_name="Me",
            )
        )
        await session.commit()

        async with get_session() as s2:
            await enforce_company_priority_after_match(
                s2, new.id, user_id=user_id, new_match_score=99, company_name="Gamma LLC"
            )

    async with get_session() as s3:
        n = (await s3.execute(select(ValidJob).where(ValidJob.id == new.id))).scalar_one()
        assert n.is_active is False


@pytest.mark.asyncio
async def test_no_prior_match_scores_demotes_older_same_company():
    async with get_session() as session:
        user_id = await _seed_user(session)

        old = _vj("Delta Co", f"https://ex.com/{uuid.uuid4()}")
        new = _vj("Delta Co", f"https://ex.com/{uuid.uuid4()}")
        session.add(old)
        session.add(new)
        await session.flush()
        await session.commit()

        async with get_session() as s2:
            await enforce_company_priority_after_match(
                s2, new.id, user_id=user_id, new_match_score=72, company_name="Delta Co"
            )

    async with get_session() as s3:
        o = (await s3.execute(select(ValidJob).where(ValidJob.id == old.id))).scalar_one()
        n = (await s3.execute(select(ValidJob).where(ValidJob.id == new.id))).scalar_one()
        assert o.is_active is False
        assert n.is_active is True
