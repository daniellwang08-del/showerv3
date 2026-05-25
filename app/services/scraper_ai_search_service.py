"""
AI-assisted natural language search over scraped jobs.

OpenAI converts a user's natural language query into a structured
ScraperJobSearchQuerySpec.  We build parameterised SQL against:
  - scraped_jobs          – raw scraped data (title, company, salary, tags, …)
  - jobs                  – structured extracted fields (via COALESCE link)
  - job_extractions       – detailed extraction (responsibilities, salary, remote_policy…)
  - job_match_results     – per-user AI match score, recommendation, summary
  - resume_build_results  – whether a tailored resume has been built

The search is far more comprehensive than the extraction-page search because
it can filter on scraper-specific dimensions:
  • source platform  (adzuna, indeed, glassdoor …)
  • pipeline stage   (not-yet-promoted, extraction pending, resume built …)
  • salary range     (raw text OR structured cents)
  • recency          (posted/scraped within N days)
  • remote flag      (scraped boolean)
  • tags             (comma-separated tag text)
  • match score + recommendation (after analysis)
  • sort by relevance, score, post date, or scrape date
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client_for_user

try:
    from langfuse import observe
except ImportError:
    from functools import wraps

    def observe(**_kw):  # noqa: E303
        def _decorator(fn):
            @wraps(fn)
            async def _wrapper(*a, **k):
                return await fn(*a, **k)
            return _wrapper
        return _decorator


logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Query spec model — produced by OpenAI, applied as SQL filters
# ---------------------------------------------------------------------------

class ScraperJobSearchQuerySpec(BaseModel):
    """
    Structured search criteria for scraped jobs.
    Produced by OpenAI from a natural language prompt.
    """

    rationale: str | None = Field(
        default=None,
        description="Short human-readable explanation of how the query was interpreted",
    )

    # ── General full-text search ─────────────────────────────────────────────
    # Searches across ALL text fields: scraped content, extracted content,
    # match summaries, salary text, tags, etc.
    must_contain_all: list[str] = Field(default_factory=list,
        description="Every phrase must appear somewhere in the combined job text (AND).")
    must_contain_any: list[str] = Field(default_factory=list,
        description="At least one phrase must appear in the combined job text (OR). "
                    "Use for skill synonyms, e.g. ['react', 'reactjs', 'react.js'].")
    must_not_contain: list[str] = Field(default_factory=list,
        description="Exclude jobs where any of these phrases appear anywhere.")

    # ── Field-specific text filters ──────────────────────────────────────────
    title_contains_any: list[str] = Field(default_factory=list)
    company_contains_any: list[str] = Field(default_factory=list)
    location_contains_any: list[str] = Field(default_factory=list)
    description_contains_any: list[str] = Field(default_factory=list,
        description="Search within job description text only.")
    tags_contain_any: list[str] = Field(default_factory=list,
        description="Search within the comma-separated tags scraped from the source.")

    # ── Job attribute filters ─────────────────────────────────────────────────
    job_type_any: list[str] = Field(default_factory=list,
        description="e.g. ['fulltime', 'contract', 'parttime', 'internship', 'freelance'].")
    experience_level_any: list[str] = Field(default_factory=list,
        description="e.g. ['junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'entry'].")
    industry_any: list[str] = Field(default_factory=list,
        description="e.g. ['fintech', 'healthcare', 'saas', 'e-commerce', 'ai', 'gaming'].")
    source_any: list[str] = Field(default_factory=list,
        description="Scraper source platforms, e.g. ['adzuna', 'indeed', 'glassdoor', "
                    "'jobright', 'welcometothejungle', 'ziprecruiter'].")

    # ── Remote / location ────────────────────────────────────────────────────
    is_remote: bool | None = Field(default=None,
        description="true = remote-only jobs; false = in-office/on-site only; null = no filter.")
    remote_policy_any: list[str] = Field(default_factory=list,
        description="From extracted data: ['remote', 'hybrid', 'onsite', 'flexible', 'work from home'].")

    # ── Salary ───────────────────────────────────────────────────────────────
    salary_contains_any: list[str] = Field(default_factory=list,
        description="Substring search in raw salary text, e.g. ['$150k', '100,000', 'competitive'].")
    min_salary_k: int | None = Field(default=None, ge=0,
        description="Minimum annual salary in $k (e.g. 120 means $120,000). Uses salary_min_cents.")
    max_salary_k: int | None = Field(default=None, ge=0,
        description="Maximum annual salary in $k. Uses salary_max_cents.")

    # ── Pipeline / processing status ─────────────────────────────────────────
    has_extraction: bool | None = Field(default=None,
        description="true = only jobs that have been promoted (extraction triggered); "
                    "false = only raw scraped jobs that have never been extracted.")
    extraction_completed_only: bool = Field(default=False,
        description="Only jobs where the full LLM extraction pipeline has completed.")
    has_match_score: bool | None = Field(default=None,
        description="true = only jobs that have an AI match score; "
                    "false = only jobs with no match score yet.")
    min_match_score: int | None = Field(default=None, ge=0, le=100)
    max_match_score: int | None = Field(default=None, ge=0, le=100)
    recommendation_any: list[str] = Field(default_factory=list,
        description="AI match recommendation text, e.g. ['strong apply', 'apply', 'consider', 'skip'].")
    has_resume: bool | None = Field(default=None,
        description="true = only jobs where a tailored resume has been built.")

    # ── Recency filters ───────────────────────────────────────────────────────
    posted_within_days: int | None = Field(default=None, ge=1,
        description="Only jobs posted within the last N days (uses posted_at).")
    scraped_within_days: int | None = Field(default=None, ge=1,
        description="Only jobs scraped/discovered within the last N days (uses scraped_at).")

    # ── Sorting ───────────────────────────────────────────────────────────────
    sort_by: str = Field(default="scraped_at",
        description="Sort results by: 'match_score', 'posted_at', 'scraped_at'. "
                    "Default is 'scraped_at' (newest scraped first).")
    sort_order: str = Field(default="desc",
        description="'asc' or 'desc'. Ignored when sort_by is 'match_score' "
                    "(always desc / highest first).")


# ---------------------------------------------------------------------------
# System prompt for OpenAI
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You convert natural language job search requests into a precise JSON filter for a scraped-jobs database.

## Database overview
Jobs come from multiple scraping sources (Adzuna, Indeed, Glassdoor, Jobright, etc.) and go through an optional extraction pipeline:
1. Raw scraped data (always available): title, company_name, location, description, tags, salary_raw, job_type, experience_level, source, is_remote, posted_at
2. Extracted / AI-structured data (available after extraction): responsibilities, requirements, benefits, employment_type, salary_range, remote_policy, industry
3. AI match analysis (available after user runs match): overall_score (0-100), recommendation, summary, strengths[], gaps[]
4. Resume status: whether a tailored resume has been built for this job

## Rules
- Return ONLY a raw JSON object — no markdown fences, no commentary.
- Use lowercase for all text filter values; matching is case-insensitive substring.
- Be generous with synonyms in must_contain_any: "Python" → ["python", "python3", "django", "flask"]; "React" → ["react", "reactjs", "react.js"].
- For skill/tech searches, put skill variants in must_contain_any AND role keywords in title_contains_any.
- For broad queries prefer must_contain_any (OR); for very specific phrases use must_contain_all (AND).
- Salary in "k" means thousands of dollars (150 = $150,000).
- Time filters: "last week" = posted_within_days 7, "last month" = 30, "today" = 1, "recent" = 7.
- Remote jobs: set is_remote true; also add "remote" to remote_policy_any and location_contains_any.
- "Not extracted yet" = has_extraction false; "fully processed" = extraction_completed_only true.
- "Has score" = has_match_score true; "needs scoring" = has_match_score false AND has_extraction true.
- Sort by score when user asks for "top", "best", "highest scoring"; sort by posted_at for "newest postings"; scraped_at for "recently added".
- source_any should match the platform slug exactly: adzuna, indeed, glassdoor, jobright, welcometothejungle, ziprecruiter, remoterocketship.

## JSON output schema (all lists default to [], numbers/bools/strings can be null):
{
  "rationale": "string — concise explanation of interpretation",
  "must_contain_all": [],
  "must_contain_any": [],
  "must_not_contain": [],
  "title_contains_any": [],
  "company_contains_any": [],
  "location_contains_any": [],
  "description_contains_any": [],
  "tags_contain_any": [],
  "job_type_any": [],
  "experience_level_any": [],
  "industry_any": [],
  "source_any": [],
  "is_remote": null,
  "remote_policy_any": [],
  "salary_contains_any": [],
  "min_salary_k": null,
  "max_salary_k": null,
  "has_extraction": null,
  "extraction_completed_only": false,
  "has_match_score": null,
  "min_match_score": null,
  "max_match_score": null,
  "recommendation_any": [],
  "has_resume": null,
  "posted_within_days": null,
  "scraped_within_days": null,
  "sort_by": "scraped_at",
  "sort_order": "desc"
}

## Edge-case examples
- "Remote Python senior jobs at startups with score above 70" →
  is_remote: true, experience_level_any: ["senior"], must_contain_any: ["python","python3","django"], min_match_score: 70, sort_by: "match_score"
- "New jobs scraped in the last 3 days" →
  scraped_within_days: 3, sort_by: "scraped_at"
- "Contract React or Vue positions paying over $120k" →
  job_type_any: ["contract","freelance"], must_contain_any: ["react","reactjs","vue","vuejs"], min_salary_k: 120
- "Top 10 best-matching data science jobs I haven't run resume on" →
  must_contain_any: ["data science","data scientist","machine learning","ml"], has_match_score: true, has_resume: false, sort_by: "match_score"
- "Unprocessed Adzuna jobs about DevOps" →
  source_any: ["adzuna"], has_extraction: false, must_contain_any: ["devops","sre","platform engineer","kubernetes","terraform"]
- "Junior frontend roles in NYC or San Francisco posted this month" →
  experience_level_any: ["junior","entry","associate"], must_contain_any: ["frontend","front-end","react","angular","vue"], location_contains_any: ["new york","nyc","san francisco","sf"], posted_within_days: 30
- "High-paying jobs I haven't scored yet" →
  has_match_score: false, has_extraction: true, salary_contains_any: ["150k","200k","$150","$200","300k"], sort_by: "posted_at"
- "Full-stack jobs that are fully extracted but missing score" →
  must_contain_any: ["full stack","fullstack","full-stack"], extraction_completed_only: true, has_match_score: false
- "All jobs with weak or skip recommendation" →
  has_match_score: true, recommendation_any: ["skip","weak","no match"]
"""


# ---------------------------------------------------------------------------
# JSON parsing helpers
# ---------------------------------------------------------------------------

def _parse_json_object(content: str) -> dict[str, Any]:
    text_content = content.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text_content)
    if fence:
        text_content = fence.group(1).strip()
    return json.loads(text_content)


# ---------------------------------------------------------------------------
# OpenAI interpretation
# ---------------------------------------------------------------------------

@observe(name="interpret_scraper_search_prompt")
async def interpret_scraper_search_prompt(
    prompt: str,
    *,
    user_id: str | None = None,
) -> ScraperJobSearchQuerySpec:
    """Convert a natural language prompt into a structured ScraperJobSearchQuerySpec."""
    client: AsyncOpenAI = await get_openai_client_for_user(user_id)
    settings = get_settings()

    user_msg = f'User search request:\n"""{prompt.strip()}"""\n\nRespond with the JSON object only.'

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=min(settings.openai_temperature, 0.2),
        max_tokens=1500,
    )
    raw = response.choices[0].message.content
    if not raw:
        raise AIParsingError("Empty AI response for scraper job search")
    try:
        data = _parse_json_object(raw)
        spec = ScraperJobSearchQuerySpec.model_validate(data)
        logger.info(
            "scraper_ai_search_interpreted",
            rationale=(spec.rationale or "")[:200],
        )
        return spec
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning(
            "scraper_ai_search_parse_failed",
            error=str(e),
            raw_preview=raw[:300],
        )
        raise AIParsingError("Could not parse AI search response") from e


# ---------------------------------------------------------------------------
# SQL helpers
# ---------------------------------------------------------------------------

# Concatenated text expression over ALL searchable fields.
# This blob is used for must_contain_all / must_contain_any / must_not_contain
# checks so a single phrase matches regardless of which field it appears in.
_ALL_TEXT_EXPR = (
    "COALESCE(sj.title,'') || ' ' || "
    "COALESCE(sj.company_name,'') || ' ' || "
    "COALESCE(sj.location,'') || ' ' || "
    "COALESCE(sj.description,'') || ' ' || "
    "COALESCE(sj.tags,'') || ' ' || "
    "COALESCE(sj.salary_raw,'') || ' ' || "
    "COALESCE(sj.job_type,'') || ' ' || "
    "COALESCE(sj.experience_level,'') || ' ' || "
    "COALESCE(vj.title,'') || ' ' || "
    "COALESCE(vj.description,'') || ' ' || "
    "COALESCE(vj.industry,'') || ' ' || "
    "COALESCE(je.title,'') || ' ' || "
    "COALESCE(je.description,'') || ' ' || "
    "COALESCE(je.employment_type,'') || ' ' || "
    "COALESCE(je.salary_range,'') || ' ' || "
    "COALESCE(je.remote_policy,'') || ' ' || "
    "COALESCE(je.experience_level,'') || ' ' || "
    "COALESCE(je.industry,'') || ' ' || "
    "COALESCE(je.responsibilities::text,'') || ' ' || "
    "COALESCE(je.requirements::text,'') || ' ' || "
    "COALESCE(je.benefits::text,'') || ' ' || "
    "COALESCE(jmr.summary,'') || ' ' || "
    "COALESCE(jmr.recommendation,'') || ' ' || "
    "COALESCE(jmr.strengths::text,'') || ' ' || "
    "COALESCE(jmr.gaps::text,'')"
)

_ALLOWED_SORT = {"scraped_at", "posted_at", "match_score"}
_ALLOWED_ORDER = {"asc", "desc"}


def _spec_has_constraints(spec: ScraperJobSearchQuerySpec) -> bool:
    """Return True if the spec has at least one non-trivial filter."""
    return any([
        spec.must_contain_all,
        spec.must_contain_any,
        spec.must_not_contain,
        spec.title_contains_any,
        spec.company_contains_any,
        spec.location_contains_any,
        spec.description_contains_any,
        spec.tags_contain_any,
        spec.job_type_any,
        spec.experience_level_any,
        spec.industry_any,
        spec.source_any,
        spec.is_remote is not None,
        spec.remote_policy_any,
        spec.salary_contains_any,
        spec.min_salary_k is not None,
        spec.max_salary_k is not None,
        spec.has_extraction is not None,
        spec.extraction_completed_only,
        spec.has_match_score is not None,
        spec.min_match_score is not None,
        spec.max_match_score is not None,
        spec.recommendation_any,
        spec.has_resume is not None,
        spec.posted_within_days is not None,
        spec.scraped_within_days is not None,
    ])


def _build_scraper_search_sql(
    spec: ScraperJobSearchQuerySpec,
    user_id: str,
    *,
    count_only: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> tuple[str, dict]:
    """
    Build a parameterised SQL string + params dict for the scraper AI search.
    Returns (sql_string, params_dict).
    """

    # Resolve safe sort / order values (whitelist to prevent injection)
    sort_col = spec.sort_by if spec.sort_by in _ALLOWED_SORT else "scraped_at"
    sort_ord = spec.sort_order.lower() if spec.sort_order.lower() in _ALLOWED_ORDER else "desc"

    params: dict[str, Any] = {
        "rb_uid": user_id,
        "jmr_uid": user_id,
        "jmip_uid": user_id,
        "ujs_uid": user_id,
    }

    # ── SELECT + FROM + JOINs ────────────────────────────────────────────────
    if count_only:
        select_part = "SELECT COUNT(*)"
    else:
        select_part = (
            "SELECT sj.*, "
            "LOWER(je.status::text) AS extraction_status, "
            "vj.id AS job_id, "
            "rb.resume_docx_status AS resume_build_status, "
            "rb.content_generation_status AS content_generation_status, "
            "jmr.overall_score AS match_score, "
            "CASE WHEN jmip.id IS NOT NULL THEN TRUE ELSE FALSE END AS match_in_progress, "
            "CASE WHEN ujs.id IS NOT NULL AND ujs.status != 'active' THEN TRUE ELSE FALSE END AS is_excluded_for_user"
        )

    sql = (
        f"{select_part} "
        "FROM scraped_jobs sj "
        "LEFT JOIN jobs vj ON vj.id = COALESCE( "
        "  (SELECT v2.id FROM jobs v2 "
        "   WHERE v2.extraction_id = sj.promoted_extraction_id LIMIT 1), "
        "  (SELECT v2.id FROM jobs v2 "
        "   WHERE v2.normalized_url = COALESCE(sj.origin_url, sj.url) "
        "   AND v2.status = 'active' ORDER BY v2.updated_at DESC LIMIT 1) "
        ") "
        "LEFT JOIN job_extractions je ON je.id = sj.promoted_extraction_id "
        "LEFT JOIN resume_build_results rb "
        "  ON rb.job_id = vj.id AND rb.user_id = :rb_uid "
        "LEFT JOIN job_match_results jmr "
        "  ON jmr.job_id = vj.id AND jmr.user_id = :jmr_uid "
        "LEFT JOIN job_match_in_progress jmip "
        "  ON jmip.job_id = vj.id AND jmip.user_id = :jmip_uid "
        "LEFT JOIN user_job_status ujs "
        "  ON ujs.job_id = vj.id AND ujs.user_id = :ujs_uid "
        "WHERE (vj.id IS NULL OR ujs.id IS NULL OR ujs.status = 'active')"
    )

    # Tracks per-phrase parameter index to guarantee unique param names
    _idx = [0]

    def _next_idx() -> str:
        _idx[0] += 1
        return str(_idx[0])

    # ── Full-text filters ────────────────────────────────────────────────────

    if spec.must_contain_all:
        for phrase in spec.must_contain_all:
            p = phrase.strip()
            if not p:
                continue
            pk = f"mca{_next_idx()}"
            sql += f" AND ({_ALL_TEXT_EXPR}) ILIKE :{pk}"
            params[pk] = f"%{p}%"

    if spec.must_contain_any:
        clauses = []
        for phrase in spec.must_contain_any:
            p = phrase.strip()
            if not p:
                continue
            pk = f"mcy{_next_idx()}"
            clauses.append(f"({_ALL_TEXT_EXPR}) ILIKE :{pk}")
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.must_not_contain:
        for phrase in spec.must_not_contain:
            p = phrase.strip()
            if not p:
                continue
            pk = f"mnc{_next_idx()}"
            sql += f" AND NOT ({_ALL_TEXT_EXPR}) ILIKE :{pk}"
            params[pk] = f"%{p}%"

    # ── Field-specific text filters ──────────────────────────────────────────

    def _field_any(field_expr: str, phrases: list[str], label: str) -> None:
        clauses = []
        for phrase in phrases:
            p = phrase.strip()
            if not p:
                continue
            pk = f"{label}{_next_idx()}"
            clauses.append(f"COALESCE({field_expr},'') ILIKE :{pk}")
            params[pk] = f"%{p}%"
        if clauses:
            nonlocal sql
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.title_contains_any:
        clauses = []
        for phrase in spec.title_contains_any:
            p = phrase.strip()
            if not p:
                continue
            pk = f"tit{_next_idx()}"
            clauses.append(
                f"(COALESCE(sj.title,'') ILIKE :{pk} OR COALESCE(je.title,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.company_contains_any:
        clauses = []
        for phrase in spec.company_contains_any:
            p = phrase.strip()
            if not p:
                continue
            pk = f"cmp{_next_idx()}"
            clauses.append(
                f"(COALESCE(sj.company_name,'') ILIKE :{pk} OR COALESCE(vj.company,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.location_contains_any:
        clauses = []
        for phrase in spec.location_contains_any:
            p = phrase.strip()
            if not p:
                continue
            pk = f"loc{_next_idx()}"
            clauses.append(
                f"(COALESCE(sj.location,'') ILIKE :{pk} "
                f"OR COALESCE(vj.location,'') ILIKE :{pk} "
                f"OR COALESCE(je.location,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.description_contains_any:
        _field_any(
            "sj.description || ' ' || COALESCE(vj.description,'') || ' ' || COALESCE(je.description,'')",
            spec.description_contains_any, "desc"
        )

    if spec.tags_contain_any:
        _field_any("sj.tags", spec.tags_contain_any, "tag")

    # ── Job attribute filters ─────────────────────────────────────────────────

    if spec.job_type_any:
        clauses = []
        for jt in spec.job_type_any:
            p = jt.strip()
            if not p:
                continue
            pk = f"jt{_next_idx()}"
            clauses.append(f"COALESCE(sj.job_type,'') ILIKE :{pk}")
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.experience_level_any:
        clauses = []
        for lvl in spec.experience_level_any:
            p = lvl.strip()
            if not p:
                continue
            pk = f"exp{_next_idx()}"
            clauses.append(
                f"(COALESCE(sj.experience_level,'') ILIKE :{pk} "
                f"OR COALESCE(je.experience_level,'') ILIKE :{pk} "
                f"OR COALESCE(vj.experience_level,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.industry_any:
        clauses = []
        for ind in spec.industry_any:
            p = ind.strip()
            if not p:
                continue
            pk = f"ind{_next_idx()}"
            clauses.append(
                f"(COALESCE(vj.industry,'') ILIKE :{pk} "
                f"OR COALESCE(je.industry,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.source_any:
        # Exact match on scraper source slug (case-insensitive)
        clauses = []
        for src in spec.source_any:
            p = src.strip()
            if not p:
                continue
            pk = f"src{_next_idx()}"
            clauses.append(f"LOWER(sj.source) = :{pk}")
            params[pk] = p.lower()
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    # ── Remote / location ────────────────────────────────────────────────────

    if spec.is_remote is True:
        sql += " AND sj.is_remote = TRUE"
    elif spec.is_remote is False:
        sql += " AND sj.is_remote = FALSE"

    if spec.remote_policy_any:
        clauses = []
        for rp in spec.remote_policy_any:
            p = rp.strip()
            if not p:
                continue
            pk = f"rp{_next_idx()}"
            clauses.append(
                f"(COALESCE(je.remote_policy,'') ILIKE :{pk} "
                f"OR COALESCE(sj.location,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    # ── Salary ───────────────────────────────────────────────────────────────

    if spec.salary_contains_any:
        clauses = []
        for sal in spec.salary_contains_any:
            p = sal.strip()
            if not p:
                continue
            pk = f"sal{_next_idx()}"
            clauses.append(
                f"(COALESCE(sj.salary_raw,'') ILIKE :{pk} "
                f"OR COALESCE(je.salary_range,'') ILIKE :{pk})"
            )
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.min_salary_k is not None:
        sql += " AND sj.salary_min_cents >= :min_sal_cents"
        params["min_sal_cents"] = spec.min_salary_k * 1000 * 100  # k → cents

    if spec.max_salary_k is not None:
        sql += " AND (sj.salary_max_cents IS NULL OR sj.salary_max_cents <= :max_sal_cents)"
        params["max_sal_cents"] = spec.max_salary_k * 1000 * 100

    # ── Pipeline / processing status ─────────────────────────────────────────

    if spec.has_extraction is True:
        sql += " AND sj.promoted_extraction_id IS NOT NULL"
    elif spec.has_extraction is False:
        sql += " AND sj.promoted_extraction_id IS NULL"

    if spec.extraction_completed_only:
        sql += " AND LOWER(je.status::text) = 'completed'"

    if spec.has_match_score is True:
        sql += " AND jmr.overall_score IS NOT NULL"
    elif spec.has_match_score is False:
        sql += " AND jmr.overall_score IS NULL"

    if spec.min_match_score is not None:
        sql += " AND jmr.overall_score >= :min_score"
        params["min_score"] = spec.min_match_score

    if spec.max_match_score is not None:
        sql += " AND jmr.overall_score <= :max_score"
        params["max_score"] = spec.max_match_score

    if spec.recommendation_any:
        clauses = []
        for rec in spec.recommendation_any:
            p = rec.strip()
            if not p:
                continue
            pk = f"rec{_next_idx()}"
            clauses.append(f"COALESCE(jmr.recommendation,'') ILIKE :{pk}")
            params[pk] = f"%{p}%"
        if clauses:
            sql += f" AND ({' OR '.join(clauses)})"

    if spec.has_resume is True:
        sql += " AND rb.resume_docx_status = 'completed'"
    elif spec.has_resume is False:
        sql += " AND (rb.resume_docx_status IS NULL OR rb.resume_docx_status <> 'completed')"

    # ── Recency ───────────────────────────────────────────────────────────────

    if spec.posted_within_days is not None:
        sql += f" AND sj.posted_at >= NOW() - INTERVAL '{int(spec.posted_within_days)} days'"

    if spec.scraped_within_days is not None:
        sql += f" AND sj.scraped_at >= NOW() - INTERVAL '{int(spec.scraped_within_days)} days'"

    # ── ORDER BY / LIMIT (data query only) ───────────────────────────────────

    if not count_only:
        if sort_col == "match_score":
            sql += " ORDER BY jmr.overall_score DESC NULLS LAST, sj.scraped_at DESC NULLS LAST"
        elif sort_col == "posted_at":
            sql += f" ORDER BY sj.posted_at {sort_ord.upper()} NULLS LAST, sj.scraped_at DESC NULLS LAST"
        else:
            sql += f" ORDER BY sj.scraped_at {sort_ord.upper()} NULLS LAST"

        sql += " LIMIT :lim OFFSET :off"
        params["lim"] = limit
        params["off"] = offset

    return sql, params


# ---------------------------------------------------------------------------
# Main search function
# ---------------------------------------------------------------------------

def _serialize_row(row: dict) -> dict:
    """Convert a DB mapping row into a JSON-safe dict for the frontend."""
    import datetime

    def _iso(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, (datetime.datetime, datetime.date)):
            return v.isoformat()
        return v  # already a string

    return {
        "id":                    row.get("id"),
        "url":                   row.get("url"),
        "origin_url":            row.get("origin_url"),
        "title":                 row.get("title"),
        "company_name":          row.get("company_name"),
        "location":              row.get("location"),
        "description":           row.get("description"),
        "salary_raw":            row.get("salary_raw"),
        "salary_min_cents":      row.get("salary_min_cents"),
        "salary_max_cents":      row.get("salary_max_cents"),
        "job_type":              row.get("job_type"),
        "experience_level":      row.get("experience_level"),
        "is_remote":             row.get("is_remote"),
        "tags":                  row.get("tags"),
        "source":                row.get("source"),
        "posted_at":             _iso(row.get("posted_at")),
        "scraped_at":            _iso(row.get("scraped_at")),
        "promoted_extraction_id": row.get("promoted_extraction_id"),
        "scrape_run_id":         row.get("scrape_run_id"),
        "status":                row.get("status"),
        "created_at":            _iso(row.get("created_at")),
        "updated_at":            _iso(row.get("updated_at")),
        # joined / computed columns
        "extraction_status":     row.get("extraction_status"),
        "job_id":                row.get("job_id"),
        "resume_build_status":   row.get("resume_build_status"),
        "content_generation_status": row.get("content_generation_status"),
        "match_score":           row.get("match_score"),
        "match_in_progress":     bool(row.get("match_in_progress")) if row.get("match_in_progress") is not None else False,
    }


async def apply_scraper_search_spec(
    session: AsyncSession,
    user_id: str,
    spec: ScraperJobSearchQuerySpec,
    *,
    limit: int = 200,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """
    Execute the AI search spec against the database.
    Returns (list_of_scraped_job_dicts, total_matching_count).
    """
    data_sql, data_params = _build_scraper_search_sql(
        spec, user_id, count_only=False, limit=limit, offset=offset
    )
    count_sql, count_params = _build_scraper_search_sql(
        spec, user_id, count_only=True
    )

    result = await session.execute(text(data_sql), data_params)
    rows = result.mappings().all()

    count_result = await session.execute(text(count_sql), count_params)
    total = count_result.scalar() or 0

    jobs = []
    for row in rows:
        try:
            jobs.append(_serialize_row(dict(row)))
        except Exception as e:
            logger.warning("scraper_ai_search_row_parse_error", error=str(e))
            continue

    return jobs, total
