"""
AI-powered job-profile match analysis (two-phase).

Phase A: validation + structured extraction + match scoring.
Phase B: tailored resume JSON + cover letter (deferred).
"""

import json
import re

from app.core.config import get_settings
from app.core.llm_client import (
    chat_completion_with_empty_retry,
    get_llm_client_for_user,
    response_message_meta,
)
from app.core.logging import get_logger
from app.core.exceptions import AIParsingError
from app.services.system_settings_service import get_effective_value_sync
from app.prompts.job_match_phase_a_prompt import (
    JOB_MATCH_PHASE_A_SYSTEM_PROMPT,
    JOB_MATCH_PHASE_A_USER_TEMPLATE,
    MATCH_DIMENSION_WEIGHTS,
)
from app.prompts.job_match_phase_b_prompt import (
    JOB_MATCH_PHASE_B_SYSTEM_PROMPT,
    JOB_MATCH_PHASE_B_USER_TEMPLATE,
)
from app.models.schemas import JobDescriptionSchema
from app.services.job_field_utils import (
    clean_optional_job_field,
    infer_title_from_description,
    parse_job_title,
)
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
MAX_EVIDENCE_LENGTH = 15000

_MATCH_DIMENSION_KEYS = tuple(MATCH_DIMENSION_WEIGHTS.keys())

EMPTY_MATCH_RESULT = {
    "overall_score": 0,
    "dimension_scores": {k: 0 for k in _MATCH_DIMENSION_KEYS},
    "summary": "No candidate profile provided. Please add your profile to analyze job match.",
    "strengths": [],
    "gaps": ["Missing candidate profile"],
    "recommendation": "poor_match",
    "requires_security_clearance": False,
}

_WORK_MODES = frozenset({"remote", "hybrid", "onsite", "unknown"})


def _zero_match_result(summary: str, *, requires_security_clearance: bool = False) -> dict:
    return {
        "overall_score": 0,
        "dimension_scores": {k: 0 for k in _MATCH_DIMENSION_KEYS},
        "summary": summary,
        "strengths": [],
        "gaps": [],
        "recommendation": "poor_match",
        "requires_security_clearance": requires_security_clearance,
    }


def _compute_overall_score(dimension_scores: dict[str, int]) -> int:
    total = 0.0
    for key, weight in MATCH_DIMENSION_WEIGHTS.items():
        total += dimension_scores.get(key, 0) * weight
    return max(0, min(100, round(total)))


def _normalize_work_mode(value) -> str:
    if value is None:
        return "unknown"
    mode = str(value).strip().lower()
    if mode in _WORK_MODES:
        return mode
    if "hybrid" in mode:
        return "hybrid"
    if "remote" in mode or "wfh" in mode or "work from home" in mode:
        return "remote"
    if "onsite" in mode or "on-site" in mode or "in-office" in mode or "in office" in mode:
        return "onsite"
    return "unknown"


def _format_job_preferences_text(preferences: str | None) -> str:
    text = (preferences or "").strip()
    if not text:
        return (
            "No specific preferences provided. Score the user_preferences dimension at 50 (neutral) "
            "and mention in the summary that preferences were not configured."
        )
    return text


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
    if structured_job.remote_policy:
        parts.append(f"Remote policy: {structured_job.remote_policy}")
    if structured_job.work_mode:
        parts.append(f"Work mode: {structured_job.work_mode}")
    if structured_job.requirements:
        parts.append("\nKey requirements (prioritize these in tailored content):")
        for req in structured_job.requirements[:15]:
            if isinstance(req, str) and req.strip():
                parts.append(f"- {req.strip()}")
    if structured_job.responsibilities:
        parts.append("\nKey responsibilities (mirror language where truthful):")
        for resp in structured_job.responsibilities[:15]:
            if isinstance(resp, str) and resp.strip():
                parts.append(f"- {resp.strip()}")
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

    updates: dict = {}
    description = _normalize_description_formatting(structured_job.description or "")
    if description and description != structured_job.description:
        updates["description"] = description

    title = clean_optional_job_field(structured_job.title)
    if not title:
        inferred = infer_title_from_description(description or structured_job.description)
        updates["title"] = inferred or "Unknown Position"
    elif title != structured_job.title:
        updates["title"] = title

    if not updates:
        return structured_job
    return structured_job.model_copy(update=updates)


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


def _parse_match_section(parsed: dict, *, recompute_overall: bool = True) -> dict:
    dims_raw = parsed.get("dimension_scores", {})
    dims: dict[str, int] = {}
    if isinstance(dims_raw, dict):
        for key in _MATCH_DIMENSION_KEYS:
            try:
                dims[key] = max(0, min(100, int(round(float(dims_raw.get(key, 0))))))
            except (TypeError, ValueError):
                dims[key] = 0
    else:
        dims = {k: 0 for k in _MATCH_DIMENSION_KEYS}

    overall = _compute_overall_score(dims) if recompute_overall else max(
        0, min(100, int(parsed.get("overall_score", 0)))
    )

    raw_gaps = list(parsed.get("gaps", [])) if isinstance(parsed.get("gaps"), list) else []
    gaps: list[str] = []
    for g in raw_gaps:
        if isinstance(g, str):
            t = g.strip()
            if t:
                gaps.append(t)

    return {
        "overall_score": overall,
        "dimension_scores": dims,
        "summary": str(parsed.get("summary", "")).strip() or "No summary provided.",
        "strengths": list(parsed.get("strengths", [])) if isinstance(parsed.get("strengths"), list) else [],
        "gaps": gaps,
        "recommendation": parsed.get("recommendation") or "moderate_match",
        "requires_security_clearance": False,
    }


def _parse_structured_job_section(parsed: dict) -> JobDescriptionSchema | None:
    try:
        description = str(parsed.get("description", "")).strip()
        if not description:
            description = "No description available"
        title = parse_job_title(parsed.get("title"))
        work_mode = _normalize_work_mode(parsed.get("work_mode"))
        if work_mode == "unknown" and parsed.get("remote_policy"):
            work_mode = _normalize_work_mode(parsed.get("remote_policy"))

        return JobDescriptionSchema(
            title=title,
            company=clean_optional_job_field(parsed.get("company")),
            location=clean_optional_job_field(parsed.get("location")),
            employment_type=clean_optional_job_field(parsed.get("employment_type")),
            salary_range=clean_optional_job_field(parsed.get("salary_range")),
            description=description,
            responsibilities=_list_of_strings(parsed.get("responsibilities")),
            requirements=_list_of_strings(parsed.get("requirements")),
            benefits=_list_of_strings(parsed.get("benefits")),
            work_mode=work_mode,
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
                raw_us = entry.get("used_skills")
                used_skills = str(raw_us).strip() if raw_us not in (None, "", "None", "null") else None

                # Immutable factual fields copied verbatim from the profile so the
                # tailored content is self-sufficient for structured autofill
                # (Workday etc. needs dates + location). Empty period_end = current.
                def _clean_factual(v):
                    s = str(v).strip() if v not in (None, "None", "null") else ""
                    return s or None

                period_start = _clean_factual(entry.get("period_start"))
                period_end = _clean_factual(entry.get("period_end"))
                location = _clean_factual(entry.get("location"))
                employment_type = _clean_factual(entry.get("employment_type"))
                role_index = len(experience)
                min_bullets = 7 if role_index < 3 else 4
                if len(bullets) < min_bullets:
                    logger.warning(
                        "tailored_resume_bullet_count_below_minimum",
                        company=company,
                        role_index=role_index,
                        bullet_count=len(bullets),
                        minimum=min_bullets,
                    )
                experience.append({
                    "company_name": company,
                    "job_title": title,
                    "period_start": period_start,
                    "period_end": period_end,
                    "location": location,
                    "employment_type": employment_type,
                    "project_name": project_name or None,
                    "project_description": project_desc or None,
                    "used_skills": used_skills or None,
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


def _job_anchor_terms(*text_blobs: str, limit: int = 24) -> list[str]:
    """Extract distinctive job terms used to verify the tailored resume is job-specific.

    Prefers hyphenated/tech tokens and multi-word requirement fragments over stopwords.
    """
    stop = {
        "and", "the", "for", "with", "you", "your", "our", "are", "will", "this", "that",
        "from", "have", "has", "been", "using", "use", "used", "ability", "experience",
        "years", "year", "team", "work", "working", "role", "job", "including", "etc",
        "strong", "good", "preferred", "required", "requirements", "responsibilities",
        "knowledge", "skills", "plus", "must", "able", "across", "into", "about",
    }
    found: list[str] = []
    seen: set[str] = set()

    def _add(term: str) -> None:
        t = term.strip(" .,;:/\\|\"'`()[]{}").strip()
        if len(t) < 3:
            return
        key = t.lower()
        if key in seen or key in stop:
            return
        seen.add(key)
        found.append(t)

    for blob in text_blobs:
        text = str(blob or "")
        if not text:
            continue
        # Bullet-like requirement lines often carry the highest-signal phrases.
        for line in text.splitlines():
            s = line.strip()
            if s.startswith(("-", "*", "•")):
                phrase = re.sub(r"^[\-\*•]\s*", "", s)
                phrase = re.sub(r"\s+", " ", phrase).strip()
                if 3 <= len(phrase) <= 48:
                    _add(phrase)
        for m in re.finditer(r"\b[A-Za-z][A-Za-z0-9.+#/-]{2,}\b", text):
            _add(m.group(0))
        if len(found) >= limit:
            break
    return found[:limit]


def tailored_resume_quality_issues(
    resume: dict | None,
    *,
    job_anchor_terms: list[str] | None = None,
) -> list[str]:
    """Return soft quality problems that warrant one Phase B regeneration retry.

    Does not reject the payload forever — callers may still accept after retry.
    """
    if not resume or not isinstance(resume, dict):
        return ["missing_tailored_resume"]
    issues: list[str] = []
    summary = str(resume.get("profile_summary") or "").strip()
    if len(summary) < 40:
        issues.append("profile_summary_too_short")
    skills = resume.get("technical_skills") or []
    if not isinstance(skills, list) or len(skills) < 1:
        issues.append("technical_skills_missing")
    experience = resume.get("work_experience") or []
    if not isinstance(experience, list) or len(experience) < 1:
        issues.append("work_experience_missing")
        return issues
    recent_blob_parts = [summary.lower()]
    for idx, entry in enumerate(experience):
        if not isinstance(entry, dict):
            issues.append(f"work_experience[{idx}]_invalid")
            continue
        bullets = entry.get("bullets") or []
        if not isinstance(bullets, list):
            bullets = []
        clean = [b for b in bullets if isinstance(b, str) and b.strip()]
        minimum = 7 if idx < 3 else 4
        if len(clean) < minimum:
            issues.append(f"work_experience[{idx}]_bullets_below_{minimum}")
        # Soft invent/keyword signal: almost no markdown emphasis across many bullets.
        if idx < 3 and len(clean) >= minimum:
            emphasized = sum(1 for b in clean if "**" in b)
            if emphasized == 0:
                issues.append(f"work_experience[{idx}]_no_keyword_emphasis")
        if idx < 3:
            recent_blob_parts.append(str(entry.get("project_description") or "").lower())
            recent_blob_parts.extend(b.lower() for b in clean)
            for sk in skills:
                if isinstance(sk, dict):
                    recent_blob_parts.append(str(sk.get("skills") or "").lower())
                    recent_blob_parts.append(str(sk.get("category") or "").lower())

    anchors = [a for a in (job_anchor_terms or []) if isinstance(a, str) and a.strip()]
    if anchors:
        blob = " ".join(recent_blob_parts)
        hits = sum(1 for term in anchors if term.lower() in blob)
        # Require real overlap with this posting; otherwise the model reused a generic draft.
        need = 3 if len(anchors) >= 6 else max(1, min(2, len(anchors)))
        if hits < need:
            issues.append("insufficient_job_keyword_alignment")
    return issues


def _parse_cover_letter(parsed: dict | None) -> dict | None:
    if not parsed or not isinstance(parsed, dict):
        return None
    body = str(parsed.get("body", "")).strip()
    if not body:
        return None
    return {"body": body}


def _response_message_meta(response: object) -> tuple[str, str | None, dict[str, int | None]]:
    """Backward-compatible alias for shared ``response_message_meta``."""
    return response_message_meta(response)


async def _call_openai_json(
    *,
    system_prompt: str,
    user_content: str,
    max_tokens: int,
    observe_name: str,
    user_id: str | None = None,
    job_type: str | None = None,
    temperature: float = 0.2,
) -> dict:
    client = await get_llm_client_for_user(user_id, job_type=job_type)
    settings = get_settings()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    try:
        result_text, _response = await chat_completion_with_empty_retry(
            client,
            observe=observe_name,
            job_type=job_type,
            model=settings.openai_model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
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
    job_preferences: str | None = None,
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

    if job_preferences is None and user_id:
        async with get_session() as session:
            user = await UserRepository(session).get_by_id(user_id)
            if user:
                job_preferences = getattr(user, "job_match_preferences", None)

    preferences_text = _format_job_preferences_text(job_preferences)

    user_content = JOB_MATCH_PHASE_A_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        job_preferences=preferences_text,
    )
    phase_a_max = max(settings.openai_max_tokens, int(get_effective_value_sync("phase_a_max_tokens")))
    phase_a_max = min(phase_a_max, 16384)

    parsed = await _call_openai_json(
        system_prompt=JOB_MATCH_PHASE_A_SYSTEM_PROMPT,
        user_content=user_content,
        max_tokens=phase_a_max,
        observe_name="phase_a",
        user_id=user_id,
        job_type="job_analysis",
    )

    requires_security_clearance = bool(parsed.get("requires_security_clearance", False))
    is_job_posting = bool(parsed.get("is_job_posting", False))

    structured_job: JobDescriptionSchema | None = None
    structured_section = parsed.get("structured_job")
    if structured_section and isinstance(structured_section, dict):
        structured_job = _parse_structured_job_section(structured_section)
        structured_job = _finalize_structured_job_description(structured_job)
    else:
        logger.warning("structured_job_section_missing_from_phase_a_response")

    if requires_security_clearance:
        match_result = _zero_match_result(
            "Requires security clearance - not scored",
            requires_security_clearance=True,
        )
    elif not is_job_posting:
        match_result = _zero_match_result("Not a job posting")
    else:
        match_section = parsed.get("match") or parsed
        match_result = _parse_match_section(match_section, recompute_overall=True)

    return match_result, structured_job, is_job_posting


@observe(name="generate_tailored_content_phase_b")
async def generate_tailored_content_phase_b(
    job_text: str,
    profile_text: str,
    *,
    structured_context: str = "",
    match_summary: str = "",
    project_evidence_context: str = "",
    user_id: str | None = None,
) -> tuple[dict | None, dict | None]:
    """
    Phase B: tailored resume JSON and cover letter body.
    Returns (tailored_resume_or_None, cover_letter_or_None).
    """
    settings = get_settings()
    job_truncated = _truncate_job_text_preserve_layout(job_text, MAX_JOB_LENGTH)
    profile_truncated = _truncate(profile_text, MAX_PROFILE_LENGTH)
    evidence_truncated = _truncate(
        project_evidence_context or "No project source evidence available.",
        MAX_EVIDENCE_LENGTH,
    )

    if not profile_truncated.strip():
        return None, None

    structured_block = structured_context or "No structured job data available."
    user_content = JOB_MATCH_PHASE_B_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        structured_context=structured_block,
        match_summary=match_summary or "No match summary available.",
        project_evidence_context=evidence_truncated,
    )
    job_anchors = _job_anchor_terms(structured_block, job_truncated)
    phase_b_max = max(settings.openai_max_tokens, int(get_effective_value_sync("phase_b_max_tokens")))
    phase_b_max = min(phase_b_max, 32768)
    # Slightly higher than Phase A: encourage job-specific wording while staying factual.
    phase_b_temperature = 0.35

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
        job_type="resume_tailoring",
        temperature=phase_b_temperature,
    )

    tailored_resume = _parse_tailored_resume(parsed.get("tailored_resume"))
    cover_letter = _parse_cover_letter(parsed.get("cover_letter"))

    quality_issues = tailored_resume_quality_issues(
        tailored_resume, job_anchor_terms=job_anchors
    )
    if quality_issues or not cover_letter:
        logger.warning(
            "phase_b_quality_soft_retry",
            issues=quality_issues,
            cover_letter_missing=not bool(cover_letter),
        )
        retry_user = (
            user_content
            + "\n\nQUALITY RETRY: Previous output failed soft checks. "
            "Ensure profile_summary is substantive and names THIS job's role/domain, "
            "technical_skills categories reflect THIS posting's stack, "
            "the first three roles each have at least 7 bullets with **keyword** emphasis "
            "on terms from THIS job description (grounded in profile/evidence facts), "
            "later roles have at least 4 bullets, and cover_letter.body is a complete letter "
            "that names this company/role when available. Never invent employers or dates. "
            "Do not reuse a generic resume draft that ignores this posting's requirements."
        )
        if job_anchors:
            retry_user += (
                "\nPriority job terms to weave in truthfully: "
                + ", ".join(job_anchors[:12])
                + "."
            )
        parsed_retry = await _call_openai_json(
            system_prompt=system_prompt,
            user_content=retry_user,
            max_tokens=phase_b_max,
            observe_name="phase_b_quality_retry",
            user_id=user_id,
            job_type="resume_tailoring",
            temperature=phase_b_temperature,
        )
        retry_resume = _parse_tailored_resume(parsed_retry.get("tailored_resume"))
        retry_cover = _parse_cover_letter(parsed_retry.get("cover_letter"))
        if retry_resume:
            tailored_resume = retry_resume
        if retry_cover:
            cover_letter = retry_cover
        remaining = tailored_resume_quality_issues(
            tailored_resume, job_anchor_terms=job_anchors
        )
        if remaining:
            logger.warning("phase_b_quality_issues_after_retry", issues=remaining)

    if not tailored_resume:
        logger.warning("tailored_resume_section_missing_or_invalid")
    if not cover_letter:
        logger.warning("cover_letter_section_missing_or_invalid")
    return tailored_resume, cover_letter
