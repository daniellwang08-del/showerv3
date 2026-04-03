"""
AI-assisted natural language search over valid jobs.
OpenAI turns a user prompt into a structured JobSearchQuerySpec; we apply it in SQLAlchemy.
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import AsyncOpenAI
from sqlalchemy import select, or_, and_, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client
from app.models.database import JobExtraction, JobMatchResult, ValidJob
from app.models.schemas import ExtractionStatus, JobSearchQuerySpec

logger = get_logger(__name__)

JOB_SEARCH_SCHEMA_DOC = """
Each valid job row includes:
- valid_jobs: id, source_url, domain, title, company, location, description, experience_level, industry
- job_extractions (optional): title, company, location, description, employment_type, salary_range,
  remote_policy, experience_level, industry, responsibilities (string[]), requirements (string[]), benefits (string[])
- extraction status: pending | processing | completed | failed
- match_overall_score: 0–100 from AI job–profile match when analyzed (null if not yet analyzed)

Search combines text from both valid_jobs and completed extraction fields where present.
"""

SYSTEM_PROMPT = f"""You convert natural language job search requests into a precise JSON filter for a job database.

{JOB_SEARCH_SCHEMA_DOC}

Rules:
- Return ONLY a single JSON object (no markdown) with the keys exactly as specified below.
- Use lowercase phrases for text filters when possible; matching is case-insensitive substring search.
- must_contain_all: every phrase must appear somewhere in the combined job text (AND).
- must_contain_any: at least one phrase must appear (OR). Use for synonyms or role families.
- must_not_contain: exclude jobs whose combined text contains any of these phrases.
- title_contains_any / company_contains_any / location_contains_any: substring match on those fields only (valid job + extraction).
- domain_contains_any: substring match on job.domain or source URL host (e.g. "linkedin", "greenhouse").
- experience_level_any / industry_any: substring match on those fields.
- min_match_score / max_match_score: filter on match_overall_score (int 0–100). Use min_match_score for "strong fit", "high match".
- match_only_analyzed: true if the user only wants jobs that already have a match score.
- extraction_completed_only: true if the user needs fully scraped/analyzed posting content (ignore pending/processing).

If the user prompt is broad ("all remote Python") use must_contain_any for main skills and optional location_contains_any for "remote".
If the prompt is vague, prefer fewer stricter fields plus must_contain_any for main intent.

JSON shape (all list fields default to [], optional numbers/bools can be null/false):
{{
  "rationale": "string",
  "must_contain_all": ["..."],
  "must_contain_any": ["..."],
  "must_not_contain": ["..."],
  "title_contains_any": ["..."],
  "company_contains_any": ["..."],
  "location_contains_any": ["..."],
  "domain_contains_any": ["..."],
  "experience_level_any": ["..."],
  "industry_any": ["..."],
  "min_match_score": null,
  "max_match_score": null,
  "match_only_analyzed": false,
  "extraction_completed_only": false
}}
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
    ):
        return True
    if spec.min_match_score is not None or spec.max_match_score is not None:
        return True
    if spec.match_only_analyzed or spec.extraction_completed_only:
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


def _ilike_any_on_fields(fields: list, phrases: list[str]):
    """Build OR(field ILIKE %phrase%) across multiple columns and phrases."""
    conditions = []
    for phrase in phrases:
        p = phrase.strip()
        if not p:
            continue
        for field in fields:
            conditions.append(field.ilike(f"%{p}%"))
    return or_(*conditions) if conditions else None


def _ilike_all_on_fields(fields: list, phrases: list[str]):
    """Each phrase must appear in at least one field (AND across phrases)."""
    per_phrase = []
    for phrase in phrases:
        p = phrase.strip()
        if not p:
            continue
        one_phrase = [field.ilike(f"%{p}%") for field in fields]
        per_phrase.append(or_(*one_phrase))
    return and_(*per_phrase) if per_phrase else None


def _ilike_none_on_fields(fields: list, phrases: list[str]):
    """None of the phrases may appear in any field."""
    conditions = []
    for phrase in phrases:
        p = phrase.strip()
        if not p:
            continue
        for field in fields:
            conditions.append(~field.ilike(f"%{p}%"))
    return and_(*conditions) if conditions else None


async def apply_job_search_spec(
    session: AsyncSession,
    user_id: str,
    spec: JobSearchQuerySpec,
    limit: int = 5000,
) -> tuple[list[str], int]:
    stmt = (
        select(ValidJob.id)
        .select_from(ValidJob)
        .outerjoin(JobExtraction, ValidJob.extraction_id == JobExtraction.id)
        .outerjoin(
            JobMatchResult,
            (JobMatchResult.valid_job_id == ValidJob.id) & (JobMatchResult.user_id == user_id),
        )
        .where(ValidJob.is_active == True)
        .order_by(ValidJob.created_at.desc())
        .limit(limit)
    )

    if not _spec_has_constraints(spec):
        result = await session.execute(stmt)
        ids = [r[0] for r in result.all()]
        return ids, len(ids)

    # Searchable text columns across both tables
    text_fields = [
        ValidJob.title, ValidJob.company, ValidJob.location,
        ValidJob.description, ValidJob.domain, ValidJob.source_url,
        ValidJob.experience_level, ValidJob.industry,
        JobExtraction.title, JobExtraction.company, JobExtraction.location,
        JobExtraction.description, JobExtraction.employment_type,
        JobExtraction.salary_range, JobExtraction.remote_policy,
        JobExtraction.experience_level, JobExtraction.industry,
    ]

    if spec.extraction_completed_only:
        stmt = stmt.where(JobExtraction.status == ExtractionStatus.COMPLETED)

    if spec.match_only_analyzed:
        stmt = stmt.where(JobMatchResult.overall_score.isnot(None))

    if spec.min_match_score is not None:
        stmt = stmt.where(JobMatchResult.overall_score >= spec.min_match_score)

    if spec.max_match_score is not None:
        stmt = stmt.where(JobMatchResult.overall_score <= spec.max_match_score)

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

    title_fields = [ValidJob.title, JobExtraction.title]
    if spec.title_contains_any:
        clause = _ilike_any_on_fields(title_fields, spec.title_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    company_fields = [ValidJob.company, JobExtraction.company]
    if spec.company_contains_any:
        clause = _ilike_any_on_fields(company_fields, spec.company_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    location_fields = [ValidJob.location, JobExtraction.location]
    if spec.location_contains_any:
        clause = _ilike_any_on_fields(location_fields, spec.location_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    domain_fields = [ValidJob.domain, ValidJob.source_url]
    if spec.domain_contains_any:
        clause = _ilike_any_on_fields(domain_fields, spec.domain_contains_any)
        if clause is not None:
            stmt = stmt.where(clause)

    exp_fields = [ValidJob.experience_level, JobExtraction.experience_level]
    if spec.experience_level_any:
        clause = _ilike_any_on_fields(exp_fields, spec.experience_level_any)
        if clause is not None:
            stmt = stmt.where(clause)

    ind_fields = [ValidJob.industry, JobExtraction.industry]
    if spec.industry_any:
        clause = _ilike_any_on_fields(ind_fields, spec.industry_any)
        if clause is not None:
            stmt = stmt.where(clause)

    count_stmt = select(func.count()).select_from(ValidJob).where(ValidJob.is_active == True)
    total = (await session.execute(count_stmt)).scalar_one()

    result = await session.execute(stmt)
    matching_ids = [r[0] for r in result.all()]
    return matching_ids, total
