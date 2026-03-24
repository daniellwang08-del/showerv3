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
from tenacity import retry, stop_after_attempt, wait_exponential

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
