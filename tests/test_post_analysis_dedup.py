"""Tests for post-analysis deduplication engine."""

import uuid

import pytest
from sqlalchemy import select

from app.models.database import Job, JobMatchResult, User, UserJobStatus
from app.services.job_exclusion_types import (
    BELOW_MIN_SCORE_EXCLUSION,
    LOWER_SCORE_EXCLUSION,
    OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION,
    SAME_URL_EXCLUSION,
    STRICT_SIMILARITY_EXCLUSION,
)
from app.core.config import get_settings
from app.services.post_analysis_dedup import run_post_analysis_dedup
from app.storage.database import close_database, get_session, init_database


@pytest.fixture
def enable_all_dedup_rules():
    """Re-enable the optional dedup rules (disabled by default) for rule-logic tests.

    Applied-company / score-comparison still fall back to platform defaults when
    the user is on mode=default. Location-unknown is never excluded.
    """
    settings = get_settings()
    originals = {
        "dedup_rule_applied_company_enabled": settings.dedup_rule_applied_company_enabled,
        "dedup_rule_score_comparison_enabled": settings.dedup_rule_score_comparison_enabled,
    }
    settings.dedup_rule_applied_company_enabled = True
    settings.dedup_rule_score_comparison_enabled = True
    yield
    for key, value in originals.items():
        setattr(settings, key, value)


@pytest.fixture(autouse=True)
async def setup_db():
    await init_database()
    yield
    await close_database()


async def _seed_user(session, *, countries: list[str] | None = None) -> str:
    """New users default to no country preferences (worldwide, no location
    filter). Location-rule tests seed explicit preferences."""
    uid = str(uuid.uuid4())
    session.add(
        User(
            id=uid,
            email=f"{uid}@test.example.com",
            password_hash="x",
            country_preferences=countries or [],
            country_preferences_source="manual" if countries else "unset",
        )
    )
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
    location: str | None = None,
    with_active_ujs: bool = True,
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
            location="San Francisco, CA",
        )
        incoming = await _add_job(
            session,
            user_id=user_id,
            url=url,
            company="Acme Corp",
            title="Software Engineer",
            location="San Francisco, CA",
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
            location="Austin, TX",
        )
        second = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/b/{uuid.uuid4()}",
            company="Acme Corp",
            title="Software Engineer",
            location="Austin, TX",
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
            location="Denver, CO",
        )
        incoming = await _add_job(
            session,
            user_id=user_id,
            url=url,
            company="Unknown",
            title="Untitled",
            location="Denver, CO",
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
        recycle_days=30,
        min_match_score=50,
    )
    assert result["exclusion_type"] == BELOW_MIN_SCORE_EXCLUSION


@pytest.mark.asyncio
async def test_zero_score_always_excluded_even_when_min_is_zero():
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
        _match_data(0),
        extraction_id=None,
        recycle_days=30,
        min_match_score=0,
    )
    assert result["action"] == "saved_duplicated"
    assert result["exclusion_type"] == BELOW_MIN_SCORE_EXCLUSION


@pytest.mark.asyncio
async def test_not_a_job_posting_excluded():
    from app.services.job_exclusion_types import NOT_A_JOB_POSTING_EXCLUSION

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

    payload = _match_data(0)
    payload["is_job_posting"] = False
    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        payload,
        extraction_id=None,
        recycle_days=30,
        min_match_score=0,
    )
    assert result["exclusion_type"] == NOT_A_JOB_POSTING_EXCLUSION


@pytest.mark.asyncio
async def test_lower_score_duplicate_when_company_matches(enable_all_dedup_rules):
    async with get_session() as session:
        user_id = await _seed_user(session)
        first = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/a/{uuid.uuid4()}",
            company="Acme Corp",
            title="Backend Engineer",
            location="Boston, MA",
        )
        second = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/b/{uuid.uuid4()}",
            company="Acme Corp",
            title="Frontend Engineer",
            location="Boston, MA",
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


@pytest.mark.asyncio
async def test_outside_preferred_countries_is_hidden():
    async with get_session() as session:
        user_id = await _seed_user(session, countries=["US"])
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/fr/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Paris, France",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(82),
        extraction_id=None,
    )
    assert result["action"] == "saved_duplicated"
    assert result["exclusion_type"] == OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION


@pytest.mark.asyncio
async def test_preferred_country_match_stays_active():
    """A user preferring France keeps a Paris job that a US user would lose."""
    async with get_session() as session:
        user_id = await _seed_user(session, countries=["FR"])
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/fr/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Paris, France",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(82),
        extraction_id=None,
    )
    assert result["action"] == "saved_active"


@pytest.mark.asyncio
async def test_no_country_preferences_disables_location_filter():
    """Empty preference list = worldwide: nothing is hidden by location."""
    async with get_session() as session:
        user_id = await _seed_user(session)
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/fr/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Paris, France",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(82),
        extraction_id=None,
    )
    assert result["action"] == "saved_active"


@pytest.mark.asyncio
async def test_unknown_location_is_kept_as_us(enable_all_dedup_rules):
    """Unknown/ambiguous locations stay visible even when platform toggles are on."""
    async with get_session() as session:
        user_id = await _seed_user(session, countries=["US"])
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/remote/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Remote",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(82),
        extraction_id=None,
    )
    assert result["action"] == "saved_active"


@pytest.mark.asyncio
async def test_us_location_passes_location_filter_before_dedup():
    async with get_session() as session:
        user_id = await _seed_user(session, countries=["US"])
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/us/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Austin, TX",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(82),
        extraction_id=None,
    )
    assert result["action"] == "saved_active"


@pytest.mark.asyncio
async def test_unknown_location_active_when_rule_disabled_by_default():
    async with get_session() as session:
        user_id = await _seed_user(session, countries=["US"])
        job = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/remote/{uuid.uuid4()}",
            company="Acme",
            title="Engineer",
            location="Remote",
        )
        job_id = job.id

    result = await run_post_analysis_dedup(
        job_id,
        user_id,
        _match_data(82),
        extraction_id=None,
    )
    assert result["action"] == "saved_active"


@pytest.mark.asyncio
async def test_lower_score_same_company_active_when_rule_disabled_by_default():
    async with get_session() as session:
        user_id = await _seed_user(session)
        first = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/a/{uuid.uuid4()}",
            company="Acme Corp",
            title="Backend Engineer",
            location="Boston, MA",
        )
        second = await _add_job(
            session,
            user_id=user_id,
            url=f"https://example.com/b/{uuid.uuid4()}",
            company="Acme Corp",
            title="Frontend Engineer",
            location="Boston, MA",
        )
        await _add_match(session, first.id, user_id, 80)
        second_id = second.id

    result = await run_post_analysis_dedup(
        second_id,
        user_id,
        _match_data(60),
        extraction_id=None,
    )
    assert result["action"] == "saved_active"
