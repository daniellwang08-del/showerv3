"""
AI-assisted natural language search over valid jobs.
OpenAI turns a user prompt into a structured JobSearchQuerySpec; we apply it in SQLAlchemy.
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import AsyncOpenAI
from sqlalchemy import select, or_, and_, func, cast, String, literal
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client
from app.models.database import (
    JobExtraction,
    JobMatchResult,
    ValidJob,
    ValidJobUserApplication,
    JobMatchInProgress,
)
from app.models.schemas import ExtractionStatus, JobSearchQuerySpec

logger = get_logger(__name__)

SYSTEM_PROMPT = """You convert natural language job search requests into a precise JSON filter for a job database.

The database stores job postings with the following searchable data:
- valid_jobs: title, company, location, description, domain, source_url, experience_level, industry
- job_extractions (from scraped content): title, company, location, description, employment_type,
  salary_range, remote_policy, experience_level, industry, responsibilities[], requirements[], benefits[]
- match analysis (AI job–profile fit): overall_score (0–100), summary, strengths[], gaps[], recommendation
- applied status: whether the user has marked the job as "applied"

Rules:
- Return ONLY a single JSON object (no markdown fences) with the keys specified below.
- Use lowercase for text filters; matching is case-insensitive substring.
- Be generous with synonyms: if the user says "React" also include "react.js", "reactjs". If "remote" also consider "work from home". If "Python" also include "python3".
- For broad queries, prefer must_contain_any (OR) over must_contain_all (AND).
- For skill searches, put skill variations in must_contain_any and role keywords in title_contains_any.

Filter keys:
- must_contain_all: every phrase must appear in combined job text (AND across phrases).
- must_contain_any: at least one phrase must appear in combined text (OR). Use for skill synonyms.
- must_not_contain: exclude jobs containing any of these phrases.
- title_contains_any: match on job title only.
- company_contains_any: match on company name only.
- location_contains_any: match on location field only (e.g. "remote", "new york", "san francisco").
- domain_contains_any: match on job board domain/URL (e.g. "linkedin", "greenhouse", "lever").
- experience_level_any: match on experience level (e.g. "senior", "mid", "junior", "lead", "staff").
- industry_any: match on industry field.
- remote_policy_any: match on remote policy (e.g. "remote", "hybrid", "onsite", "flexible").
- salary_contains_any: match on salary range text (e.g. "$150k", "150000", "competitive").
- recommendation_any: match on AI recommendation (e.g. "strong apply", "apply", "consider", "skip").
- min_match_score / max_match_score: filter on AI match score (0–100).
- match_only_analyzed: true = only show jobs that have been analyzed for profile fit.
- extraction_completed_only: true = only show jobs with completed content extraction.
- applied_status: "applied" = only applied jobs, "not_applied" = only non-applied, null = no filter.

JSON shape (all lists default to [], numbers/bools/strings can be null):
{
  "rationale": "string",
  "must_contain_all": [],
  "must_contain_any": [],
  "must_not_contain": [],
  "title_contains_any": [],
  "company_contains_any": [],
  "location_contains_any": [],
  "domain_contains_any": [],
  "experience_level_any": [],
  "industry_any": [],
  "remote_policy_any": [],
  "salary_contains_any": [],
  "recommendation_any": [],
  "min_match_score": null,
  "max_match_score": null,
  "match_only_analyzed": false,
  "extraction_completed_only": false,
  "applied_status": null
}
"""


def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    return json.loads(text)


def _spec_has_constraints(spec: JobSearchQuerySpec) -> bool:
    if spec.must_contain_all or spec.must_contain_any or spec.must_not_contain:
        return True
    if (
        spec.title_contains_any
        or spec.company_contains_any
        or spec.location_contains_any
        or spec.domain_contains_any
        or spec.experience_level_any
        or spec.industry_any
        or spec.remote_policy_any
        or spec.salary_contains_any
        or spec.recommendation_any
    ):
        return True
    if spec.min_match_score is not None or spec.max_match_score is not None:
        return True
    if spec.match_only_analyzed or spec.extraction_completed_only:
        return True
    if spec.applied_status is not None:
        return True
    return False


async def interpret_job_search_prompt(prompt: str) -> JobSearchQuerySpec:
    client: AsyncOpenAI = get_openai_client()
    settings = get_settings()

    user_msg = f'User search request:\n"""{prompt.strip()}"""\n\nRespond with the JSON object only.'

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=min(settings.openai_temperature, 0.3),
        max_tokens=1200,
    )
    raw = response.choices[0].message.content
    if not raw:
        raise AIParsingError("Empty AI response for job search")
    try:
        data = _parse_json_object(raw)
        spec = JobSearchQuerySpec.model_validate(data)
        logger.info("job_ai_search_interpreted", rationale=(spec.rationale or "")[:200])
        return spec
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("job_ai_search_parse_failed", error=str(e), raw_preview=raw[:300])
        raise AIParsingError("Could not parse AI search response") from e


def _coalesce_ilike(column, pattern: str):
    """COALESCE(column, '') ILIKE pattern — NULL-safe substring match."""
    return func.coalesce(column, literal("")).ilike(pattern)


def _coalesce_not_ilike(column, pattern: str):
    """NOT (COALESCE(column, '') ILIKE pattern) — NULL-safe exclusion."""
    return ~func.coalesce(column, literal("")).ilike(pattern)


def _json_array_as_text(column):
    """Cast a JSON array column to text for ILIKE searching."""
    return func.coalesce(cast(column, String), literal(""))


def _ilike_any_on_fields(fields: list, phrases: list[str]):
    """Build OR(COALESCE(field, '') ILIKE %phrase%) across all columns and phrases."""
    conditions = []
    for phrase in phrases:
        p = phrase.strip()
        if not p:
            continue
        pattern = f"%{p}%"
        for field in fields:
            conditions.append(_coalesce_ilike(field, pattern))
    return or_(*conditions) if conditions else None


def _ilike_all_on_fields(fields: list, phrases: list[str]):
    """Each phrase must appear in at least one field (AND across phrases, OR across fields)."""
    per_phrase = []
    for phrase in phrases:
        p = phrase.strip()
        if not p:
            continue
        pattern = f"%{p}%"
        one_phrase = [_coalesce_ilike(field, pattern) for field in fields]
        per_phrase.append(or_(*one_phrase))
    return and_(*per_phrase) if per_phrase else None


def _ilike_none_on_fields(fields: list, phrases: list[str]):
    """None of the phrases may appear in any field (NULL-safe)."""
    conditions = []
    for phrase in phrases:
        p = phrase.strip()
        if not p:
            continue
        pattern = f"%{p}%"
        for field in fields:
            conditions.append(_coalesce_not_ilike(field, pattern))
    return and_(*conditions) if conditions else None


def _build_search_query(
    user_id: str,
    spec: JobSearchQuerySpec,
    *,
    select_columns: list | None = None,
    limit: int | None = 500,
    offset: int = 0,
):
    """Build the core SELECT + WHERE for AI search. Set limit=None for unbounded (count queries)."""

    if select_columns is None:
        select_columns = [ValidJob.id]

    stmt = (
        select(*select_columns)
        .select_from(ValidJob)
        .outerjoin(JobExtraction, ValidJob.extraction_id == JobExtraction.id)
        .outerjoin(
            JobMatchResult,
            (JobMatchResult.valid_job_id == ValidJob.id) & (JobMatchResult.user_id == user_id),
        )
        .outerjoin(
            ValidJobUserApplication,
            (ValidJobUserApplication.valid_job_id == ValidJob.id)
            & (ValidJobUserApplication.user_id == user_id),
        )
        .outerjoin(
            JobMatchInProgress,
            (JobMatchInProgress.valid_job_id == ValidJob.id) & (JobMatchInProgress.user_id == user_id),
        )
        .where(ValidJob.is_active == True)  # noqa: E712
    )

    if not _spec_has_constraints(spec):
        stmt = stmt.order_by(ValidJob.created_at.desc())
        if limit is not None:
            stmt = stmt.limit(limit).offset(offset)
        return stmt

    json_text_fields = [
        _json_array_as_text(JobExtraction.responsibilities),
        _json_array_as_text(JobExtraction.requirements),
        _json_array_as_text(JobExtraction.benefits),
    ]

    match_text_fields = [
        func.coalesce(JobMatchResult.summary, literal("")),
        _json_array_as_text(JobMatchResult.strengths),
        _json_array_as_text(JobMatchResult.gaps),
    ]

    text_fields = [
        ValidJob.title, ValidJob.company, ValidJob.location,
        ValidJob.description, ValidJob.domain, ValidJob.source_url,
        ValidJob.experience_level, ValidJob.industry,
        JobExtraction.title, JobExtraction.company, JobExtraction.location,
        JobExtraction.description, JobExtraction.employment_type,
        JobExtraction.salary_range, JobExtraction.remote_policy,
        JobExtraction.experience_level, JobExtraction.industry,
        *json_text_fields,
        *match_text_fields,
    ]

    if spec.extraction_completed_only:
        stmt = stmt.where(JobExtraction.status == ExtractionStatus.COMPLETED)

    if spec.match_only_analyzed:
        stmt = stmt.where(JobMatchResult.overall_score.isnot(None))

    if spec.min_match_score is not None:
        stmt = stmt.where(JobMatchResult.overall_score >= spec.min_match_score)

    if spec.max_match_score is not None:
        stmt = stmt.where(JobMatchResult.overall_score <= spec.max_match_score)

    if spec.applied_status == "applied":
        stmt = stmt.where(ValidJobUserApplication.id.isnot(None))
    elif spec.applied_status == "not_applied":
        stmt = stmt.where(ValidJobUserApplication.id.is_(None))

    if spec.must_contain_all:
        clause = _ilike_all_on_fields(text_fields, spec.must_contain_all)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.must_contain_any:
        clause = _ilike_any_on_fields(text_fields, spec.must_contain_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.must_not_contain:
        clause = _ilike_none_on_fields(text_fields, spec.must_not_contain)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.title_contains_any:
        title_fields = [ValidJob.title, JobExtraction.title]
        clause = _ilike_any_on_fields(title_fields, spec.title_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.company_contains_any:
        company_fields = [ValidJob.company, JobExtraction.company]
        clause = _ilike_any_on_fields(company_fields, spec.company_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.location_contains_any:
        location_fields = [ValidJob.location, JobExtraction.location]
        clause = _ilike_any_on_fields(location_fields, spec.location_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.domain_contains_any:
        domain_fields = [ValidJob.domain, ValidJob.source_url]
        clause = _ilike_any_on_fields(domain_fields, spec.domain_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.experience_level_any:
        exp_fields = [ValidJob.experience_level, JobExtraction.experience_level]
        clause = _ilike_any_on_fields(exp_fields, spec.experience_level_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.industry_any:
        ind_fields = [ValidJob.industry, JobExtraction.industry]
        clause = _ilike_any_on_fields(ind_fields, spec.industry_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.remote_policy_any:
        remote_fields = [
            JobExtraction.remote_policy,
            ValidJob.location,
            JobExtraction.location,
        ]
        clause = _ilike_any_on_fields(remote_fields, spec.remote_policy_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.salary_contains_any:
        salary_fields = [JobExtraction.salary_range]
        clause = _ilike_any_on_fields(salary_fields, spec.salary_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    if spec.recommendation_any:
        rec_fields = [func.coalesce(JobMatchResult.recommendation, literal(""))]
        clause = _ilike_any_on_fields(rec_fields, spec.recommendation_any)
        if clause is not None:
            stmt = stmt.where(clause)

    stmt = stmt.order_by(ValidJob.created_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return stmt


async def apply_job_search_spec(
    session: AsyncSession,
    user_id: str,
    spec: JobSearchQuerySpec,
    *,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """
    Run the AI-generated search spec against the database.
    Returns (list_of_job_dicts, total_matching_count).
    Each dict contains the full ValidJob data + extraction/match metadata needed by the frontend.
    """

    select_columns = [
        ValidJob,
        JobExtraction.status.label("ext_status"),
        JobExtraction.is_job_posting,
        JobMatchResult.overall_score,
        JobMatchInProgress.id.label("match_progress_id"),
        ValidJobUserApplication.applied_at,
        ValidJobUserApplication.applied_by_name,
    ]

    data_stmt = _build_search_query(
        user_id, spec, select_columns=select_columns, limit=limit, offset=offset,
    )

    count_stmt = _build_search_query(
        user_id, spec, select_columns=[func.count(ValidJob.id)], limit=None,
    )

    result = await session.execute(data_stmt)
    rows = result.all()

    count_result = await session.execute(count_stmt)
    total_matching = count_result.scalar_one()

    jobs: list[dict[str, Any]] = []
    for job, ext_status, is_job_posting, match_score, match_progress_id, applied_at, applied_by_name in rows:
        jobs.append({
            "id": job.id,
            "source_url": job.source_url,
            "normalized_url": job.normalized_url,
            "domain": job.domain,
            "title": job.title,
            "company": job.company,
            "location": job.location,
            "description": job.description,
            "posted_date": job.posted_date.isoformat() if job.posted_date else None,
            "experience_level": job.experience_level,
            "industry": job.industry,
            "similarity_hash": job.similarity_hash,
            "scraped_at": job.scraped_at.isoformat() if job.scraped_at else None,
            "extraction_id": job.extraction_id,
            "extraction_status": ext_status.value if ext_status else None,
            "is_job_posting": is_job_posting,
            "match_overall_score": match_score,
            "match_status": "processing" if (match_progress_id and match_score is None) else None,
            "click_count": getattr(job, "click_count", 0) or 0,
            "applied_at": applied_at.isoformat() if applied_at else None,
            "applied_by_name": applied_by_name,
            "is_active": job.is_active,
            "created_at": job.created_at.isoformat() if job.created_at else None,
            "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        })

    return jobs, total_matching
