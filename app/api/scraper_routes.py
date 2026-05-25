"""API routes for the scraper pipeline.

Provides endpoints for browsing scraped jobs, viewing stats, listing
available spiders, and triggering sync (spider runs) via arq.
"""

import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.storage.database import get_session
from app.core.logging import get_logger

logger = get_logger(__name__)

scraper_router = APIRouter(prefix="/scraper", tags=["scraper"])


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------

class ScrapedJobResponse(BaseModel):
    id: str
    source: str
    source_job_id: str
    url: str
    origin_url: Optional[str] = None
    title: str
    company_name: Optional[str] = None
    location: Optional[str] = None
    is_remote: bool = False

    @field_validator("is_remote", mode="before")
    @classmethod
    def _coerce_is_remote(cls, v):
        if v is None:
            return False
        return v

    salary_raw: Optional[str] = None
    salary_min_cents: Optional[int] = None
    salary_max_cents: Optional[int] = None
    salary_currency: Optional[str] = None
    salary_period: Optional[str] = None
    description: Optional[str] = None
    job_type: Optional[str] = None
    experience_level: Optional[str] = None
    tags: list | None = None

    @field_validator("tags", mode="before")
    @classmethod
    def _parse_tags(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        return v

    posted_at: Optional[datetime] = None
    scraped_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    promoted_extraction_id: Optional[str] = None
    promoted_at: Optional[datetime] = None

    # Processing pipeline status (joined from related tables)
    extraction_status: Optional[str] = None
    job_id: Optional[str] = None
    resume_build_status: Optional[str] = None
    content_generation_status: Optional[str] = None
    # AI match result for the current user (None when no analysis has run yet)
    match_score: Optional[int] = None
    match_in_progress: Optional[bool] = None
    is_excluded_for_user: Optional[bool] = None

    @field_validator("extraction_status", mode="before")
    @classmethod
    def _normalize_extraction_status(cls, v: object) -> object:
        # The PostgreSQL 'extractionstatus' ENUM was originally created with
        # uppercase labels (PENDING, PROCESSING, …).  Raw SQL via asyncpg
        # returns those uppercase strings verbatim, bypassing SQLAlchemy's
        # ORM-level enum coercion.  Normalise to lowercase here so that the
        # TypeScript frontend comparisons ('pending', 'extracted', …) work.
        if isinstance(v, str):
            return v.lower()
        return v


class ScrapedJobUpdateRequest(BaseModel):
    """Patch payload for editing a scraped job row.

    At least one of ``url`` / ``origin_url`` / ``title`` / ``company_name``
    / ``location`` must be present.  All fields are optional; only provided
    fields are updated.  ``url``/``origin_url`` must be valid http(s) URLs
    when supplied.
    """
    url: Optional[str] = None
    origin_url: Optional[str] = None
    title: Optional[str] = None
    company_name: Optional[str] = None
    location: Optional[str] = None


class RerunResponse(BaseModel):
    status: str
    scraped_job_id: str
    extraction_id: Optional[str] = None
    job_id: Optional[str] = None
    target_url: Optional[str] = None
    enqueued: bool = False
    message: str = ""


class DeleteResponse(BaseModel):
    status: str
    scraped_job_id: str
    message: str = ""


class ScraperAiSearchRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)


class ScraperAiSearchResponse(BaseModel):
    matching_jobs: list[dict]
    query: dict       # serialised ScraperJobSearchQuerySpec (rationale + filters)
    total_matching: int


class ScrapedJobsPage(BaseModel):
    items: list[ScrapedJobResponse]
    total: int
    page: int
    per_page: int
    pages: int


class SourceStats(BaseModel):
    source: str
    count: int
    latest_scraped: Optional[datetime] = None


class ScraperStatsResponse(BaseModel):
    total_jobs: int
    total_remote: int
    today_scraped: int = 0
    today_remote: int = 0
    today_posted: int = 0
    extracted_jobs: int = 0   # fully extracted (pipeline completed)
    ready_jobs: int = 0       # have structured output + tailored resume/cover letter
    sources: list[SourceStats]
    recent_runs: list[dict] = Field(default_factory=list)


class ScrapeRunResponse(BaseModel):
    id: str
    spider_name: str
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    items_scraped: int = 0
    items_new: int = 0
    items_updated: int = 0
    errors: int = 0
    status: str = "running"


class SyncRequest(BaseModel):
    spider_name: str = "all"


class SyncStatusResponse(BaseModel):
    status: str
    spider_name: Optional[str] = None
    message: str = ""


class SpiderInfo(BaseModel):
    name: str
    label: str
    requires_auth: bool = False
    auth_configured: bool = False
    auth_saved_at: Optional[str] = None
    auth_setup_command: Optional[str] = None


class AuthPlatformStatus(BaseModel):
    platform: str
    label: str
    exists: bool
    corrupt: bool = False
    saved_at: Optional[str] = None
    cookie_count: int = 0
    setup_command: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_current_user(request: Request):
    """Reuse the same cookie-based JWT auth as the main routes."""
    from app.api.routes import get_current_user
    return await get_current_user(request)


def _rerun_response_from_promote_outcome(
    job_id: str,
    outcome: dict,
) -> RerunResponse:
    """Map ``promote_single_scraped_row`` result to a :class:`RerunResponse`."""
    bucket = outcome.get("bucket")
    target_url = outcome.get("target_url")
    if bucket in ("new", "linked_existing"):
        enqueued = bool(outcome.get("enqueued"))
        if bucket == "new":
            message = (
                "Promoted and enqueued for full lifecycle."
                if enqueued
                else "Promoted but extraction queue unavailable."
            )
        else:
            message = (
                "Linked to existing job; re-enqueued for full lifecycle."
                if enqueued
                else "Linked to existing job but extraction queue unavailable."
            )
        return RerunResponse(
            status="enqueued" if enqueued else "enqueue_failed",
            scraped_job_id=job_id,
            extraction_id=outcome.get("extraction_id"),
            job_id=outcome.get("job_id"),
            target_url=target_url,
            enqueued=enqueued,
            message=message,
        )
    if bucket == "blocked":
        return RerunResponse(
            status="blocked",
            scraped_job_id=job_id,
            target_url=target_url,
            message=outcome.get("error") or "Domain is blocked",
        )
    if bucket == "skipped_invalid_url":
        return RerunResponse(
            status="invalid_url",
            scraped_job_id=job_id,
            target_url=target_url,
            message=outcome.get("error") or "Invalid URL",
        )
    return RerunResponse(
        status="failed",
        scraped_job_id=job_id,
        target_url=target_url,
        message=outcome.get("error") or "Promotion failed",
    )


async def _rerun_scraped_job_lifecycle(
    scraped: dict,
    *,
    user_id: str | None,
) -> RerunResponse:
    """Run the full extraction → analysis → resume lifecycle for one scraped row."""
    from sqlalchemy import text

    from app.models.database import JobExtraction
    from app.storage.repository import JobExtractionRepository
    from app.services.url_manager import URLManager
    from app.services.scrape_promoter import (
        pick_target_url,
        enqueue_extraction_for_url,
        promote_single_scraped_row,
    )

    job_id = str(scraped.get("id") or "")
    target_url = pick_target_url(scraped)
    if not target_url:
        return RerunResponse(
            status="invalid_url",
            scraped_job_id=job_id,
            message="Scraped job has no usable URL (origin_url and url are both empty)",
        )

    is_valid, validation_error = URLManager.validate_url(target_url)
    if not is_valid:
        return RerunResponse(
            status="invalid_url",
            scraped_job_id=job_id,
            target_url=target_url,
            message=f"Scraped URL is invalid: {validation_error or 'unknown error'}",
        )

    promoted_extraction_id = scraped.get("promoted_extraction_id")

    if not promoted_extraction_id:
        outcome = await promote_single_scraped_row(
            scraped, scrape_run_id=None, enqueue=True, user_id=user_id
        )
        return _rerun_response_from_promote_outcome(job_id, outcome)

    async with get_session() as session:
        extraction = await session.get(JobExtraction, promoted_extraction_id)
        if not extraction:
            await session.execute(
                text("UPDATE scraped_jobs SET promoted_extraction_id = NULL WHERE id = :id"),
                {"id": job_id},
            )
            await session.commit()
            outcome = await promote_single_scraped_row(
                scraped, scrape_run_id=None, enqueue=True, user_id=user_id
            )
            result = _rerun_response_from_promote_outcome(job_id, outcome)
            if result.status == "enqueued":
                result.message = (
                    "Stale promotion link cleared; re-promoted and enqueued for full lifecycle."
                )
            return result

        repo = JobExtractionRepository(session)
        domain = URLManager.extract_domain(target_url)
        await repo.reset_for_refresh(promoted_extraction_id, source_url=target_url, domain=domain)

        from app.services.extraction_cache import invalidate_extraction_cache

        await invalidate_extraction_cache(promoted_extraction_id)

        vj_row = (await session.execute(
            text(
                "UPDATE jobs "
                "SET source_url = :source_url, normalized_url = :normalized_url, domain = :d "
                "WHERE extraction_id = :eid "
                "RETURNING id"
            ),
            {
                "source_url": target_url,
                "normalized_url": target_url,
                "d": domain,
                "eid": promoted_extraction_id,
            },
        )).mappings().first()
        job_id: str | None = str(vj_row["id"]) if vj_row else None

        if user_id and job_id:
            await session.execute(
                text(
                    "DELETE FROM job_match_results "
                    "WHERE job_id = :vjid AND user_id = :uid"
                ),
                {"vjid": job_id, "uid": user_id},
            )
            await session.execute(
                text(
                    "DELETE FROM resume_build_results "
                    "WHERE job_id = :vjid AND user_id = :uid"
                ),
                {"vjid": job_id, "uid": user_id},
            )

        await session.commit()

    enqueued = await enqueue_extraction_for_url(
        promoted_extraction_id, target_url, user_id=user_id
    )
    return RerunResponse(
        status="enqueued" if enqueued else "enqueue_failed",
        scraped_job_id=job_id,
        extraction_id=promoted_extraction_id,
        job_id=job_id,
        target_url=target_url,
        enqueued=enqueued,
        message=(
            "Existing extraction reset and re-enqueued for full lifecycle."
            if enqueued
            else "Extraction reset but queue unavailable."
        ),
    )


def _raise_http_for_rerun_failure(result: RerunResponse) -> None:
    """Convert a failed lifecycle result into the HTTP error the single endpoint used."""
    if result.status in ("blocked", "invalid_url"):
        raise HTTPException(status_code=400, detail=result.message)
    if result.status == "enqueue_failed":
        raise HTTPException(status_code=503, detail=result.message)
    raise HTTPException(status_code=500, detail=result.message or "Rerun failed")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@scraper_router.get("/jobs", response_model=ScrapedJobsPage)
async def list_scraped_jobs(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    source: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    remote_only: bool = Query(False),
    sort: str = Query("scraped_at"),
    order: str = Query("desc"),
    user=Depends(_get_current_user),
):
    """Paginated list of scraped jobs with optional filters, including pipeline status."""
    from sqlalchemy import text

    async with get_session() as session:
        user_id = user.get("user_id", "")

        # Base SELECT: all scraped_jobs columns plus pipeline status fields.
        #
        # jobs resolution uses a two-step COALESCE subquery so we can
        # find the linked valid_job even when a job was originally processed via
        # the extraction page (promoted_extraction_id may be NULL) rather than
        # via the scraper rerun button:
        #
        #   1. Primary:  look up jobs by extraction_id == promoted_extraction_id
        #   2. Fallback: look up by normalized_url == COALESCE(origin_url, url)
        #
        # Each user_id bind parameter uses a unique name (rb_uid / jmr_uid /
        # jmip_uid) to avoid asyncpg mapping all three occurrences to the same
        # positional slot ($N), which can cause silent type-inference failures
        # on some PostgreSQL / asyncpg version combinations.
        #
        # CASE WHEN … END returns an explicit SQL BOOLEAN rather than relying
        # on asyncpg to infer the type of the IS NOT NULL expression.
        # When multiple scraped_jobs share the same promoted_extraction_id
        # they all point to the SAME processed job. Show only one row per
        # unique extraction to avoid confusing "duplicate" entries.
        dedup_filter = (
            "AND ("
            "  sj.promoted_extraction_id IS NULL "
            "  OR sj.id = ("
            "    SELECT sj2.id FROM scraped_jobs sj2 "
            "    WHERE sj2.promoted_extraction_id = sj.promoted_extraction_id "
            "    ORDER BY sj2.scraped_at DESC LIMIT 1"
            "  )"
            ") "
        )

        base = (
            "SELECT sj.*, "
            "LOWER(je.status::text) AS extraction_status, "
            "vj.id AS job_id, "
            "rb.resume_docx_status AS resume_build_status, "
            "rb.content_generation_status AS content_generation_status, "
            "jmr.overall_score AS match_score, "
            "CASE WHEN jmip.id IS NOT NULL THEN TRUE ELSE FALSE END AS match_in_progress, "
            "CASE WHEN ujs.id IS NOT NULL AND ujs.status != 'active' THEN TRUE ELSE FALSE END AS is_excluded_for_user "
            "FROM scraped_jobs sj "
            "LEFT JOIN job_extractions je ON je.id = sj.promoted_extraction_id "
            "LEFT JOIN jobs vj ON vj.id = COALESCE( "
            "  (SELECT v2.id FROM jobs v2 "
            "   WHERE v2.extraction_id = sj.promoted_extraction_id LIMIT 1), "
            "  (SELECT v2.id FROM jobs v2 "
            "   WHERE v2.normalized_url = COALESCE(sj.origin_url, sj.url) "
            "   AND v2.status = 'active' ORDER BY v2.updated_at DESC LIMIT 1) "
            ") "
            "LEFT JOIN resume_build_results rb "
            "  ON rb.job_id = vj.id AND rb.user_id = :rb_uid "
            "LEFT JOIN job_match_results jmr "
            "  ON jmr.job_id = vj.id AND jmr.user_id = :jmr_uid "
            "LEFT JOIN job_match_in_progress jmip "
            "  ON jmip.job_id = vj.id AND jmip.user_id = :jmip_uid "
            "LEFT JOIN user_job_status ujs "
            "  ON ujs.job_id = vj.id AND ujs.user_id = :ujs_uid "
            "WHERE (vj.id IS NULL OR ujs.id IS NULL OR ujs.status = 'active') "
            + dedup_filter
        )
        count_base = (
            "SELECT COUNT(*) FROM scraped_jobs sj "
            "LEFT JOIN jobs vj ON vj.id = COALESCE( "
            "  (SELECT v2.id FROM jobs v2 "
            "   WHERE v2.extraction_id = sj.promoted_extraction_id LIMIT 1), "
            "  (SELECT v2.id FROM jobs v2 "
            "   WHERE v2.normalized_url = COALESCE(sj.origin_url, sj.url) "
            "   AND v2.status = 'active' ORDER BY v2.updated_at DESC LIMIT 1) "
            ") "
            "LEFT JOIN user_job_status ujs "
            "  ON ujs.job_id = vj.id AND ujs.user_id = :ujs_uid "
            "WHERE (vj.id IS NULL OR ujs.id IS NULL OR ujs.status = 'active') "
            + dedup_filter
        )
        params: dict = {
            "rb_uid": user_id,
            "jmr_uid": user_id,
            "jmip_uid": user_id,
            "ujs_uid": user_id,
        }

        if source:
            base += " AND sj.source = :source"
            count_base += " AND sj.source = :source"
            params["source"] = source

        if remote_only:
            base += " AND sj.is_remote = true"
            count_base += " AND sj.is_remote = true"

        if q:
            base += " AND (sj.title ILIKE :q OR sj.company_name ILIKE :q OR sj.location ILIKE :q)"
            count_base += " AND (sj.title ILIKE :q OR sj.company_name ILIKE :q OR sj.location ILIKE :q)"
            params["q"] = f"%{q}%"

        count_result = await session.execute(text(count_base), params)
        total = count_result.scalar() or 0

        allowed_sort = {"scraped_at", "posted_at", "title", "company_name", "source", "updated_at"}
        sort_col = sort if sort in allowed_sort else "scraped_at"
        direction = "ASC" if order.lower() == "asc" else "DESC"
        base += f" ORDER BY sj.{sort_col} {direction} NULLS LAST"

        offset = (page - 1) * per_page
        base += " LIMIT :limit OFFSET :offset"
        params["limit"] = per_page
        params["offset"] = offset

        result = await session.execute(text(base), params)
        rows = result.mappings().all()

        items = [ScrapedJobResponse(**dict(row)) for row in rows]
        pages = max(1, (total + per_page - 1) // per_page)

        return ScrapedJobsPage(items=items, total=total, page=page, per_page=per_page, pages=pages)


@scraper_router.post("/jobs/ai-search", response_model=ScraperAiSearchResponse)
async def ai_search_scraped_jobs(
    body: ScraperAiSearchRequest,
    user=Depends(_get_current_user),
):
    """
    Natural language search over scraped jobs.

    Interprets the user's prompt with OpenAI into a structured filter spec
    (ScraperJobSearchQuerySpec) then applies it as parameterised SQL across:
      • scraped_jobs     – raw scraper output
      • jobs             – structured extraction content (linked via COALESCE)
      • job_extractions  – detailed responsibilities / requirements / salary
      • job_match_results – per-user AI match score & recommendation
      • resume_build_results – resume pipeline status
    """
    from app.services.scraper_ai_search_service import (
        interpret_scraper_search_prompt,
        apply_scraper_search_spec,
    )
    from app.core.exceptions import AIParsingError

    user_id: str = user.get("user_id", "") if isinstance(user, dict) else ""

    try:
        spec = await interpret_scraper_search_prompt(body.prompt, user_id=user_id or None)
    except AIParsingError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error("scraper_ai_search_interpret_failed", error=str(e))
        raise HTTPException(
            status_code=503,
            detail="AI interpretation failed. Check OpenAI configuration and try again.",
        )

    try:
        async with get_session() as session:
            jobs, total = await apply_scraper_search_spec(
                session, user_id, spec, limit=200
            )
    except Exception as e:
        logger.error("scraper_ai_search_query_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Search query failed: {e}")

    return ScraperAiSearchResponse(
        matching_jobs=jobs,
        query=spec.model_dump(mode="json"),
        total_matching=total,
    )


class BatchJobIdsRequest(BaseModel):
    job_ids: list[str] = Field(..., min_length=1)


class BatchOperationResponse(BaseModel):
    succeeded: list[str]
    failed: list[str]
    message: str = ""


@scraper_router.post("/jobs/batch-delete", response_model=BatchOperationResponse)
async def batch_delete_scraped_jobs(
    body: BatchJobIdsRequest,
    user=Depends(_get_current_user),
):
    """Delete multiple scraped job rows in one request.

    Linked extractions and jobs are left intact.
    """
    from sqlalchemy import text

    succeeded: list[str] = []
    failed: list[str] = []

    async with get_session() as session:
        for job_id in body.job_ids:
            try:
                row = (await session.execute(
                    text("SELECT id FROM scraped_jobs WHERE id = :id"),
                    {"id": job_id},
                )).first()
                if not row:
                    failed.append(job_id)
                    continue
                await session.execute(
                    text("DELETE FROM scraped_jobs WHERE id = :id"),
                    {"id": job_id},
                )
                succeeded.append(job_id)
            except Exception as exc:
                logger.warning("batch_delete_job_failed", job_id=job_id, error=str(exc))
                failed.append(job_id)
        await session.commit()

    logger.info("batch_scraped_jobs_deleted", count=len(succeeded), failed=len(failed))
    return BatchOperationResponse(
        succeeded=succeeded,
        failed=failed,
        message=f"Deleted {len(succeeded)} job(s)."
        + (f" {len(failed)} failed." if failed else ""),
    )


@scraper_router.post("/jobs/batch-rerun", response_model=BatchOperationResponse)
async def batch_rerun_scraped_jobs(
    body: BatchJobIdsRequest,
    user=Depends(_get_current_user),
):
    """Trigger the full extraction → analysis → resume pipeline for multiple jobs."""
    from sqlalchemy import text

    user_id: str | None = user.get("user_id") if isinstance(user, dict) else None
    succeeded: list[str] = []
    failed: list[str] = []
    seen_extraction_ids: set[str] = set()

    for job_id in body.job_ids:
        try:
            async with get_session() as session:
                row = (await session.execute(
                    text("SELECT * FROM scraped_jobs WHERE id = :id"),
                    {"id": job_id},
                )).mappings().first()
            if not row:
                failed.append(job_id)
                continue

            ext_id = row.get("promoted_extraction_id")
            if ext_id and ext_id in seen_extraction_ids:
                succeeded.append(job_id)
                continue
            if ext_id:
                seen_extraction_ids.add(ext_id)

            result = await _rerun_scraped_job_lifecycle(dict(row), user_id=user_id)
            if result.status == "enqueued" and result.enqueued:
                succeeded.append(job_id)
            else:
                failed.append(job_id)
                logger.warning(
                    "batch_rerun_job_failed",
                    job_id=job_id,
                    status=result.status,
                    error=result.message,
                )
        except Exception as exc:
            logger.warning("batch_rerun_job_failed", job_id=job_id, error=str(exc))
            failed.append(job_id)

    logger.info("batch_scraped_jobs_rerun", count=len(succeeded), failed=len(failed))
    return BatchOperationResponse(
        succeeded=succeeded,
        failed=failed,
        message=f"Started pipeline for {len(succeeded)} job(s)."
        + (f" {len(failed)} failed." if failed else ""),
    )


@scraper_router.get("/jobs/{job_id}", response_model=ScrapedJobResponse)
async def get_scraped_job(job_id: str, user=Depends(_get_current_user)):
    """Single scraped job by ID."""
    from sqlalchemy import text

    async with get_session() as session:
        result = await session.execute(
            text("SELECT * FROM scraped_jobs WHERE id = :id"),
            {"id": job_id},
        )
        row = result.mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Scraped job not found")
        return ScrapedJobResponse(**dict(row))


@scraper_router.get("/stats", response_model=ScraperStatsResponse)
async def get_scraper_stats(user=Depends(_get_current_user)):
    """Aggregate statistics for the scraper dashboard."""
    from sqlalchemy import text

    async with get_session() as session:
        total_result = await session.execute(text("SELECT COUNT(*) FROM scraped_jobs"))
        total_jobs = total_result.scalar() or 0

        remote_result = await session.execute(
            text("SELECT COUNT(*) FROM scraped_jobs WHERE is_remote = true")
        )
        total_remote = remote_result.scalar() or 0

        today_result = await session.execute(text(
            "SELECT COUNT(*) FROM scraped_jobs WHERE scraped_at >= CURRENT_DATE"
        ))
        today_scraped = today_result.scalar() or 0

        today_remote_result = await session.execute(text(
            "SELECT COUNT(*) FROM scraped_jobs "
            "WHERE scraped_at >= CURRENT_DATE AND is_remote = TRUE"
        ))
        today_remote = today_remote_result.scalar() or 0

        today_posted_result = await session.execute(text(
            "SELECT COUNT(*) FROM scraped_jobs "
            "WHERE posted_at >= CURRENT_DATE AND posted_at < CURRENT_DATE + INTERVAL '1 day'"
        ))
        today_posted = today_posted_result.scalar() or 0

        extracted_result = await session.execute(text(
            "SELECT COUNT(*) FROM scraped_jobs sj "
            "JOIN job_extractions je ON je.id = sj.promoted_extraction_id "
            "WHERE LOWER(je.status::text) = 'completed'"
        ))
        extracted_jobs = extracted_result.scalar() or 0

        # job_extractions has no job_id column; link via jobs.source_url
        ready_result = await session.execute(text(
            "SELECT COUNT(DISTINCT sj.id) FROM scraped_jobs sj "
            "JOIN job_extractions je ON je.id = sj.promoted_extraction_id "
            "JOIN jobs vj ON LOWER(vj.source_url) IN "
            "    (LOWER(sj.url), LOWER(COALESCE(sj.origin_url, ''))) "
            "JOIN resume_build_results rb ON rb.job_id = vj.id "
            "WHERE LOWER(je.status::text) = 'completed'"
        ))
        ready_jobs = ready_result.scalar() or 0

        source_result = await session.execute(text(
            "SELECT source, COUNT(*) as cnt, MAX(scraped_at) as latest "
            "FROM scraped_jobs GROUP BY source ORDER BY cnt DESC"
        ))
        sources = [
            SourceStats(source=row.source, count=row.cnt, latest_scraped=row.latest)
            for row in source_result
        ]

        runs_result = await session.execute(text(
            "SELECT id, spider_name, started_at, finished_at, items_scraped, "
            "items_new, items_updated, errors, status "
            "FROM scrape_runs ORDER BY started_at DESC LIMIT 10"
        ))
        recent_runs = [dict(row._mapping) for row in runs_result]

        return ScraperStatsResponse(
            total_jobs=total_jobs,
            total_remote=total_remote,
            today_scraped=today_scraped,
            today_remote=today_remote,
            today_posted=today_posted,
            extracted_jobs=extracted_jobs,
            ready_jobs=ready_jobs,
            sources=sources,
            recent_runs=recent_runs,
        )


@scraper_router.get("/sources", response_model=list[str])
async def list_sources(user=Depends(_get_current_user)):
    """Distinct source platform names."""
    from sqlalchemy import text

    async with get_session() as session:
        result = await session.execute(
            text("SELECT DISTINCT source FROM scraped_jobs ORDER BY source")
        )
        return [row[0] for row in result]


@scraper_router.get("/runs", response_model=list[ScrapeRunResponse])
async def list_scrape_runs(
    limit: int = Query(20, ge=1, le=100),
    user=Depends(_get_current_user),
):
    """Recent scrape run history."""
    from sqlalchemy import text

    async with get_session() as session:
        result = await session.execute(
            text(
                "SELECT id, spider_name, started_at, finished_at, items_scraped, "
                "items_new, items_updated, errors, status "
                "FROM scrape_runs ORDER BY started_at DESC LIMIT :limit"
            ),
            {"limit": limit},
        )
        return [ScrapeRunResponse(**dict(row._mapping)) for row in result]


@scraper_router.post("/sync", response_model=SyncStatusResponse)
async def trigger_sync(body: SyncRequest, user=Depends(_get_current_user)):
    """Queue a spider run via arq."""
    from app.scraper.runner import check_spider_auth, SPIDER_META
    from app.tasks.worker import get_scraper_pool

    spider = body.spider_name
    user_id = user.get("user_id", "")

    if spider != "all" and spider in SPIDER_META:
        auth_check = check_spider_auth(spider)
        if auth_check["requires_auth"] and not auth_check["ok"]:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Spider '{spider}' requires authentication but no session is configured. "
                    f"Run this command first: {auth_check['auth_setup_command']}"
                ),
            )

    try:
        pool = await get_scraper_pool()
        await pool.enqueue_job("run_scraper_task", spider, str(user_id))
        await pool.close()

        logger.info("scraper_sync_enqueued", spider=spider, user_id=str(user_id))
        return SyncStatusResponse(
            status="queued",
            spider_name=spider,
            message=f"Spider '{spider}' has been queued for execution.",
        )
    except Exception as e:
        logger.error("scraper_sync_enqueue_failed", error=str(e))
        raise HTTPException(status_code=503, detail=f"Failed to queue scraper: {e}")


@scraper_router.get("/sync/status", response_model=SyncStatusResponse)
async def get_sync_status(user=Depends(_get_current_user)):
    """Check if any spider is currently running.

    Any run that has been in 'running' state for longer than the worker's
    subprocess timeout (1800 s / 30 min) is treated as stale — it is
    marked 'interrupted' inline and the endpoint returns 'idle'.  This is
    the belt-and-suspenders guard for the case where the startup cleanup
    in lifespan() was skipped (e.g. the worker process crashed without
    the API server restarting).
    """
    from sqlalchemy import text

    # Worker timeout is 1800 s; add a small buffer → 31 min.
    # Threshold is inlined as a literal — asyncpg cannot bind parameters
    # inside PostgreSQL INTERVAL strings.
    # The threshold is a hard-coded constant so it can be inlined directly
    # into the SQL string — PostgreSQL does not support bind parameters
    # inside INTERVAL literals (e.g. INTERVAL '$1 minutes' is invalid).
    async with get_session() as session:
        # Auto-heal runs that have been stuck for too long.
        await session.execute(
            text(
                "UPDATE scrape_runs "
                "SET status = 'interrupted', finished_at = now() "
                "WHERE status = 'running' "
                "  AND started_at < now() - INTERVAL '31 minutes'"
            )
        )
        await session.commit()

        result = await session.execute(
            text("SELECT id, spider_name FROM scrape_runs WHERE status = 'running' LIMIT 1")
        )
        row = result.first()
        if row:
            return SyncStatusResponse(
                status="running",
                spider_name=row.spider_name,
                message=f"Spider '{row.spider_name}' is currently running.",
            )
        return SyncStatusResponse(status="idle", message="No spider is currently running.")


@scraper_router.get("/spiders", response_model=list[SpiderInfo])
async def list_spiders(user=Depends(_get_current_user)):
    """Available spiders with metadata including live auth status."""
    from app.scraper.runner import get_available_spiders

    spiders = get_available_spiders()
    return [SpiderInfo(**s) for s in spiders]


@scraper_router.post("/jobs/{job_id}/rerun-extraction", response_model=RerunResponse)
async def rerun_scraped_job_extraction(
    job_id: str,
    user=Depends(_get_current_user),
):
    """Rerun the description-extraction pipeline for a scraped job.

    Behavior:
    - If the row was never promoted: promote it now (creates JobExtraction +
      Job via the same path used after a fresh scrape) and enqueue
      ``extract_job``.
    - If the row was already promoted: clear the linked JobExtraction's
      structured fields via ``reset_for_refresh`` so the next pass writes a
      fresh result, then enqueue ``extract_job`` against the latest URL.
    """
    from sqlalchemy import text

    async with get_session() as session:
        row = (await session.execute(
            text("SELECT * FROM scraped_jobs WHERE id = :id"),
            {"id": job_id},
        )).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Scraped job not found")

    user_id: str | None = user.get("user_id") if isinstance(user, dict) else None
    result = await _rerun_scraped_job_lifecycle(dict(row), user_id=user_id)
    if result.status == "enqueued":
        return result
    _raise_http_for_rerun_failure(result)


@scraper_router.patch("/jobs/{job_id}", response_model=ScrapedJobResponse)
async def update_scraped_job(
    job_id: str,
    body: ScrapedJobUpdateRequest,
    user=Depends(_get_current_user),
):
    """Edit an existing scraped job.

    When the URL changes, the linked JobExtraction + Job are kept in
    sync (source_url, normalized_url, domain).  The caller can hit
    ``POST /scraper/jobs/{id}/rerun-extraction`` afterwards to refresh the
    extraction body against the new URL.
    """
    from sqlalchemy import text
    from app.services.url_manager import URLManager

    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields supplied to update")

    for url_field in ("url", "origin_url"):
        if url_field in updates:
            candidate = (updates[url_field] or "").strip()
            if candidate:
                ok, err = URLManager.validate_url(candidate)
                if not ok:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{url_field} is invalid: {err or 'unknown error'}",
                    )
                updates[url_field] = candidate
            else:
                updates[url_field] = None

    async with get_session() as session:
        row = (await session.execute(
            text("SELECT * FROM scraped_jobs WHERE id = :id"),
            {"id": job_id},
        )).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Scraped job not found")
        existing = dict(row)

        set_clauses = []
        params: dict = {"id": job_id, "now": datetime.now(timezone.utc).replace(tzinfo=None)}
        for col in ("url", "origin_url", "title", "company_name", "location"):
            if col in updates:
                set_clauses.append(f"{col} = :{col}")
                params[col] = updates[col]
        set_clauses.append("updated_at = :now")
        await session.execute(
            text(f"UPDATE scraped_jobs SET {', '.join(set_clauses)} WHERE id = :id"),
            params,
        )

        # Propagate URL changes to the linked JobExtraction + Job so
        # rerunning extraction uses the updated URL.
        if "url" in updates or "origin_url" in updates:
            new_existing = dict(existing)
            if "url" in updates:
                new_existing["url"] = updates["url"]
            if "origin_url" in updates:
                new_existing["origin_url"] = updates["origin_url"]
            from app.services.scrape_promoter import pick_target_url
            new_target = pick_target_url(new_existing)
            promoted_extraction_id = existing.get("promoted_extraction_id")
            if new_target and promoted_extraction_id:
                domain = URLManager.extract_domain(new_target)
                await session.execute(
                    text(
                        "UPDATE job_extractions "
                        "SET source_url = :u, normalized_url = :u, domain = :d, updated_at = :now "
                        "WHERE id = :eid"
                    ),
                    {"u": new_target, "d": domain, "now": params["now"], "eid": promoted_extraction_id},
                )
                await session.execute(
                    text(
                        "UPDATE jobs "
                        "SET source_url = :u, normalized_url = :u, domain = :d, updated_at = :now "
                        "WHERE extraction_id = :eid"
                    ),
                    {"u": new_target, "d": domain, "now": params["now"], "eid": promoted_extraction_id},
                )

        # The get_session() context manager commits on exit; flush so the
        # refresh SELECT below sees the in-flight UPDATE without needing a
        # second explicit commit (which on Windows + asyncpg was causing a
        # hang during the implicit context-exit commit).
        await session.flush()

        refreshed = (await session.execute(
            text("SELECT * FROM scraped_jobs WHERE id = :id"),
            {"id": job_id},
        )).mappings().first()
        response = ScrapedJobResponse(**dict(refreshed))

    return response


@scraper_router.delete("/jobs/{job_id}", response_model=DeleteResponse)
async def delete_scraped_job(job_id: str, user=Depends(_get_current_user)):
    """Delete a scraped job row.

    The linked JobExtraction and Job (if any) are left untouched so
    extraction history and downstream analyses are preserved.  The user can
    delete those independently from the Extraction Dashboard.
    """
    from sqlalchemy import text

    async with get_session() as session:
        row = (await session.execute(
            text("SELECT id FROM scraped_jobs WHERE id = :id"),
            {"id": job_id},
        )).first()
        if not row:
            raise HTTPException(status_code=404, detail="Scraped job not found")
        await session.execute(
            text("DELETE FROM scraped_jobs WHERE id = :id"),
            {"id": job_id},
        )
        await session.commit()

    logger.info("scraped_job_deleted", scraped_job_id=job_id)
    return DeleteResponse(
        status="deleted",
        scraped_job_id=job_id,
        message="Scraped job removed. The linked extraction (if any) is preserved.",
    )


@scraper_router.get("/auth/status", response_model=list[AuthPlatformStatus])
async def get_auth_status(
    platform: Optional[str] = Query(None),
    user=Depends(_get_current_user),
):
    """Check authentication session status for scraper platforms."""
    from app.scraper.auth import PLATFORMS, session_status

    results = []
    platforms_to_check = {platform: PLATFORMS[platform]} if platform and platform in PLATFORMS else PLATFORMS

    for key, cfg in platforms_to_check.items():
        status = session_status(key)
        results.append(AuthPlatformStatus(
            platform=key,
            label=cfg["label"],
            exists=status.get("exists", False),
            corrupt=status.get("corrupt", False),
            saved_at=status.get("saved_at"),
            cookie_count=status.get("cookie_count", 0),
            setup_command=f"python -m app.scraper.auth setup {key}",
        ))

    return results


@scraper_router.post("/auth/clear/{platform}")
async def clear_auth_session(platform: str, user=Depends(_get_current_user)):
    """Clear a saved authentication session for a platform."""
    from app.scraper.auth import PLATFORMS, clear_session

    if platform not in PLATFORMS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown platform: {platform}. Supported: {', '.join(PLATFORMS.keys())}",
        )

    cleared = clear_session(platform)
    if cleared:
        return {"status": "cleared", "platform": platform, "message": f"Session for {platform} has been cleared."}
    return {"status": "not_found", "platform": platform, "message": f"No session file found for {platform}."}
