"""
AI-powered job-profile match analysis.
A single OpenAI call produces both the match scoring and the structured job content.
"""

import json
import re
from openai import AsyncOpenAI
from app.core.config import get_settings
from app.core.openai_client import get_openai_client
from app.core.logging import get_logger
from app.core.exceptions import AIParsingError
from app.prompts.job_match_prompt import JOB_MATCH_SYSTEM_PROMPT, JOB_MATCH_USER_TEMPLATE
from app.models.schemas import JobDescriptionSchema

logger = get_logger(__name__)

MAX_JOB_LENGTH = 15000
MAX_PROFILE_LENGTH = 8000


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


def _truncate(text: str, max_len: int, suffix: str = "...") -> str:
    """Truncate text to max length."""
    if not text or len(text) <= max_len:
        return text or ""
    text = re.sub(r"\s+", " ", text).strip()
    return text[: max_len - len(suffix)] + suffix if len(text) > max_len else text


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
    """Validate and normalize the match section of the combined response."""
    overall = int(parsed.get("overall_score", 0))
    dims = parsed.get("dimension_scores", {})
    required_dims = [
        "role_fit",
        "skills_match",
        "experience_level",
        "education_certifications",
        "location_work_style",
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
    """Build a JobDescriptionSchema from the structured_job section. Returns None on failure."""
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


async def analyze_job_match(
    job_text: str,
    profile_text: str,
) -> tuple[dict, JobDescriptionSchema | None]:
    """
    Single LLM call that returns both the match result and structured job content.
    Returns (match_result_dict, structured_job_or_None).
    Raises AIParsingError on complete failure.
    """
    client: AsyncOpenAI = get_openai_client()
    settings = get_settings()

    job_truncated = _truncate(job_text, MAX_JOB_LENGTH)
    profile_truncated = _truncate(profile_text, MAX_PROFILE_LENGTH)

    if not profile_truncated.strip():
        return (
            {
                "overall_score": 0,
                "dimension_scores": {
                    "role_fit": 0,
                    "skills_match": 0,
                    "experience_level": 0,
                    "education_certifications": 0,
                    "location_work_style": 0,
                },
                "summary": "No candidate profile provided. Please add your profile to analyze job match.",
                "strengths": [],
                "gaps": ["Missing candidate profile"],
                "recommendation": "poor_match",
            },
            None,
        )

    user_content = JOB_MATCH_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
    )

    # Budget for match narrative gaps + structured job fields in one response.
    combined_max_tokens = max(settings.openai_max_tokens, 8192)
    combined_max_tokens = min(combined_max_tokens, 16384)

    try:
        response = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": JOB_MATCH_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.2,
            max_tokens=combined_max_tokens,
            response_format={"type": "json_object"},
        )

        result_text = response.choices[0].message.content
        if not result_text:
            raise AIParsingError("Empty response from AI model")

        parsed = json.loads(result_text)

        # Extract the two sections from the combined response.
        match_section = parsed.get("match") or parsed
        structured_section = parsed.get("structured_job")

        match_result = _parse_match_section(match_section)

        structured_job: JobDescriptionSchema | None = None
        if structured_section and isinstance(structured_section, dict):
            structured_job = _parse_structured_job_section(structured_section)
        else:
            logger.warning("structured_job_section_missing_from_combined_response")

        return match_result, structured_job

    except json.JSONDecodeError as e:
        logger.error("job_match_json_error", error=str(e))
        raise AIParsingError(f"Failed to parse job match response: {e}")
    except AIParsingError:
        raise
    except Exception as e:
        logger.error("job_match_failed", error=str(e))
        raise AIParsingError(str(e))
