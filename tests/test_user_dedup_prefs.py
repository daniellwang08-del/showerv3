"""Tests for per-user dedup rule preferences and reconcile."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.models.database import Job, JobMatchResult, User, UserJobStatus, ValidJobUserApplication
from app.services.dedup_rules_reconcile import (
    preview_dedup_rules_for_user,
    reconcile_dedup_rules_for_user,
)
from app.services.job_exclusion_types import (
    APPLIED_COMPANY_EXCLUSION,
    LOCATION_UNKNOWN_EXCLUSION,
    LOWER_SCORE_EXCLUSION,
)
from app.services.post_analysis_dedup import run_post_analysis_dedup
from app.storage.database import close_database, get_session, init_database
from app.storage.user_repository import UserRepository


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _seed_user(session, **kwargs) -> str:
    uid = str(uuid.uuid4())
    session.add(
        User(
            id=uid,
            email=f"{uid}@test.example.com",
            password_hash="x",
            **kwargs,
        )
    )
    await session.commit()
    return uid


async def _add_job(
    session,
    *,
    user_id: str,
    url: str,
    company: str,
    title: str,
    location: str | None = "Austin, TX",
    with_active_ujs: bool = True,
    score: int | None = None,
) -> Job:
    job = Job(
        id=str(uuid.uuid4()),
        source_url=url,
        normalized_url=url,
        domain="example.com",
        title=title,
        company=company,
        location=location,
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
    if score is not None:
        session.add(
            JobMatchResult(
                id=str(uuid.uuid4()),
                job_id=job.id,
                user_id=user_id,
                overall_score=score,
                dimension_scores={"role_fit": score},
                summary="summary",
                strengths=[],
                gaps=[],
                recommendation="moderate_match",
            )
        )
    await session.commit()
    return job


def _match_data(score: int) -> dict:
    return {
        "overall_score": score,
        "dimension_scores": {"role_fit": score},
        "summary": "summary",
        "strengths": [],
        "gaps": [],
        "recommendation": "moderate_match",
    }


@pytest.mark.asyncio
async def test_effective_applied_company_default_vs_custom():
    settings = get_settings()
    original = settings.dedup_rule_applied_company_enabled
    settings.dedup_rule_applied_company_enabled = True
    try:
        async with get_session() as session:
            default_user = await _seed_user(session)
            custom_off = await _seed_user(
                session,
                dedup_applied_company_mode="custom",
                dedup_applied_company_enabled=False,
            )
            custom_on = await _seed_user(
                session,
                dedup_applied_company_mode="custom",
                dedup_applied_company_enabled=True,
            )
            repo = UserRepository(session)
            assert await repo.get_effective_dedup_applied_company_enabled(default_user) is True
            assert await repo.get_effective_dedup_applied_company_enabled(custom_off) is False
            assert await repo.get_effective_dedup_applied_company_enabled(custom_on) is True
    finally:
        settings.dedup_rule_applied_company_enabled = original


@pytest.mark.asyncio
async def test_effective_score_comparison_default_vs_custom():
    settings = get_settings()
    original = settings.dedup_rule_score_comparison_enabled
    settings.dedup_rule_score_comparison_enabled = False
    try:
        async with get_session() as session:
            default_user = await _seed_user(session)
            custom_on = await _seed_user(
                session,
                dedup_score_comparison_mode="custom",
                dedup_score_comparison_enabled=True,
            )
            repo = UserRepository(session)
            assert await repo.get_effective_dedup_score_comparison_enabled(default_user) is False
            assert await repo.get_effective_dedup_score_comparison_enabled(custom_on) is True
    finally:
        settings.dedup_rule_score_comparison_enabled = original


@pytest.mark.asyncio
async def test_score_comparison_respects_per_user_custom_off():
    settings = get_settings()
    original = settings.dedup_rule_score_comparison_enabled
    settings.dedup_rule_score_comparison_enabled = True
    try:
        async with get_session() as session:
            user_id = await _seed_user(
                session,
                dedup_score_comparison_mode="custom",
                dedup_score_comparison_enabled=False,
            )
            first = await _add_job(
                session,
                user_id=user_id,
                url=f"https://example.com/a/{uuid.uuid4()}",
                company="Acme",
                title="Senior Engineer",
                score=90,
            )
            second = await _add_job(
                session,
                user_id=user_id,
                url=f"https://example.com/b/{uuid.uuid4()}",
                company="Acme",
                title="Staff Engineer",
            )
            second_id = second.id
            _ = first

        result = await run_post_analysis_dedup(
            second_id,
            user_id,
            _match_data(70),
            extraction_id=None,
        )
        assert result["action"] == "saved_active"
    finally:
        settings.dedup_rule_score_comparison_enabled = original


@pytest.mark.asyncio
async def test_reconcile_restores_applied_company_when_disabled():
    async with get_session() as session:
        user_id = await _seed_user(session)
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/r/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            with_active_ujs=False,
        )
        session.add(
            UserJobStatus(
                id=str(uuid.uuid4()),
                user_id=user_id,
                job_id=job.id,
                status="duplicated",
                exclusion_type=APPLIED_COMPANY_EXCLUSION,
                reason="applied",
            )
        )
        await session.commit()

    preview = await preview_dedup_rules_for_user(
        user_id,
        applied_company_enabled=False,
        score_comparison_enabled=False,
    )
    assert preview["would_restore_count"] == 1

    result = await reconcile_dedup_rules_for_user(
        user_id,
        applied_company_enabled=False,
        score_comparison_enabled=False,
    )
    assert result["restored"] == 1

    async with get_session() as session:
        ujs = (
            await session.execute(
                select(UserJobStatus).where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.job_id == job.id,
                )
            )
        ).scalar_one()
        assert ujs.status == "active"
        assert ujs.exclusion_type is None


@pytest.mark.asyncio
async def test_reconcile_hides_lower_score_when_enabled():
    async with get_session() as session:
        user_id = await _seed_user(session)
        high = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/hi/{uuid.uuid4()}",
            company="Acme",
            title="Senior",
            score=95,
        )
        low = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/lo/{uuid.uuid4()}",
            company="Acme",
            title="Junior",
            score=60,
        )
        high_id, low_id = high.id, low.id

    preview = await preview_dedup_rules_for_user(
        user_id,
        applied_company_enabled=False,
        score_comparison_enabled=True,
    )
    assert preview["would_hide_score_comparison_count"] == 1

    result = await reconcile_dedup_rules_for_user(
        user_id,
        applied_company_enabled=False,
        score_comparison_enabled=True,
    )
    assert result["hidden_score_comparison"] == 1

    async with get_session() as session:
        low_ujs = (
            await session.execute(
                select(UserJobStatus).where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.job_id == low_id,
                )
            )
        ).scalar_one()
        high_ujs = (
            await session.execute(
                select(UserJobStatus).where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.job_id == high_id,
                )
            )
        ).scalar_one()
        assert low_ujs.status == "duplicated"
        assert low_ujs.exclusion_type == LOWER_SCORE_EXCLUSION
        assert high_ujs.status == "active"


@pytest.mark.asyncio
async def test_reconcile_restores_location_unknown():
    async with get_session() as session:
        user_id = await _seed_user(session)
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/unk/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Remote",
            with_active_ujs=False,
        )
        session.add(
            UserJobStatus(
                id=str(uuid.uuid4()),
                user_id=user_id,
                job_id=job.id,
                status="duplicated",
                exclusion_type=LOCATION_UNKNOWN_EXCLUSION,
                reason="unknown",
            )
        )
        await session.commit()
        job_id = job.id

    result = await reconcile_dedup_rules_for_user(
        user_id,
        applied_company_enabled=False,
        score_comparison_enabled=False,
    )
    assert result["restored_location_unknown"] == 1

    async with get_session() as session:
        ujs = (
            await session.execute(
                select(UserJobStatus).where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.job_id == job_id,
                )
            )
        ).scalar_one()
        assert ujs.status == "active"


@pytest.mark.asyncio
async def test_reconcile_hides_applied_company_when_enabled():
    async with get_session() as session:
        user_id = await _seed_user(session)
        applied_job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/app/{uuid.uuid4()}",
            company="Acme",
            title="Applied Role",
            score=80,
        )
        peer = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/peer/{uuid.uuid4()}",
            company="Acme",
            title="Other Role",
            score=70,
        )
        session.add(
            ValidJobUserApplication(
                id=str(uuid.uuid4()),
                user_id=user_id,
                job_id=applied_job.id,
                applied_by_name="Test User",
            )
        )
        await session.commit()
        peer_id = peer.id

    preview = await preview_dedup_rules_for_user(
        user_id,
        applied_company_enabled=True,
        score_comparison_enabled=False,
    )
    assert preview["would_hide_applied_company_count"] == 1

    result = await reconcile_dedup_rules_for_user(
        user_id,
        applied_company_enabled=True,
        score_comparison_enabled=False,
    )
    assert result["hidden_applied_company"] == 1

    async with get_session() as session:
        peer_ujs = (
            await session.execute(
                select(UserJobStatus).where(
                    UserJobStatus.user_id == user_id,
                    UserJobStatus.job_id == peer_id,
                )
            )
        ).scalar_one()
        assert peer_ujs.status == "duplicated"
        assert peer_ujs.exclusion_type == APPLIED_COMPANY_EXCLUSION
