"""
AI-powered job-profile match analysis (two-phase).

Phase A: validation + structured extraction + match scoring.
Phase B: tailored resume JSON + cover letter (deferred).
"""

import asyncio
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
    COVER_LETTER_SYSTEM_PROMPT,
    COVER_LETTER_USER_TEMPLATE,
    JOB_MATCH_PHASE_B_USER_TEMPLATE,
    PHASE_B_RESUME_SYSTEM_PROMPT,
)
from app.models.schemas import JobDescriptionSchema
from app.services.job_field_utils import (
    clean_optional_job_field,
    infer_title_from_description,
    parse_job_title,
)
from app.storage.database import get_session
from app.storage.user_repository import UserRepository
from app.utils.resume_keyword_emphasis import (
    apply_keyword_emphasis_to_resume,
    is_tech_like_keyword,
)

logger = get_logger(__name__)

MAX_JOB_LENGTH = 15000
MAX_PROFILE_LENGTH = 16000
MAX_EVIDENCE_LENGTH = 15000
MAX_SOURCE_DOCS_SCORING_LENGTH = 12000
MAX_CUSTOM_GUIDANCE_LENGTH = 4000
MAX_SOURCE_DOCS_FOR_SCORING = 12

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
            "and mention in the summary that preferences were not configured. "
            "Ignore any remote/hybrid/onsite preference even if mentioned elsewhere."
        )
    return text


def _format_custom_guidance_text(
    *,
    prompt_mode: str | None,
    prompt_custom: str | None,
) -> str:
    """Only user-authored custom guidance counts for scoring (not the default Phase B template)."""
    mode = (prompt_mode or "default").strip().lower()
    custom = (prompt_custom or "").strip()
    if mode == "custom" and custom:
        return _truncate(custom, MAX_CUSTOM_GUIDANCE_LENGTH)
    return (
        "No custom guidance provided. Do not invent preference constraints beyond "
        "Candidate Job Preferences and the profile/documents."
    )


def _format_source_documents_for_scoring(docs: list) -> str:
    """Compact attached-document evidence for Phase A (no extra LLM call)."""
    if not docs:
        return (
            "No attached source documents available. Score using Candidate Profile and "
            "preferences only; do not invent project evidence."
        )

    from app.services.profile_evidence_service import structured_doc_to_text

    sections: list[str] = []
    per_doc_budget = max(800, MAX_SOURCE_DOCS_SCORING_LENGTH // min(len(docs), MAX_SOURCE_DOCS_FOR_SCORING))
    for doc in docs[:MAX_SOURCE_DOCS_FOR_SCORING]:
        company = (getattr(doc, "company_name", None) or "").strip()
        filename = (getattr(doc, "filename", None) or "document").strip()
        body = structured_doc_to_text(doc).strip()
        if not body:
            continue
        header = f"### {company or 'Unknown company'} - {filename}"
        sections.append(f"{header}\n{_truncate(body, per_doc_budget)}")

    if not sections:
        return (
            "No usable structured content in attached source documents. "
            "Score using Candidate Profile and preferences only."
        )
    return _truncate("\n\n".join(sections), MAX_SOURCE_DOCS_SCORING_LENGTH)


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
                if role_index < 2:
                    min_bullets = 8
                elif role_index == 2:
                    min_bullets = 7
                else:
                    min_bullets = 4
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


_SOFT_SKILL_TERMS = frozenset(
    {
        "leadership",
        "communication",
        "teamwork",
        "collaboration",
        "collaborative",
        "problem-solving",
        "problem solving",
        "ownership",
        "mentorship",
        "mentoring",
        "stakeholder management",
        "agile",
        "scrum",
        "kanban",
        "cross-functional",
        "best practices",
        "soft skills",
    }
)

_GENERIC_SKILL_CATEGORIES = frozenset(
    {
        "skills",
        "technical skills",
        "other",
        "miscellaneous",
        "general",
        "soft skills",
        "core skills",
    }
)


def _min_bullets_for_role(role_index: int) -> int:
    if role_index < 2:
        return 8
    if role_index == 2:
        return 7
    return 4


def _job_anchor_terms(*text_blobs: str, limit: int = 32) -> list[str]:
    """Extract distinctive job terms used to verify the tailored resume is job-specific.

    Prefers tech-like tokens and short requirement fragments over soft stopwords.
    """
    stop = {
        "and", "the", "for", "with", "you", "your", "our", "are", "will", "this", "that",
        "from", "have", "has", "been", "using", "use", "used", "ability", "experience",
        "years", "year", "team", "work", "working", "role", "job", "including", "etc",
        "strong", "good", "preferred", "required", "requirements", "responsibilities",
        "knowledge", "skills", "plus", "must", "able", "across", "into", "about",
        "leadership", "communication", "collaboration", "agile", "scrum",
    }
    found: list[str] = []
    seen: set[str] = set()

    def _add(term: str) -> None:
        t = term.strip(" .,;:/\\|\"'`()[]{}").strip()
        if len(t) < 2:
            return
        key = t.lower()
        if key in seen or key in stop:
            return
        if not is_tech_like_keyword(t) and " " not in t:
            return
        if not is_tech_like_keyword(t):
            return
        seen.add(key)
        found.append(t)

    for blob in text_blobs:
        text = str(blob or "")
        if not text:
            continue
        for line in text.splitlines():
            s = line.strip()
            if s.startswith(("-", "*", "•")):
                phrase = re.sub(r"^[\-\*•]\s*", "", s)
                phrase = re.sub(r"\s+", " ", phrase).strip()
                if 3 <= len(phrase) <= 48:
                    _add(phrase)
        for m in re.finditer(r"\b[A-Za-z][A-Za-z0-9.+#/-]{1,}\b", text):
            _add(m.group(0))
        if len(found) >= limit:
            break
    return found[:limit]


def build_must_cover_requirements(
    structured_context: str = "",
    job_text: str = "",
    *,
    limit: int = 18,
) -> str:
    """Human-readable must-cover list for the Phase B user prompt."""
    lines: list[str] = []
    seen: set[str] = set()

    def _push(raw: str) -> None:
        s = re.sub(r"\s+", " ", str(raw or "").strip())
        if not s or len(s) < 3:
            return
        key = s.lower()
        if key in seen:
            return
        seen.add(key)
        lines.append(f"- {s}")

    for blob in (structured_context, job_text):
        text = str(blob or "")
        in_reqs = False
        for line in text.splitlines():
            stripped = line.strip()
            lower = stripped.lower()
            if lower.startswith("key requirements") or lower.startswith("requirements"):
                in_reqs = True
                continue
            if lower.startswith("key responsibilities") or lower.startswith("responsibilities"):
                in_reqs = True
                continue
            if stripped.startswith("- ") or stripped.startswith("* ") or stripped.startswith("• "):
                _push(re.sub(r"^[\-\*•]\s*", "", stripped))
                if len(lines) >= limit:
                    return "\n".join(lines)
            elif in_reqs and stripped and not stripped.endswith(":"):
                # End of list section when a new heading appears.
                if stripped[0].isalpha() and stripped.endswith(":") and len(stripped) < 40:
                    in_reqs = False
        if len(lines) >= limit:
            break

    if not lines:
        for term in _job_anchor_terms(structured_context, job_text, limit=limit):
            _push(term)
            if len(lines) >= limit:
                break
    return "\n".join(lines) if lines else "- (Derive must-cover items from the Job Description above.)"


def build_company_domain_cues(structured_context: str = "", job_text: str = "") -> str:
    """Short company/domain cue block for Phase B."""
    cues: list[str] = []
    text = f"{structured_context or ''}\n{job_text or ''}"
    for label in ("Title:", "Company:", "Industry:", "Experience level:", "Location:"):
        for line in text.splitlines():
            if line.strip().startswith(label):
                cues.append(line.strip())
                break
    # Domain-ish tokens from title/industry lines.
    anchors = _job_anchor_terms(structured_context, limit=8)
    if anchors:
        cues.append("Stack / domain signals: " + ", ".join(anchors[:8]))
    return "\n".join(cues) if cues else "Infer company and domain cues from the Job Description."


def _resume_text_blob(resume: dict) -> str:
    parts: list[str] = [str(resume.get("profile_summary") or "")]
    for sk in resume.get("technical_skills") or []:
        if isinstance(sk, dict):
            parts.append(str(sk.get("category") or ""))
            parts.append(str(sk.get("skills") or ""))
    for entry in resume.get("work_experience") or []:
        if not isinstance(entry, dict):
            continue
        parts.append(str(entry.get("project_description") or ""))
        parts.append(str(entry.get("used_skills") or ""))
        for b in entry.get("bullets") or []:
            if isinstance(b, str):
                parts.append(b)
    return " ".join(parts).lower()


def tailored_resume_coverage_score(
    resume: dict | None,
    *,
    job_anchor_terms: list[str] | None = None,
) -> float:
    """0–1 score of how many JD tech anchors appear in the tailored resume."""
    if not resume or not isinstance(resume, dict):
        return 0.0
    anchors = [a for a in (job_anchor_terms or []) if isinstance(a, str) and a.strip()]
    if not anchors:
        return 0.0
    blob = _resume_text_blob(resume)
    hits = sum(1 for term in anchors if term.lower() in blob)
    return hits / max(len(anchors), 1)


def tailored_resume_quality_issues(
    resume: dict | None,
    *,
    job_anchor_terms: list[str] | None = None,
    role_domain_cues: list[str] | None = None,
) -> list[str]:
    """Return soft quality problems that warrant one Phase B regeneration retry.

    Does not reject the payload forever, callers may still accept after retry.
    """
    if not resume or not isinstance(resume, dict):
        return ["missing_tailored_resume"]
    issues: list[str] = []
    summary = str(resume.get("profile_summary") or "").strip()
    if len(summary) < 80:
        issues.append("profile_summary_too_short")
    skills = resume.get("technical_skills") or []
    if not isinstance(skills, list) or len(skills) < 1:
        issues.append("technical_skills_missing")
    else:
        soft_hits = 0
        generic_cats = 0
        for item in skills:
            if not isinstance(item, dict):
                continue
            cat = str(item.get("category") or "").strip().lower()
            vals = str(item.get("skills") or "").strip().lower()
            if cat in _GENERIC_SKILL_CATEGORIES:
                generic_cats += 1
            blob = f"{cat} {vals}"
            for soft in _SOFT_SKILL_TERMS:
                if soft in blob:
                    soft_hits += 1
                    break
        if soft_hits >= 2:
            issues.append("technical_skills_contain_soft_jargon")
        if generic_cats >= 2:
            issues.append("technical_skills_categories_too_generic")

    experience = resume.get("work_experience") or []
    if not isinstance(experience, list) or len(experience) < 1:
        issues.append("work_experience_missing")
        return issues

    for idx, entry in enumerate(experience):
        if not isinstance(entry, dict):
            issues.append(f"work_experience[{idx}]_invalid")
            continue
        bullets = entry.get("bullets") or []
        if not isinstance(bullets, list):
            bullets = []
        clean = [b for b in bullets if isinstance(b, str) and b.strip()]
        minimum = _min_bullets_for_role(idx)
        if len(clean) < minimum:
            issues.append(f"work_experience[{idx}]_bullets_below_{minimum}")
        if idx < 2 and len(clean) >= max(4, minimum - 2):
            emphasized = sum(1 for b in clean if "**" in b)
            # Require bold on a majority of recent-role bullets.
            if emphasized < max(3, (len(clean) + 1) // 2):
                issues.append(f"work_experience[{idx}]_weak_keyword_emphasis")
        elif idx == 2 and len(clean) >= minimum:
            emphasized = sum(1 for b in clean if "**" in b)
            if emphasized == 0:
                issues.append(f"work_experience[{idx}]_no_keyword_emphasis")

    cues = [c for c in (role_domain_cues or []) if isinstance(c, str) and c.strip()]
    if cues and summary:
        summary_l = summary.lower()
        if not any(c.lower() in summary_l for c in cues):
            issues.append("profile_summary_missing_role_domain_cues")

    anchors = [a for a in (job_anchor_terms or []) if isinstance(a, str) and a.strip()]
    # Callers pass only anchors the candidate's own profile supports, so most of
    # them belong in the summary, recent roles and skills. Too few to judge: skip.
    if len(anchors) >= _MIN_SUPPORTED_ANCHORS:
        if recent_anchor_coverage(resume, anchors) < _SUPPORTED_ANCHOR_COVERAGE:
            issues.append("insufficient_job_keyword_alignment")
    return issues


_MIN_SUPPORTED_ANCHORS = 3
_SUPPORTED_ANCHOR_COVERAGE = 0.7

# Issues a second LLM call does not fix: anchors are a noisy keyword list (a rerun
# lands on the same coverage) and emphasis is applied deterministically.
_ADVISORY_QUALITY_ISSUES = frozenset(
    {"insufficient_job_keyword_alignment", "profile_summary_missing_role_domain_cues"}
)


_COVER_LETTER_MAX_TOKENS = 4096


def _is_advisory_quality_issue(issue: str) -> bool:
    return issue in _ADVISORY_QUALITY_ISSUES or issue.endswith(
        ("_weak_keyword_emphasis", "_no_keyword_emphasis")
    )


def recent_anchor_coverage(resume: dict | None, anchors: list[str]) -> float:
    """Share of *anchors* found in the summary, skills and three most recent roles."""
    terms = [a for a in anchors if isinstance(a, str) and a.strip()]
    if not terms or not resume or not isinstance(resume, dict):
        return 0.0
    parts = [str(resume.get("profile_summary") or "")]
    for sk in resume.get("technical_skills") or []:
        if isinstance(sk, dict):
            parts.append(str(sk.get("category") or ""))
            parts.append(str(sk.get("skills") or ""))
    for entry in (resume.get("work_experience") or [])[:3]:
        if not isinstance(entry, dict):
            continue
        parts.append(str(entry.get("project_description") or ""))
        parts.extend(b for b in entry.get("bullets") or [] if isinstance(b, str))
    blob = " ".join(parts).lower().replace("**", "")
    return sum(1 for t in terms if t.lower() in blob) / len(terms)


def supported_job_anchors(anchors: list[str], *evidence: str) -> list[str]:
    """JD anchor terms that the candidate's own material actually mentions.

    Coverage against every JD term rewards weaving in technologies the person
    never used. Measuring only the supported ones keeps the check (and the
    retry prompt) on the truthful side.
    """
    blob = " ".join(e for e in evidence if e).lower()
    return [a for a in anchors if isinstance(a, str) and a.strip() and a.lower() in blob]


def _pick_better_tailored_resume(
    first: dict | None,
    second: dict | None,
    *,
    job_anchor_terms: list[str] | None = None,
    role_domain_cues: list[str] | None = None,
) -> dict | None:
    """Prefer the draft with fewer quality issues, then higher coverage."""
    if first and not second:
        return first
    if second and not first:
        return second
    if not first and not second:
        return None
    issues_a = tailored_resume_quality_issues(
        first, job_anchor_terms=job_anchor_terms, role_domain_cues=role_domain_cues
    )
    issues_b = tailored_resume_quality_issues(
        second, job_anchor_terms=job_anchor_terms, role_domain_cues=role_domain_cues
    )
    if len(issues_b) < len(issues_a):
        return second
    if len(issues_a) < len(issues_b):
        return first
    score_a = tailored_resume_coverage_score(first, job_anchor_terms=job_anchor_terms)
    score_b = tailored_resume_coverage_score(second, job_anchor_terms=job_anchor_terms)
    return second if score_b > score_a else first


def _role_domain_cues_from_context(structured_context: str, job_text: str) -> list[str]:
    cues: list[str] = []
    for blob in (structured_context, job_text):
        for line in str(blob or "").splitlines():
            s = line.strip()
            if s.lower().startswith("title:"):
                title = s.split(":", 1)[-1].strip()
                if title and title.lower() != "unknown":
                    cues.append(title)
                    for tok in re.findall(r"[A-Za-z][A-Za-z0-9/+#.-]{2,}", title):
                        if is_tech_like_keyword(tok) or tok[0].isupper():
                            cues.append(tok)
            if s.lower().startswith("industry:"):
                industry = s.split(":", 1)[-1].strip()
                if industry and industry.lower() != "unknown":
                    cues.append(industry)
    # Dedupe preserve order
    out: list[str] = []
    seen: set[str] = set()
    for c in cues:
        key = c.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out[:12]


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


def _loads_llm_json(result_text: str) -> dict:
    """Parse model JSON; repair truncated/malformed payloads when possible."""
    try:
        parsed = json.loads(result_text)
    except json.JSONDecodeError as strict_err:
        try:
            from json_repair import repair_json as _repair_json
        except ImportError:
            raise strict_err
        try:
            repaired = _repair_json(result_text, return_objects=False)
            parsed = json.loads(repaired if isinstance(repaired, str) else json.dumps(repaired))
        except Exception as repair_err:
            raise strict_err from repair_err
    if not isinstance(parsed, dict):
        raise AIParsingError("AI response JSON must be an object")
    return parsed


async def _call_openai_json(
    *,
    system_prompt: str,
    user_content: str,
    max_tokens: int,
    observe_name: str,
    user_id: str | None = None,
    job_type: str | None = None,
    temperature: float = 0.2,
    reasoning_effort: str | None = None,
) -> dict:
    client = await get_llm_client_for_user(user_id, job_type=job_type)
    settings = get_settings()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    async def _complete(*, token_budget: int, reasoning_effort: str | None = None) -> tuple[str, object]:
        create_kwargs: dict = {
            "model": settings.openai_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": token_budget,
            "response_format": {"type": "json_object"},
        }
        if reasoning_effort:
            create_kwargs["reasoning_effort"] = reasoning_effort
        return await chat_completion_with_empty_retry(
            client,
            observe=observe_name,
            job_type=job_type,
            **create_kwargs,
        )

    try:
        result_text, response = await _complete(
            token_budget=max_tokens, reasoning_effort=reasoning_effort
        )
        try:
            return _loads_llm_json(result_text)
        except (json.JSONDecodeError, AIParsingError) as first_err:
            _content, finish_reason, usage = response_message_meta(response)
            logger.error(
                "job_match_json_error",
                observe=observe_name,
                error=str(first_err),
                finish_reason=finish_reason,
                content_chars=len(result_text or ""),
                completion_tokens=usage.get("completion_tokens"),
                reasoning_tokens=usage.get("reasoning_tokens"),
            )
            # Reasoning models often hit max_completion_tokens mid-string inside
            # structured_job.description. Retry once with a larger budget + low effort
            # and JSON repair so scores are not dropped.
            retry_budget = min(16384, max(max_tokens * 2, max_tokens + 4096))
            result_text, response = await _complete(
                token_budget=retry_budget,
                reasoning_effort="low",
            )
            try:
                parsed = _loads_llm_json(result_text)
                logger.info(
                    "job_match_json_recovered",
                    observe=observe_name,
                    retry_max_tokens=retry_budget,
                    content_chars=len(result_text or ""),
                )
                return parsed
            except (json.JSONDecodeError, AIParsingError) as second_err:
                _c2, finish2, usage2 = response_message_meta(response)
                logger.error(
                    "job_match_json_error_after_retry",
                    observe=observe_name,
                    error=str(second_err),
                    finish_reason=finish2,
                    content_chars=len(result_text or ""),
                    completion_tokens=usage2.get("completion_tokens"),
                    reasoning_tokens=usage2.get("reasoning_tokens"),
                )
                raise AIParsingError(f"Failed to parse AI response: {second_err}") from second_err
    except AIParsingError:
        raise
    except Exception as e:
        logger.error("job_match_openai_failed", observe=observe_name, error=str(e))
        raise AIParsingError(str(e))


async def analyze_job_match_phase_a(
    job_text: str,
    profile_text: str,
    *,
    user_id: str | None = None,
    job_preferences: str | None = None,
    custom_guidance: str | None = None,
    source_documents_context: str | None = None,
    job_type: str = "job_analysis",
) -> tuple[dict, JobDescriptionSchema | None, bool]:
    """
    Phase A: validation, structured job extraction, and match scoring.
    ``job_type`` picks the LLM binding (``match_quality_check`` for the second opinion).
    Returns (match_result_dict, structured_job_or_None, is_job_posting).

    Scores using profile + attached source documents + job preferences + custom guidance.
    Work mode (remote/hybrid/onsite) must not affect scores (enforced via prompt rules).
    """
    settings = get_settings()
    job_truncated = _truncate_job_text_preserve_layout(job_text, MAX_JOB_LENGTH)
    profile_truncated = _truncate(profile_text, MAX_PROFILE_LENGTH)

    if not profile_truncated.strip():
        return dict(EMPTY_MATCH_RESULT), None, False

    prompt_mode: str | None = None
    prompt_custom: str | None = None
    source_docs: list = []

    needs_user_load = user_id and (
        job_preferences is None
        or custom_guidance is None
        or source_documents_context is None
    )
    if needs_user_load:
        from app.storage.profile_source_document_repository import ProfileSourceDocumentRepository

        local_location_prefs: list[str] = []
        async with get_session() as session:
            user = await UserRepository(session).get_by_id(user_id)
            if user:
                if job_preferences is None:
                    job_preferences = getattr(user, "job_match_preferences", None)
                if custom_guidance is None:
                    prompt_mode = getattr(user, "resume_tailoring_prompt_mode", None)
                    prompt_custom = getattr(user, "resume_tailoring_prompt_custom", None)
                addr = getattr(user, "address", None) or {}
                if isinstance(addr, dict):
                    raw_prefs = addr.get("local_preferences") or []
                    if isinstance(raw_prefs, list):
                        local_location_prefs = [
                            p.strip() for p in raw_prefs if isinstance(p, str) and p.strip()
                        ]
            if source_documents_context is None:
                source_docs = await ProfileSourceDocumentRepository(session).list_completed_for_user(
                    user_id
                )
    else:
        local_location_prefs = []

    preferences_text = _format_job_preferences_text(job_preferences)
    if local_location_prefs:
        preferences_text = (
            f"{preferences_text}\n\nPreferred job locations / local preferences:\n"
            + "\n".join(f"- {p}" for p in local_location_prefs)
        )
    if custom_guidance is not None:
        guidance_text = _format_custom_guidance_text(
            prompt_mode="custom" if custom_guidance.strip() else "default",
            prompt_custom=custom_guidance,
        )
    else:
        guidance_text = _format_custom_guidance_text(
            prompt_mode=prompt_mode,
            prompt_custom=prompt_custom,
        )
    docs_text = (
        source_documents_context
        if source_documents_context is not None
        else _format_source_documents_for_scoring(source_docs)
    )

    user_content = JOB_MATCH_PHASE_A_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        source_documents_context=docs_text,
        job_preferences=preferences_text,
        custom_guidance=guidance_text,
    )
    phase_a_max = max(settings.openai_max_tokens, int(get_effective_value_sync("phase_a_max_tokens")))
    phase_a_max = min(phase_a_max, 16384)

    parsed = await _call_openai_json(
        system_prompt=JOB_MATCH_PHASE_A_SYSTEM_PROMPT,
        user_content=user_content,
        max_tokens=phase_a_max,
        observe_name="phase_a" if job_type == "job_analysis" else job_type,
        user_id=user_id,
        job_type=job_type,
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
    must_cover = build_must_cover_requirements(structured_block, job_truncated)
    domain_cues = build_company_domain_cues(structured_block, job_truncated)
    user_content = JOB_MATCH_PHASE_B_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        structured_context=structured_block,
        must_cover_requirements=must_cover,
        company_domain_cues=domain_cues,
        match_summary=match_summary or "No match summary available.",
        project_evidence_context=evidence_truncated,
    )
    job_anchors = _job_anchor_terms(structured_block, job_truncated, must_cover)
    truthful_anchors = supported_job_anchors(job_anchors, profile_truncated, evidence_truncated)
    role_cues = _role_domain_cues_from_context(structured_block, job_truncated)
    phase_b_max = max(settings.openai_max_tokens, int(get_effective_value_sync("phase_b_max_tokens")))
    phase_b_max = min(phase_b_max, 32768)
    # Slightly higher than Phase A: encourage job-specific rewrite while staying factual.
    phase_b_temperature = 0.4

    if user_id:
        async with get_session() as session:
            user_repo = UserRepository(session)
            resume_system, cover_system = await user_repo.get_effective_phase_b_system_prompts(
                user_id
            )
    else:
        resume_system, cover_system = PHASE_B_RESUME_SYSTEM_PROMPT, COVER_LETTER_SYSTEM_PROMPT

    cover_user = COVER_LETTER_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        structured_context=structured_block,
        company_domain_cues=domain_cues,
        match_summary=match_summary or "No match summary available.",
        project_evidence_context=evidence_truncated,
    )
    reasoning_effort = settings.phase_b_reasoning_effort or None

    async def _resume_call(content: str, observe_name: str) -> dict | None:
        parsed = await _call_openai_json(
            system_prompt=resume_system,
            user_content=content,
            max_tokens=phase_b_max,
            observe_name=observe_name,
            user_id=user_id,
            job_type="resume_tailoring",
            temperature=phase_b_temperature,
            reasoning_effort=reasoning_effort,
        )
        resume = _parse_tailored_resume(parsed.get("tailored_resume"))
        return apply_keyword_emphasis_to_resume(resume, job_anchors) if resume else None

    async def _cover_call(observe_name: str) -> dict | None:
        try:
            parsed = await _call_openai_json(
                system_prompt=cover_system,
                user_content=cover_user,
                max_tokens=_COVER_LETTER_MAX_TOKENS,
                observe_name=observe_name,
                user_id=user_id,
                job_type="resume_tailoring",
                temperature=phase_b_temperature,
                reasoning_effort=reasoning_effort,
            )
        except AIParsingError as e:
            logger.warning("cover_letter_call_failed", observe=observe_name, error=str(e))
            return None
        return _parse_cover_letter(parsed.get("cover_letter"))

    first_resume, cover_letter = await asyncio.gather(
        _resume_call(user_content, "phase_b"), _cover_call("phase_b_cover_letter")
    )
    tailored_resume = first_resume

    quality_issues = tailored_resume_quality_issues(
        tailored_resume,
        job_anchor_terms=truthful_anchors,
        role_domain_cues=role_cues,
    )
    blocking = [i for i in quality_issues if not _is_advisory_quality_issue(i)]
    coverage = round(recent_anchor_coverage(tailored_resume, truthful_anchors), 3)
    if quality_issues and not blocking:
        logger.info(
            "phase_b_quality_advisory",
            issues=quality_issues,
            supported_anchors=len(truthful_anchors),
            jd_anchors=len(job_anchors),
            coverage=coverage,
        )

    if blocking or not cover_letter:
        logger.warning(
            "phase_b_quality_soft_retry",
            issues=quality_issues,
            cover_letter_missing=not bool(cover_letter),
            supported_anchors=len(truthful_anchors),
            jd_anchors=len(job_anchors),
            coverage=coverage,
        )
        retry_user = (
            user_content
            + "\n\nQUALITY RETRY: Previous output failed these checks: "
            + ", ".join(blocking)
            + ". REWRITE (do not lightly edit): profile_summary must be substantive and name THIS "
            "job's role/domain; technical_skills must use JD-driven categories with technologies "
            "only (no soft-skill jargon); index 0-1 roles need at least 8 bullets each with dense "
            "**keyword** emphasis on THIS job's tech/domain terms; index 2 at least 7 bullets; "
            "older roles at least 4. Map Must-cover requirements into the two most recent roles "
            "when the background supports them. Never invent employers, dates, or technologies."
        )
        if truthful_anchors:
            retry_user += (
                "\nJob technologies/terms the candidate's background supports; "
                "surface them where the evidence is: "
                + ", ".join(truthful_anchors[:16])
                + "."
            )

        async def _no_result() -> None:
            return None

        retry_resume, retry_cover = await asyncio.gather(
            _resume_call(retry_user, "phase_b_quality_retry") if blocking else _no_result(),
            _cover_call("phase_b_cover_letter_retry") if not cover_letter else _no_result(),
        )
        if retry_cover:
            cover_letter = retry_cover
        if blocking:
            chosen = _pick_better_tailored_resume(
                first_resume,
                retry_resume,
                job_anchor_terms=truthful_anchors,
                role_domain_cues=role_cues,
            )
            if chosen is not None:
                tailored_resume = chosen
            remaining = tailored_resume_quality_issues(
                tailored_resume,
                job_anchor_terms=truthful_anchors,
                role_domain_cues=role_cues,
            )
            if any(not _is_advisory_quality_issue(i) for i in remaining):
                logger.warning(
                    "phase_b_quality_issues_after_retry",
                    issues=remaining,
                    coverage=round(recent_anchor_coverage(tailored_resume, truthful_anchors), 3),
                )

    if not tailored_resume:
        logger.warning("tailored_resume_section_missing_or_invalid")
    if not cover_letter:
        logger.warning("cover_letter_section_missing_or_invalid")
    return tailored_resume, cover_letter
