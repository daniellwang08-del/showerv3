"""
AI-powered job-profile match analysis (two-phase).

Phase A: validation + structured extraction + match scoring.
Phase B: tailored resume JSON + cover letter (deferred).
"""

import json
import re
from openai import AsyncOpenAI
from app.core.config import get_settings
from app.core.openai_client import get_openai_client_for_user
from app.core.logging import get_logger
from app.core.exceptions import AIParsingError
from app.prompts.job_match_phase_a_prompt import (
    JOB_MATCH_PHASE_A_SYSTEM_PROMPT,
    JOB_MATCH_PHASE_A_USER_TEMPLATE,
)
from app.prompts.job_match_phase_b_prompt import (
    JOB_MATCH_PHASE_B_SYSTEM_PROMPT,
    JOB_MATCH_PHASE_B_USER_TEMPLATE,
)
from app.models.schemas import JobDescriptionSchema
from app.storage.database import get_session
from app.storage.user_repository import UserRepository

try:
    from langfuse import observe  # type: ignore[import-unresolved]
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

MAX_JOB_LENGTH = 15000
MAX_PROFILE_LENGTH = 16000

EMPTY_MATCH_RESULT = {
    "overall_score": 0,
    "dimension_scores": {
        "industry_alignment": 0,
        "experience_match": 0,
        "technical_skills": 0,
        "work_environment": 0,
    },
    "summary": "No candidate profile provided. Please add your profile to analyze job match.",
    "strengths": [],
    "gaps": ["Missing candidate profile"],
    "recommendation": "poor_match",
}


def _build_job_text(
    title: str | None,
    company: str | None,
    description: str | None,
    requirements: list | None,
    responsibilities: list | None,
) -> str:
    """Build job description text from extracted fields."""
    parts: list[str] = []
    if title:
        parts.append(f"Title: {title}")
    if company:
        parts.append(f"Company: {company}")
    if description:
        parts.append(f"\nDescription:\n{description}")
    if requirements:
        parts.append("\nRequirements:")
        for r in (requirements or [])[:20]:
            if isinstance(r, str) and r.strip():
                parts.append(f"  - {r.strip()}")
    if responsibilities:
        parts.append("\nResponsibilities:")
        for r in (responsibilities or [])[:20]:
            if isinstance(r, str) and r.strip():
                parts.append(f"  - {r.strip()}")
    return "\n".join(parts) if parts else "No job details available."


def build_structured_context(structured_job: JobDescriptionSchema | None) -> str:
    if not structured_job:
        return "No structured job data available."
    parts = [
        f"Title: {structured_job.title or 'Unknown'}",
        f"Company: {structured_job.company or 'Unknown'}",
        f"Location: {structured_job.location or 'Unknown'}",
    ]
    if structured_job.experience_level:
        parts.append(f"Experience level: {structured_job.experience_level}")
    if structured_job.industry:
        parts.append(f"Industry: {structured_job.industry}")
    return "\n".join(parts)


def _truncate(text: str, max_len: int, suffix: str = "...") -> str:
    if not text or len(text) <= max_len:
        return text or ""
    text = re.sub(r"\s+", " ", text).strip()
    return text[: max_len - len(suffix)] + suffix if len(text) > max_len else text


def _truncate_job_text_preserve_layout(text: str, max_len: int, suffix: str = "...") -> str:
    """Truncate job text for LLM context while keeping paragraph/list structure."""
    if not text or len(text) <= max_len:
        return text or ""
    trimmed = text[: max_len - len(suffix)].rstrip()
    return trimmed + suffix


def _normalize_description_formatting(text: str) -> str:
    """Light post-processing so stored descriptions read professionally."""
    if not text:
        return text
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n[ \t]+", "\n", cleaned)
    cleaned = re.sub(r"\.([A-Z])", r". \1", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    lines = [ln.rstrip() for ln in cleaned.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines).strip()


def _finalize_structured_job_description(
    structured_job: JobDescriptionSchema | None,
) -> JobDescriptionSchema | None:
    """Normalize LLM-produced description formatting for display."""
    if not structured_job:
        return structured_job
    description = _normalize_description_formatting(structured_job.description or "")
    if not description:
        return structured_job
    if description == structured_job.description:
        return structured_job
    return structured_job.model_copy(update={"description": description})


def _list_of_strings(value) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
    return out


def _parse_match_section(parsed: dict) -> dict:
    overall = int(parsed.get("overall_score", 0))
    dims = parsed.get("dimension_scores", {})
    required_dims = [
        "industry_alignment",
        "experience_match",
        "technical_skills",
        "work_environment",
    ]
    for d in required_dims:
        if d not in dims:
            dims[d] = 0

    raw_gaps = list(parsed.get("gaps", [])) if isinstance(parsed.get("gaps"), list) else []
    gaps: list[str] = []
    for g in raw_gaps:
        if isinstance(g, str):
            t = g.strip()
            if t:
                gaps.append(t)

    return {
        "overall_score": max(0, min(100, overall)),
        "dimension_scores": {k: max(0, min(100, int(v))) for k, v in dims.items()},
        "summary": str(parsed.get("summary", "")).strip() or "No summary provided.",
        "strengths": list(parsed.get("strengths", [])) if isinstance(parsed.get("strengths"), list) else [],
        "gaps": gaps,
        "recommendation": parsed.get("recommendation") or "moderate_match",
    }


def _parse_structured_job_section(parsed: dict) -> JobDescriptionSchema | None:
    try:
        description = str(parsed.get("description", "")).strip()
        if not description:
            description = "No description available"
        title = str(parsed.get("title", "")).strip() or "Unknown Position"
        return JobDescriptionSchema(
            title=title,
            company=(str(parsed["company"]).strip() if parsed.get("company") else None),
            location=(str(parsed["location"]).strip() if parsed.get("location") else None),
            employment_type=(str(parsed["employment_type"]).strip() if parsed.get("employment_type") else None),
            salary_range=(str(parsed["salary_range"]).strip() if parsed.get("salary_range") else None),
            description=description,
            responsibilities=_list_of_strings(parsed.get("responsibilities")),
            requirements=_list_of_strings(parsed.get("requirements")),
            benefits=_list_of_strings(parsed.get("benefits")),
            remote_policy=(str(parsed["remote_policy"]).strip() if parsed.get("remote_policy") else None),
            experience_level=(str(parsed["experience_level"]).strip() if parsed.get("experience_level") else None),
            industry=(str(parsed["industry"]).strip() if parsed.get("industry") else None),
        )
    except Exception as e:
        logger.warning("structured_job_section_parse_failed", error=str(e))
        return None


def _parse_tailored_resume(parsed: dict | None) -> dict | None:
    if not parsed or not isinstance(parsed, dict):
        return None
    try:
        summary = str(parsed.get("profile_summary", "")).strip()
        if not summary:
            return None

        skills_raw = parsed.get("technical_skills", [])
        skills: list[dict] = []
        if isinstance(skills_raw, list):
            for item in skills_raw:
                if isinstance(item, dict):
                    cat = str(item.get("category", "")).strip()
                    vals = str(item.get("skills", "")).strip()
                    if cat and vals:
                        skills.append({"category": cat, "skills": vals})

        exp_raw = parsed.get("work_experience", [])
        experience: list[dict] = []
        if isinstance(exp_raw, list):
            for entry in exp_raw:
                if not isinstance(entry, dict):
                    continue
                company = str(entry.get("company_name", "")).strip()
                title = str(entry.get("job_title", "")).strip()
                if not company or not title:
                    continue
                bullets = []
                for b in (entry.get("bullets") or []):
                    if isinstance(b, str) and b.strip():
                        bullets.append(b.strip())
                raw_pn = entry.get("project_name")
                project_name = str(raw_pn).strip() if raw_pn not in (None, "", "None", "null") else None
                raw_pd = entry.get("project_description")
                project_desc = str(raw_pd).strip() if raw_pd not in (None, "", "None", "null") else None
                experience.append({
                    "company_name": company,
                    "job_title": title,
                    "project_name": project_name or None,
                    "project_description": project_desc or None,
                    "bullets": bullets,
                })

        return {
            "profile_summary": summary,
            "technical_skills": skills,
            "work_experience": experience,
        }
    except Exception as e:
        logger.warning("tailored_resume_parse_failed", error=str(e))
        return None


def _parse_cover_letter(parsed: dict | None) -> dict | None:
    if not parsed or not isinstance(parsed, dict):
        return None
    body = str(parsed.get("body", "")).strip()
    if not body:
        return None
    return {"body": body}


async def _call_openai_json(
    *,
    system_prompt: str,
    user_content: str,
    max_tokens: int,
    observe_name: str,
    user_id: str | None = None,
) -> dict:
    client: AsyncOpenAI = await get_openai_client_for_user(user_id)
    settings = get_settings()
    try:
        response = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            temperature=0.2,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        result_text = response.choices[0].message.content
        if not result_text:
            raise AIParsingError("Empty response from AI model")
        return json.loads(result_text)
    except json.JSONDecodeError as e:
        logger.error("job_match_json_error", observe=observe_name, error=str(e))
        raise AIParsingError(f"Failed to parse AI response: {e}")
    except AIParsingError:
        raise
    except Exception as e:
        logger.error("job_match_openai_failed", observe=observe_name, error=str(e))
        raise AIParsingError(str(e))


@observe(name="analyze_job_match_phase_a")
async def analyze_job_match_phase_a(
    job_text: str,
    profile_text: str,
    *,
    user_id: str | None = None,
) -> tuple[dict, JobDescriptionSchema | None, bool]:
    """
    Phase A: validation, structured job extraction, and match scoring.
    Returns (match_result_dict, structured_job_or_None, is_job_posting).
    """
    settings = get_settings()
    job_truncated = _truncate_job_text_preserve_layout(job_text, MAX_JOB_LENGTH)
    profile_truncated = _truncate(profile_text, MAX_PROFILE_LENGTH)

    if not profile_truncated.strip():
        return dict(EMPTY_MATCH_RESULT), None, False

    user_content = JOB_MATCH_PHASE_A_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
    )
    phase_a_max = max(settings.openai_max_tokens, settings.phase_a_max_tokens)
    phase_a_max = min(phase_a_max, 16384)

    parsed = await _call_openai_json(
        system_prompt=JOB_MATCH_PHASE_A_SYSTEM_PROMPT,
        user_content=user_content,
        max_tokens=phase_a_max,
        observe_name="phase_a",
        user_id=user_id,
    )

    is_job_posting = bool(parsed.get("is_job_posting", False))
    match_section = parsed.get("match") or parsed
    match_result = _parse_match_section(match_section)

    structured_job: JobDescriptionSchema | None = None
    structured_section = parsed.get("structured_job")
    if structured_section and isinstance(structured_section, dict):
        structured_job = _parse_structured_job_section(structured_section)
        structured_job = _finalize_structured_job_description(structured_job)
    else:
        logger.warning("structured_job_section_missing_from_phase_a_response")

    return match_result, structured_job, is_job_posting


@observe(name="generate_tailored_content_phase_b")
async def generate_tailored_content_phase_b(
    job_text: str,
    profile_text: str,
    *,
    structured_context: str = "",
    match_summary: str = "",
    user_id: str | None = None,
) -> tuple[dict | None, dict | None]:
    """
    Phase B: tailored resume JSON and cover letter body.
    Returns (tailored_resume_or_None, cover_letter_or_None).
    """
    settings = get_settings()
    job_truncated = _truncate_job_text_preserve_layout(job_text, MAX_JOB_LENGTH)
    profile_truncated = _truncate(profile_text, MAX_PROFILE_LENGTH)

    if not profile_truncated.strip():
        return None, None

    user_content = JOB_MATCH_PHASE_B_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        structured_context=structured_context or "No structured job data available.",
        match_summary=match_summary or "No match summary available.",
    )
    phase_b_max = max(settings.openai_max_tokens, settings.phase_b_max_tokens)
    phase_b_max = min(phase_b_max, 32768)

    if user_id:
        async with get_session() as session:
            user_repo = UserRepository(session)
            system_prompt = await user_repo.get_effective_resume_tailoring_system_prompt(user_id)
    else:
        system_prompt = JOB_MATCH_PHASE_B_SYSTEM_PROMPT

    parsed = await _call_openai_json(
        system_prompt=system_prompt,
        user_content=user_content,
        max_tokens=phase_b_max,
        observe_name="phase_b",
        user_id=user_id,
    )

    tailored_resume = _parse_tailored_resume(parsed.get("tailored_resume"))
    cover_letter = _parse_cover_letter(parsed.get("cover_letter"))
    if not tailored_resume:
        logger.warning("tailored_resume_section_missing_or_invalid")
    if not cover_letter:
        logger.warning("cover_letter_section_missing_or_invalid")
    return tailored_resume, cover_letter
