"""
AI-assisted natural language search over valid jobs.
OpenAI turns a user prompt into a structured JobSearchQuerySpec; we apply it in SQLAlchemy.
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client
from app.models.database import JobExtraction, JobMatchInProgress, JobMatchResult, ValidJob
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


def _json_list_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(str(x).strip() for x in value if x is not None and str(x).strip())
    return str(value)


def _norm(s: str) -> str:
    return (s or "").lower()


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


def _build_combined_blob(job: ValidJob, ex: JobExtraction | None) -> str:
    parts: list[str] = [
        job.title or "",
        job.company or "",
        job.location or "",
        job.description or "",
        job.experience_level or "",
        job.industry or "",
        job.domain or "",
        job.source_url or "",
    ]
    if ex:
        parts.extend(
            [
                ex.title or "",
                ex.company or "",
                ex.location or "",
                ex.description or "",
                ex.employment_type or "",
                ex.salary_range or "",
                ex.remote_policy or "",
                ex.experience_level or "",
                ex.industry or "",
                _json_list_text(ex.responsibilities),
                _json_list_text(ex.requirements),
                _json_list_text(ex.benefits),
            ]
        )
    return _norm(" ".join(p for p in parts if p))


def _build_title_text(job: ValidJob, ex: JobExtraction | None) -> str:
    return _norm(" ".join(x for x in [job.title or "", (ex.title if ex else None) or ""] if x))


def _build_company_text(job: ValidJob, ex: JobExtraction | None) -> str:
    return _norm(" ".join(x for x in [job.company or "", (ex.company if ex else None) or ""] if x))


def _build_location_text(job: ValidJob, ex: JobExtraction | None) -> str:
    return _norm(" ".join(x for x in [job.location or "", (ex.location if ex else None) or ""] if x))


def _build_experience_text(job: ValidJob, ex: JobExtraction | None) -> str:
    return _norm(" ".join(x for x in [job.experience_level or "", (ex.experience_level if ex else None) or ""] if x))


def _build_industry_text(job: ValidJob, ex: JobExtraction | None) -> str:
    return _norm(" ".join(x for x in [job.industry or "", (ex.industry if ex else None) or ""] if x))


def _contains_all(hay: str, needles: list[str]) -> bool:
    return all(n.strip() and n.lower() in hay for n in needles)


def _contains_any(hay: str, needles: list[str]) -> bool:
    hits = [n for n in needles if n.strip()]
    if not hits:
        return True
    return any(n.lower() in hay for n in hits)


def _contains_none(hay: str, needles: list[str]) -> bool:
    return not any(n.strip() and n.lower() in hay for n in needles)


def _substring_any(hay: str, needles: list[str]) -> bool:
    return _contains_any(hay, needles)


def _row_matches(
    job: ValidJob,
    ex: JobExtraction | None,
    ext_status: ExtractionStatus | None,
    match_score: int | None,
    spec: JobSearchQuerySpec,
) -> bool:
    blob = _build_combined_blob(job, ex)

    if spec.extraction_completed_only:
        if ext_status != ExtractionStatus.COMPLETED:
            return False

    if spec.match_only_analyzed and match_score is None:
        return False

    if spec.min_match_score is not None:
        if match_score is None or match_score < spec.min_match_score:
            return False
    if spec.max_match_score is not None:
        if match_score is None or match_score > spec.max_match_score:
            return False

    if not _contains_all(blob, spec.must_contain_all):
        return False
    if spec.must_contain_any and not _contains_any(blob, spec.must_contain_any):
        return False
    if not _contains_none(blob, spec.must_not_contain):
        return False

    title_t = _build_title_text(job, ex)
    if spec.title_contains_any and not _substring_any(title_t, spec.title_contains_any):
        return False

    comp_t = _build_company_text(job, ex)
    if spec.company_contains_any and not _substring_any(comp_t, spec.company_contains_any):
        return False

    loc_t = _build_location_text(job, ex)
    if spec.location_contains_any and not _substring_any(loc_t, spec.location_contains_any):
        return False

    domain_hay = _norm(f"{job.domain} {job.source_url}")
    if spec.domain_contains_any and not _substring_any(domain_hay, spec.domain_contains_any):
        return False

    exp_t = _build_experience_text(job, ex)
    if spec.experience_level_any and not _substring_any(exp_t, spec.experience_level_any):
        return False

    ind_t = _build_industry_text(job, ex)
    if spec.industry_any and not _substring_any(ind_t, spec.industry_any):
        return False

    return True


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


async def apply_job_search_spec(
    session: AsyncSession,
    user_id: str,
    spec: JobSearchQuerySpec,
    limit: int = 5000,
) -> tuple[list[str], int]:
    stmt = (
        select(
            ValidJob,
            JobExtraction,
            JobMatchResult.overall_score,
            JobMatchInProgress.id.label("match_progress_id"),
        )
        .select_from(ValidJob)
        .outerjoin(JobExtraction, ValidJob.extraction_id == JobExtraction.id)
        .outerjoin(
            JobMatchResult,
            (JobMatchResult.valid_job_id == ValidJob.id) & (JobMatchResult.user_id == user_id),
        )
        .outerjoin(
            JobMatchInProgress,
            (JobMatchInProgress.valid_job_id == ValidJob.id) & (JobMatchInProgress.user_id == user_id),
        )
        .where(ValidJob.is_active == True)
        .order_by(ValidJob.created_at.desc())
        .limit(limit)
    )
    result = await session.execute(stmt)
    rows = result.all()

    if not _spec_has_constraints(spec):
        return [r[0].id for r in rows], len(rows)

    matching: list[str] = []
    for job, extraction, match_score, _match_progress_id in rows:
        ext_status = extraction.status if extraction else None
        if _row_matches(job, extraction, ext_status, match_score, spec):
            matching.append(job.id)
    return matching, len(rows)
