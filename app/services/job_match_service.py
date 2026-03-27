"""
AI-powered job–profile match analysis.
Sends job description + user profile to OpenAI and returns structured match result.
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
from tenacity import retry, stop_after_attempt, wait_exponential

logger = get_logger(__name__)

MAX_JOB_LENGTH = 15000
MAX_PROFILE_LENGTH = 8000
MAX_STRUCTURED_JOB_LENGTH = 20000

STRUCTURED_JOB_SYSTEM_PROMPT = (
    "You are a precise job-posting structuring assistant. "
    "Convert raw job text into clean structured JSON. "
    "Preserve meaning; do not invent facts."
)

STRUCTURED_JOB_USER_TEMPLATE = """Extract structured job-posting data from the text below.

Return ONLY JSON with keys:
- title (string)
- company (string or null)
- location (string or null)
- employment_type (string or null)
- salary_range (string or null)
- description (string)
- responsibilities (array of strings)
- requirements (array of strings)
- benefits (array of strings)
- remote_policy (string or null)
- experience_level (string or null)
- industry (string or null)

Job text:
{job_text}
"""


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


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    reraise=True,
)
async def analyze_job_match(
    job_text: str,
    profile_text: str,
) -> dict:
    """
    Send job + profile to OpenAI and return structured match result.
    Raises AIParsingError on failure.
    """
    client: AsyncOpenAI = get_openai_client()
    settings = get_settings()

    job_truncated = _truncate(job_text, MAX_JOB_LENGTH)
    profile_truncated = _truncate(profile_text, MAX_PROFILE_LENGTH)

    if not profile_truncated.strip():
        return {
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
        }

    user_content = JOB_MATCH_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
    )

    try:
        response = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": JOB_MATCH_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.2,
            max_tokens=settings.openai_max_tokens,
            response_format={"type": "json_object"},
        )

        result_text = response.choices[0].message.content
        if not result_text:
            raise AIParsingError("Empty response from AI model")

        parsed = json.loads(result_text)

        # Validate and normalize structure
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

        return {
            "overall_score": max(0, min(100, overall)),
            "dimension_scores": {k: max(0, min(100, int(v))) for k, v in dims.items()},
            "summary": str(parsed.get("summary", "")).strip() or "No summary provided.",
            "strengths": list(parsed.get("strengths", [])) if isinstance(parsed.get("strengths"), list) else [],
            "gaps": list(parsed.get("gaps", [])) if isinstance(parsed.get("gaps"), list) else [],
            "recommendation": parsed.get("recommendation") or "moderate_match",
        }

    except json.JSONDecodeError as e:
        logger.error("job_match_json_error", error=str(e))
        raise AIParsingError(f"Failed to parse job match response: {e}")
    except Exception as e:
        logger.error("job_match_failed", error=str(e))
        raise AIParsingError(str(e))


@retry(
    stop=stop_after_attempt(2),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    reraise=True,
)
async def extract_structured_job_content(job_text: str) -> JobDescriptionSchema:
    """
    Build enhanced structured job content from already-scraped text using OpenAI.
    """
    client: AsyncOpenAI = get_openai_client()
    settings = get_settings()
    job_truncated = _truncate(job_text, MAX_STRUCTURED_JOB_LENGTH)

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": STRUCTURED_JOB_SYSTEM_PROMPT},
            {"role": "user", "content": STRUCTURED_JOB_USER_TEMPLATE.format(job_text=job_truncated)},
        ],
        temperature=0.1,
        max_tokens=settings.openai_max_tokens,
        response_format={"type": "json_object"},
    )

    result_text = response.choices[0].message.content
    if not result_text:
        raise AIParsingError("Empty structured job response from AI model")

    try:
        parsed = json.loads(result_text)
    except json.JSONDecodeError as e:
        raise AIParsingError(f"Structured job JSON parse failed: {e}")

    description = str(parsed.get("description", "")).strip()
    if not description:
        description = "No description available"

    title = str(parsed.get("title", "")).strip() or "Unknown Position"

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
