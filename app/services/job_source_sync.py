"""Sync per-user job sources: pull board listings into the user's pipeline.

For each registered source the board's public API is fetched once; new
posting URLs become Jobs (deduped on normalized_url, blocked domains
skipped) and flow through the normal extraction → analysis pipeline with
the user's manual-submit depth preference.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.logging import get_logger
from app.models.database import Job, User, UserJobSource
from app.models.schemas import ExtractionStatus
from app.services import blocked_domains_service
from app.services.job_pipeline_mode import (
    manual_submit_enqueue_flags,
    normalize_manual_submit_pipeline,
)
from app.services.job_source_boards import BoardJob, fetch_board_listing
from app.services.signup_approval_service import can_use_app
from app.services.url_manager import URLManager
from app.storage.database import get_session
from app.storage.repository import (
    JobExtractionRepository,
    JobMatchRepository,
    UserJobStatusRepository,
)

logger = get_logger(__name__)

# Never flood a user's pipeline: cap new jobs created per source per sync.
MAX_NEW_JOBS_PER_SYNC = 30
# A source is due when its last sync is older than this.
SYNC_INTERVAL_HOURS = 6
# Hard cap on sources per user (API enforces on create).
MAX_SOURCES_PER_USER = 10


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _enqueue_extract(
    extraction_id: str,
    url: str,
    user_id: str,
    *,
    chain_analysis: bool,
    skip_phase_b: bool,
) -> bool:
    try:
        from app.core.redis_support import pipeline_job_id
        from app.tasks.worker import get_extraction_pool

        pool = await get_extraction_pool()
        await pool.enqueue_job(
            "extract_job",
            extraction_id,
            url,
            user_id,
            bool(skip_phase_b),
            bool(chain_analysis),
            _job_id=pipeline_job_id("extract", extraction_id),
        )
        return True
    except Exception as e:
        logger.warning(
            "job_source_extract_enqueue_failed",
            extraction_id=extraction_id,
            url=url,
            error=str(e),
        )
        return False


async def _enqueue_analysis(job_id: str, user_id: str, extraction_id: str | None,
                            *, skip_phase_b: bool) -> bool:
    try:
        from app.core.redis_support import pipeline_job_id
        from app.tasks.worker import get_analysis_pool

        pool = await get_analysis_pool()
        await pool.enqueue_job(
            "analyze_job_match",
            job_id,
            user_id,
            extraction_id,
            bool(skip_phase_b),
            _job_id=pipeline_job_id("analyze", job_id, user_id),
        )
        return True
    except Exception as e:
        logger.warning(
            "job_source_analysis_enqueue_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(e),
        )
        return False


async def _process_listing_job(
    board_job: BoardJob,
    *,
    user_id: str,
    scraped_source: str,
    company_fallback: str,
    extra_meta: dict,
    chain_analysis: bool,
    skip_phase_b: bool,
) -> str:
    """Returns 'created' | 'linked' | 'skipped'."""
    url = board_job.url.strip()
    is_valid, _validation_error = URLManager.validate_url(url)
    if not is_valid:
        return "skipped"
    domain = URLManager.extract_domain(url)
    if blocked_domains_service.get_blocked_reason(domain):
        return "skipped"
    norm = URLManager.normalize_url(url)

    async with get_session() as session:
        existing = (
            await session.execute(
                select(Job).where(
                    Job.normalized_url.in_({url, norm}),
                    Job.status == "active",
                )
                .order_by(Job.created_at.asc())
                .limit(1)
            )
        ).scalar_one_or_none()

        ujs_repo = UserJobStatusRepository(session)
        if existing is not None:
            current = await ujs_repo.get(user_id, existing.id)
            if current is not None:
                # Already visible/excluded for this user, never resurrect.
                return "skipped"
            await ujs_repo.upsert(user_id=user_id, job_id=existing.id, status="active")

            needs_analysis = False
            extraction_id = existing.extraction_id
            if chain_analysis and extraction_id:
                extraction = await JobExtractionRepository(session).get_by_id(extraction_id)
                extracted = extraction is not None and extraction.status in (
                    ExtractionStatus.EXTRACTED,
                    ExtractionStatus.COMPLETED,
                )
                if extracted:
                    match = await JobMatchRepository(session).get(existing.id, user_id)
                    needs_analysis = match is None
            job_id = existing.id
            await session.commit()
            if needs_analysis:
                await _enqueue_analysis(
                    job_id, user_id, extraction_id, skip_phase_b=skip_phase_b
                )
            return "linked"

        # New job for the platform: create Job + extraction + visibility row.
        extraction = await JobExtractionRepository(session).create(
            source_url=url,
            normalized_url=norm,
            domain=domain,
        )
        job = Job(
            source_url=url,
            normalized_url=norm,
            domain=domain,
            title=board_job.title or None,
            company=board_job.company or company_fallback or domain,
            location=board_job.location or None,
            extraction_id=extraction.id,
            status="active",
            raw_metadata={
                "scraped_source": scraped_source,
                **extra_meta,
                **({"source_listing_url": board_job.source_url} if board_job.source_url else {}),
            },
        )
        session.add(job)
        await session.flush()
        await ujs_repo.upsert(user_id=user_id, job_id=job.id, status="active")
        extraction_id = extraction.id
        await session.commit()

    await _enqueue_extract(
        extraction_id,
        url,
        user_id,
        chain_analysis=chain_analysis,
        skip_phase_b=skip_phase_b,
    )
    return "created"


async def ingest_board_jobs(
    jobs: list[BoardJob],
    *,
    user_id: str,
    scraped_source: str,
    company_fallback: str,
    extra_meta: dict,
    chain_analysis: bool,
    skip_phase_b: bool,
    max_new: int = MAX_NEW_JOBS_PER_SYNC,
) -> dict[str, int]:
    """Feed discovered listing URLs through create/link/skip. Caps new jobs."""
    created = linked = skipped = 0
    for board_job in jobs:
        if created >= max_new:
            break
        try:
            outcome = await _process_listing_job(
                board_job,
                user_id=user_id,
                scraped_source=scraped_source,
                company_fallback=company_fallback,
                extra_meta=extra_meta,
                chain_analysis=chain_analysis,
                skip_phase_b=skip_phase_b,
            )
        except Exception as e:
            logger.warning(
                "job_listing_ingest_failed",
                scraped_source=scraped_source,
                url=board_job.url,
                error=str(e),
            )
            outcome = "skipped"
        if outcome == "created":
            created += 1
        elif outcome == "linked":
            linked += 1
        else:
            skipped += 1
    return {"created": created, "linked": linked, "skipped": skipped}


async def sync_user_job_source(source_id: str) -> dict:
    """Sync one source. Always records the outcome on the source row."""
    async with get_session() as session:
        source = (
            await session.execute(
                select(UserJobSource).where(UserJobSource.id == source_id)
            )
        ).scalar_one_or_none()
        if source is None:
            return {"source_id": source_id, "status": "missing"}
        user = (
            await session.execute(select(User).where(User.id == source.user_id))
        ).scalar_one_or_none()
        if not can_use_app(user):
            return {"source_id": source_id, "status": "user_inactive"}
        pipeline = normalize_manual_submit_pipeline(
            getattr(user, "manual_submit_pipeline", None)
        )
        user_id = source.user_id
        ats_type = source.ats_type
        token = source.board_token

    _uid, chain_analysis, skip_phase_b = manual_submit_enqueue_flags(
        pipeline, is_admin=False, user_id=user_id
    )

    try:
        listing = await fetch_board_listing(ats_type, token)
    except Exception as e:
        error_text = f"{type(e).__name__}: {e}"[:500]
        async with get_session() as session:
            row = (
                await session.execute(
                    select(UserJobSource).where(UserJobSource.id == source_id)
                )
            ).scalar_one_or_none()
            if row is not None:
                row.last_synced_at = _now()
                row.last_error = error_text
        logger.warning(
            "job_source_sync_fetch_failed",
            source_id=source_id,
            ats_type=ats_type,
            token=token,
            error=error_text,
        )
        return {"source_id": source_id, "status": "fetch_failed", "error": error_text}

    counts = await ingest_board_jobs(
        listing.jobs,
        user_id=user_id,
        scraped_source="user_site",
        company_fallback=listing.company or token,
        extra_meta={
            "user_job_source": {
                "source_id": source_id,
                "user_id": user_id,
                "ats_type": ats_type,
            },
        },
        chain_analysis=chain_analysis,
        skip_phase_b=skip_phase_b,
    )
    created = counts["created"]
    linked = counts["linked"]
    skipped = counts["skipped"]

    async with get_session() as session:
        row = (
            await session.execute(
                select(UserJobSource).where(UserJobSource.id == source_id)
            )
        ).scalar_one_or_none()
        if row is not None:
            row.last_synced_at = _now()
            row.last_error = None
            row.last_listing_count = len(listing.jobs)
            row.last_new_jobs = created

    logger.info(
        "job_source_synced",
        source_id=source_id,
        ats_type=ats_type,
        token=token,
        listings=len(listing.jobs),
        created=created,
        linked=linked,
        skipped=skipped,
    )
    return {
        "source_id": source_id,
        "status": "synced",
        "listings": len(listing.jobs),
        "created": created,
        "linked": linked,
        "skipped": skipped,
    }


async def sync_due_job_sources() -> dict:
    """Sync every enabled source whose last sync is older than the interval."""
    cutoff = _now() - timedelta(hours=SYNC_INTERVAL_HOURS)
    async with get_session() as session:
        rows = await session.execute(
            select(UserJobSource.id).where(
                UserJobSource.enabled.is_(True),
                (UserJobSource.last_synced_at.is_(None))
                | (UserJobSource.last_synced_at < cutoff),
            )
        )
        due_ids = [row[0] for row in rows.all()]

    results = {"due": len(due_ids), "synced": 0, "failed": 0}
    for source_id in due_ids:
        try:
            outcome = await sync_user_job_source(source_id)
            if outcome.get("status") == "synced":
                results["synced"] += 1
            else:
                results["failed"] += 1
        except Exception as e:
            results["failed"] += 1
            logger.warning(
                "job_source_sync_failed", source_id=source_id, error=str(e)
            )
    if due_ids:
        logger.info("job_sources_sync_pass_complete", **results)
    return results
