"""Bridge scraped jobs into the extraction lifecycle.

Once a Scrapy spider finishes, every row it wrote to ``scraped_jobs`` should
flow through the same extraction + structuring pipeline as a manually
submitted URL.  This module is that bridge.

Design highlights
-----------------
* **Lives inside the async scraper worker** (``app.tasks.worker.run_scraper_task``)
  so it has direct access to the async DB, arq pool, and websocket publisher.
* **Idempotent.** Each ``scraped_jobs`` row is stamped with the resulting
  ``promoted_extraction_id`` after it's been promoted.  Re-running the
  promoter is safe - already-promoted rows are skipped.
* **Reuses existing components.** ``JobExtractionRepository``, ``Job``,
  ``URLManager``, ``enqueue_extraction`` - exactly the same plumbing the
  manual submit flow uses.  No duplicated extraction pipeline.
* **Prefers the real ATS URL.**  For aggregators (Jobright, etc.) the spider
  writes the real posting URL into ``origin_url``; we promote that, not the
  aggregator URL, so the upgraded JD engine works on the canonical page.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import JobExtraction, Job, UserJobStatus
from app.services.url_manager import URLManager
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, UserJobStatusRepository
from app.utils.text_sanitizer import sanitize_for_postgres_text

logger = get_logger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _coerce_tags(value: Any) -> list:
    """scraped_jobs.tags is stored as JSON-encoded TEXT (see JSONType)."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _pick_target_url(row: dict) -> str | None:
    """Pick the canonical URL to feed into the extraction engine."""
    origin = (row.get("origin_url") or "").strip()
    if origin and origin.startswith(("http://", "https://")):
        return origin
    primary = (row.get("url") or "").strip()
    return primary or None


def pick_target_url(row: dict) -> str | None:
    """Public alias of ``_pick_target_url`` for reuse by API routes."""
    return _pick_target_url(row)


async def enqueue_extraction_for_url(
    extraction_id: str,
    target_url: str,
    user_id: str | None = None,
) -> bool:
    """Public alias of ``_enqueue_extraction`` for reuse by API routes.

    Pass *user_id* to trigger the full lifecycle (extraction → LLM analysis →
    resume tailoring) instead of extraction-only.
    """
    return await _enqueue_extraction(extraction_id, target_url, user_id=user_id)


async def _enqueue_extraction(
    extraction_id: str,
    target_url: str,
    user_id: str | None = None,
) -> bool:
    """Enqueue arq extract_job. Returns True on success, False on failure.

    When *user_id* is provided the extraction worker will automatically chain
    ``analyze_job_match`` (Phase A: match + structured job) and, after that,
    ``generate_tailored_content`` (Phase B) + ``build_resume_task`` (DOCX/PDF).
    """
    try:
        from app.tasks.worker import get_extraction_pool, EXTRACTION_QUEUE
        pool = await get_extraction_pool()
        await pool.enqueue_job("extract_job", extraction_id, target_url, user_id)
        logger.info(
            "scrape_promoter_enqueued",
            extraction_id=extraction_id,
            target_url=target_url,
            user_id=user_id,
            queue=EXTRACTION_QUEUE,
        )
        return True
    except Exception as e:
        logger.warning(
            "scrape_promoter_enqueue_failed",
            extraction_id=extraction_id,
            target_url=target_url,
            user_id=user_id,
            error=str(e),
        )
        return False


def _is_blocked_domain(domain: str) -> str | None:
    """Lazy import of BLOCKED_DOMAINS to avoid circular import with routes."""
    try:
        from app.api.routes import _check_domain_blocked  # type: ignore
        return _check_domain_blocked(domain)
    except Exception:
        return None


async def _find_existing_valid_job(
    session: AsyncSession, *, source_url: str
) -> Job | None:
    """Return an active Job with the same source_url, if any."""
    result = await session.execute(
        select(Job)
        .where(
            Job.source_url == source_url,
            Job.status == "active",
        )
        .order_by(Job.created_at.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _stamp_promoted(
    session: AsyncSession, scraped_job_id: str, extraction_id: str
) -> None:
    await session.execute(
        text(
            "UPDATE scraped_jobs "
            "SET promoted_extraction_id = :eid, promoted_at = :now "
            "WHERE id = :sid"
        ),
        {"eid": extraction_id, "now": _utcnow(), "sid": scraped_job_id},
    )


async def promote_scrape_run(scrape_run_id: str, user_id: str | None = None) -> dict:
    """Promote every un-promoted ``scraped_jobs`` row from this run into a
    JobExtraction + Job and enqueue the extraction worker.

    Pass *user_id* so the extraction worker chains analyze + resume (full lifecycle).

    Returns a stats dict the worker can publish via WebSocket.
    """
    bind = {"scrape_run_id": scrape_run_id}
    logger.info("scrape_promoter_started", **bind)

    stats: dict[str, Any] = {
        "scrape_run_id": scrape_run_id,
        "total": 0,
        "new": 0,
        "linked_existing": 0,
        "blocked": 0,
        "skipped_invalid_url": 0,
        "failed": 0,
        "enqueued": 0,
    }

    async with get_session() as session:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT id, source, source_job_id, url, origin_url,
                           title, company_name, location, description,
                           posted_at, experience_level, salary_raw,
                           salary_min_cents, salary_max_cents,
                           salary_currency, salary_period, is_remote,
                           job_type, tags, scraped_at
                    FROM scraped_jobs
                    WHERE scrape_run_id = :rid
                      AND promoted_extraction_id IS NULL
                    """
                ),
                {"rid": scrape_run_id},
            )
        ).mappings().all()

    stats["total"] = len(rows)
    if not rows:
        logger.info("scrape_promoter_no_unpromoted_rows", **bind)
        return stats

    for row in rows:
        outcome = await _promote_single_scraped_row(
            row, scrape_run_id=scrape_run_id, enqueue=True, user_id=user_id
        )
        bucket = outcome.get("bucket") or "failed"
        if bucket in stats:
            stats[bucket] = stats[bucket] + 1
        if outcome.get("enqueued"):
            stats["enqueued"] += 1

    logger.info("scrape_promoter_completed", **stats)
    return stats


async def promote_single_scraped_row(
    row: dict,
    *,
    scrape_run_id: str | None = None,
    enqueue: bool = True,
    user_id: str | None = None,
) -> dict:
    """Public entry point - see :func:`_promote_single_scraped_row`."""
    return await _promote_single_scraped_row(
        row, scrape_run_id=scrape_run_id, enqueue=enqueue, user_id=user_id
    )


async def _promote_single_scraped_row(
    row: dict,
    *,
    scrape_run_id: str | None = None,
    enqueue: bool = True,
    user_id: str | None = None,
) -> dict:
    """Promote a single ``scraped_jobs`` mapping row into the extraction
    pipeline.  Returns a dict shaped:

        {
          "bucket": "new" | "linked_existing" | "blocked" | "skipped_invalid_url" | "failed",
          "extraction_id": str | None,
          "job_id": str | None,
          "target_url": str | None,
          "enqueued": bool,
          "error": str | None,
        }

    Safe to call repeatedly; idempotency is enforced upstream by the
    ``promoted_extraction_id`` stamp and by ``_find_existing_valid_job``.
    """
    scraped_job_id = row.get("id")
    result: dict = {
        "bucket": "failed",
        "extraction_id": None,
        "job_id": None,
        "target_url": None,
        "enqueued": False,
        "error": None,
    }

    target_url = _pick_target_url(row)
    result["target_url"] = target_url
    if not target_url:
        result["bucket"] = "skipped_invalid_url"
        result["error"] = "No usable URL (origin_url and url both empty)"
        return result

    is_valid, validation_error = URLManager.validate_url(target_url)
    if not is_valid:
        result["bucket"] = "skipped_invalid_url"
        result["error"] = validation_error or "URL failed validation"
        return result

    async with get_session() as session:
        try:
            domain = URLManager.extract_domain(target_url)
            block_reason = _is_blocked_domain(domain)
            if block_reason:
                result["bucket"] = "blocked"
                result["error"] = block_reason
                logger.info(
                    "scrape_promoter_blocked_domain",
                    scraped_job_id=scraped_job_id,
                    domain=domain, reason=block_reason,
                )
                return result

            existing = await _find_existing_valid_job(session, source_url=target_url)
            if existing and existing.extraction_id:
                if scraped_job_id:
                    await _stamp_promoted(session, scraped_job_id, existing.extraction_id)
                    await session.commit()
                result["bucket"] = "linked_existing"
                result["extraction_id"] = existing.extraction_id
                result["job_id"] = existing.id
                logger.info(
                    "scrape_promoter_linked_existing",
                    scraped_job_id=scraped_job_id,
                    job_id=existing.id,
                    extraction_id=existing.extraction_id,
                )
                if enqueue:
                    enqueued = await _enqueue_extraction(existing.extraction_id, target_url, user_id=user_id)
                    result["enqueued"] = enqueued
                return result

            title = (row.get("title") or "").strip()
            company = (row.get("company_name") or "Unknown").strip() or "Unknown"
            location = (row.get("location") or "").strip() or None
            description_snippet = sanitize_for_postgres_text(row.get("description") or None)
            posted_at = row.get("posted_at")
            experience_level = (row.get("experience_level") or "").strip() or None

            raw_metadata = {
                "scraped_source": row.get("source"),
                "scraped_source_job_id": row.get("source_job_id"),
                "scrape_run_id": scrape_run_id,
                "scraped_job_id": scraped_job_id,
                "aggregator_url": row.get("url"),
                "origin_url": row.get("origin_url"),
                "scraped_at": (
                    row.get("scraped_at").isoformat()
                    if row.get("scraped_at") else None
                ),
                "is_remote": bool(row.get("is_remote")),
                "job_type": row.get("job_type"),
                "tags": _coerce_tags(row.get("tags")),
                "salary": {
                    "raw": row.get("salary_raw"),
                    "min_cents": row.get("salary_min_cents"),
                    "max_cents": row.get("salary_max_cents"),
                    "currency": row.get("salary_currency"),
                    "period": row.get("salary_period"),
                },
                "scraped_company_name": company,
                "promoted_from_scraper": True,
            }

            new_job = Job(
                source_url=target_url,
                normalized_url=target_url,
                domain=domain,
                title=title or None,
                company=company,
                location=location,
                description=description_snippet,
                posted_date=posted_at,
                experience_level=experience_level,
                industry=None,
                raw_metadata=raw_metadata,
                scraped_at=_utcnow(),
                status="active",
            )
            session.add(new_job)
            await session.flush()

            if user_id:
                user_job_status = UserJobStatus(
                    user_id=user_id,
                    job_id=new_job.id,
                    status="active",
                )
                session.add(user_job_status)

            extraction_repo = JobExtractionRepository(session)
            extraction = await extraction_repo.create(
                source_url=target_url,
                normalized_url=target_url,
                domain=domain,
            )
            new_job.extraction_id = extraction.id

            if scraped_job_id:
                await _stamp_promoted(session, scraped_job_id, extraction.id)
            await session.commit()

            result["bucket"] = "new"
            result["extraction_id"] = extraction.id
            result["job_id"] = new_job.id

            logger.info(
                "scrape_promoter_created",
                scraped_job_id=scraped_job_id,
                job_id=new_job.id,
                extraction_id=extraction.id,
                target_url=target_url,
                source=row.get("source"),
            )

            if enqueue:
                enqueued = await _enqueue_extraction(extraction.id, target_url, user_id=user_id)
                result["enqueued"] = enqueued
            return result
        except Exception as e:
            await session.rollback()
            result["bucket"] = "failed"
            result["error"] = str(e)
            logger.exception(
                "scrape_promoter_row_failed",
                scraped_job_id=scraped_job_id,
                error=str(e),
            )
            return result
