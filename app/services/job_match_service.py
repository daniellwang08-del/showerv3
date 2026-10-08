"""
AI-powered job-profile match analysis (two-phase).

Phase A: validation + structured extraction + match scoring.
Phase B: tailored resume JSON + cover letter (deferred).
"""

import asyncio
import json
import re
from typing import Awaitable, Callable

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
from app.prompts.job_first_tailoring_prompt import JOB_FIRST_SYSTEM_PROMPT, JOB_FIRST_USER_TEMPLATE
from app.models.schemas import JobDescriptionSchema
from app.services.job_first_tailoring import (
    DEFAULT_STRATEGY,
    MAX_REWRITE_RETRIES,
    STRATEGY_JOB_FIRST,
    build_job_first_plan,
    career_facts_block,
    education_block,
    experience_skill_coverage,
    finalize_job_first_resume,
    job_first_problems,
    job_first_retry_note,
    normalize_strategy,
    tailored_resume_to_profile_text,
    target_stack_block,
)
from app.services.job_field_utils import (
    clean_optional_job_field,
    infer_title_from_description,
    parse_job_title,
)
from app.services.required_skills import (
    SkillPlan,
    ensure_required_skills,
    job_skill_terms,
    missing_from_experience,
    plan_required_skills,
    required_skills_block,
    requirement_lines,
)
from app.storage.database import get_session
from app.storage.user_repository import UserRepository
from app.utils.resume_keyword_emphasis import (
    apply_keyword_emphasis_to_resume,
    is_tech_like_keyword,
)
from app.utils.resume_evidence import (
    build_role_evidence_block,
    build_source_facts_block,
    cap_skills_section,
    copied_job_phrases,
    enforce_role_evidence,
    expand_acronyms_once,
    summary_unattributed_terms,
    summary_unheld_title,
    unattributed_role_terms,
)
from app.utils.resume_skill_taxonomy import normalize_tailored_formatting, rehome_misplaced_skills

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


def build_must_cover_requirements(
    structured_context: str = "",
    job_text: str = "",
    *,
    limit: int = 18,
) -> str:
    """Human-readable must-cover list for the Phase B user prompt: requirements first, then preferences, then duties."""
    lines = ["- " + " ".join(line.split()) for line in requirement_lines(job_text, structured_context, limit=limit)]
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
    anchors = [s.term for s in job_skill_terms("", structured_context)][:8]
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
    profile_text: str = "",
    evidence_text: str = "",
    job_text: str = "",
    claim_terms: list[str] | None = None,
    required_skills: SkillPlan | None = None,
) -> list[str]:
    """Return soft quality problems that warrant one Phase B regeneration retry.

    Does not reject the payload forever, callers may still accept after retry.
    The role-evidence checks run only when *profile_text* is given; *claim_terms*
    (all job technologies, supported or not) widens what they look for.
    """
    if not resume or not isinstance(resume, dict):
        return ["missing_tailored_resume"]
    issues: list[str] = []
    summary = str(resume.get("profile_summary") or "").strip()
    if len(summary) < 80:
        issues.append("profile_summary_too_short")
    if len(summary.replace("**", "").split()) > _MAX_SUMMARY_WORDS:
        issues.append("profile_summary_too_long")
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

    total_bullets = 0
    for idx, entry in enumerate(experience):
        if not isinstance(entry, dict):
            issues.append(f"work_experience[{idx}]_invalid")
            continue
        bullets = entry.get("bullets") or []
        if not isinstance(bullets, list):
            bullets = []
        clean = [b for b in bullets if isinstance(b, str) and b.strip()]
        total_bullets += len(clean)
        if not clean:
            issues.append(f"work_experience[{idx}]_no_bullets")
        if idx < 2 and len(clean) >= 4:
            emphasized = sum(1 for b in clean if "**" in b)
            # Bold is sparse by contract; flag only roles where it is nearly absent.
            if emphasized < max(1, len(clean) // 4):
                issues.append(f"work_experience[{idx}]_weak_keyword_emphasis")
    if total_bullets > _MAX_TOTAL_BULLETS:
        issues.append("too_many_bullets")

    if profile_text:
        terms = claim_terms if claim_terms is not None else job_anchor_terms
        for idx in unattributed_role_terms(resume, profile_text, evidence_text, terms):
            issues.append(f"work_experience[{idx}]_unattributed_technology")
        if summary_unattributed_terms(resume, profile_text, evidence_text, terms):
            issues.append("profile_summary_unattributed_technology")
        if summary_unheld_title(resume, profile_text):
            issues.append("profile_summary_unheld_title")
    if len(copied_job_phrases(resume, job_text)) >= 2:
        issues.append("copies_job_posting_phrases")
    if missing_from_experience(resume, required_skills):
        issues.append("required_skills_missing_from_experience")

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
_MAX_SUMMARY_WORDS = 90
# The prompt budgets 20-26 bullets for a senior profile; past this the resume is padded.
_MAX_TOTAL_BULLETS = 30

# Issues a second LLM call does not fix: anchors are a noisy keyword list (a rerun
# lands on the same coverage) and emphasis is applied deterministically.
_ADVISORY_QUALITY_ISSUES = frozenset(
    {"insufficient_job_keyword_alignment", "profile_summary_missing_role_domain_cues"}
)


_COVER_LETTER_MAX_TOKENS = 4096


def _is_advisory_quality_issue(issue: str) -> bool:
    return issue in _ADVISORY_QUALITY_ISSUES or issue.endswith("_weak_keyword_emphasis")


def quality_retry_instructions(
    resume: dict | None,
    blocking: list[str],
    *,
    job_anchor_terms: list[str] | None = None,
    role_domain_cues: list[str] | None = None,
    profile_text: str = "",
    evidence_text: str = "",
    job_text: str = "",
    claim_terms: list[str] | None = None,
    required_skills: SkillPlan | None = None,
) -> str:
    """Rewrite instructions naming exactly what the previous draft got wrong."""
    terms = claim_terms if claim_terms is not None else job_anchor_terms
    lines = ["QUALITY RETRY: rewrite the resume (do not lightly edit) and fix every point below."]
    entries = (resume or {}).get("work_experience") or []
    if any(i.endswith("_unattributed_technology") for i in blocking) and resume:
        for idx, bad in unattributed_role_terms(resume, profile_text, evidence_text, terms).items():
            company = entries[idx].get("company_name") if idx < len(entries) else f"role {idx}"
            lines.append(
                f"- {company}: the profile never ties {', '.join(bad)} to this role. Remove them from its "
                "bullets, project_description and used_skills; describe the work with the technologies "
                "the Role evidence map lists for it. They may stay in technical_skills."
            )
    if "profile_summary_unattributed_technology" in blocking and resume:
        bad = summary_unattributed_terms(resume, profile_text, evidence_text, terms)
        lines.append(
            f"- profile_summary claims hands-on use of {', '.join(bad)}, which no role shows. "
            "Name only technologies a dated role evidences; leave the rest to technical_skills."
        )
    if "profile_summary_unheld_title" in blocking and resume:
        title = summary_unheld_title(resume, profile_text)
        lines.append(
            f'- profile_summary opens with "{title}", a specialty or level the candidate has never held. Open '
            "with an engineering family their work supports at their own level (e.g. Senior Software "
            "Engineer) and show the fit for this role through the work, not by claiming its title."
        )
    if "required_skills_missing_from_experience" in blocking and resume:
        missing = missing_from_experience(resume, required_skills)
        lines.append(
            "- The posting requires these skills, but no bullet names them. Name each in the spelling shown in a "
            "bullet of the role shown, describing how that role's real work used it: "
            + "; ".join(f"{s.term} ({s.roles[0]})" for s in missing)
        )
    if "profile_summary_too_long" in blocking:
        lines.append(f"- profile_summary: 3-4 sentences, at most {_MAX_SUMMARY_WORDS - 15} words, no technology lists.")
    if "profile_summary_too_short" in blocking:
        lines.append("- profile_summary: 3-4 substantive sentences naming this role's title family and domain.")
    if "too_many_bullets" in blocking:
        lines.append(
            f"- Too many bullets (over {_MAX_TOTAL_BULLETS}). Follow the length budget: 6-8 for each of the two "
            "most recent roles, 4-5 for the third, 3-4 for older or short roles. Merge or drop the least relevant."
        )
    if "copies_job_posting_phrases" in blocking and resume:
        copied = copied_job_phrases(resume, job_text)[:4]
        lines.append(
            "- These runs are copied from the posting; say what the candidate did in their own terms: "
            + "; ".join(f'"{c}"' for c in copied)
        )
    if any(i.startswith("technical_skills") for i in blocking):
        lines.append(
            "- technical_skills: 5-6 clean single-concept categories (e.g. Languages, Backend, Databases, "
            "Cloud, DevOps) with named technologies only: no soft skills, no generic labels, no **."
        )
    if any(i.endswith("_no_bullets") or i.endswith("_invalid") or i.endswith("_missing") for i in blocking):
        lines.append("- Include exactly one work_experience entry, with bullets, for every company in the profile.")
    lines.append(
        "Never invent employers, dates, metrics, scale or ownership, or technologies beyond the Required skills checklist."
    )
    return "\n".join(lines)


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


def _pick_better_tailored_resume(
    first: dict | None,
    second: dict | None,
    *,
    job_anchor_terms: list[str] | None = None,
    role_domain_cues: list[str] | None = None,
    profile_text: str = "",
    evidence_text: str = "",
    job_text: str = "",
    claim_terms: list[str] | None = None,
    required_skills: SkillPlan | None = None,
) -> dict | None:
    """Prefer the draft with fewer quality issues, then higher coverage."""
    if first and not second:
        return first
    if second and not first:
        return second
    if not first and not second:
        return None
    checks = {
        "job_anchor_terms": job_anchor_terms,
        "role_domain_cues": role_domain_cues,
        "profile_text": profile_text,
        "evidence_text": evidence_text,
        "job_text": job_text,
        "claim_terms": claim_terms,
        "required_skills": required_skills,
    }
    issues_a = tailored_resume_quality_issues(first, **checks)
    issues_b = tailored_resume_quality_issues(second, **checks)
    if len(issues_b) < len(issues_a):
        return second
    if len(issues_a) < len(issues_b):
        return first
    score_a = tailored_resume_coverage_score(first, job_anchor_terms=job_anchor_terms)
    score_b = tailored_resume_coverage_score(second, job_anchor_terms=job_anchor_terms)
    return second if score_b > score_a else first


def _structured_company(structured_context: str) -> str:
    for line in str(structured_context or "").splitlines():
        s = line.strip()
        if s.lower().startswith("company:"):
            name = s.split(":", 1)[1].strip()
            return "" if name.lower() == "unknown" else name
    return ""


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
    include_cover_letter: bool = True,
    include_resume: bool = True,
    on_stage: Callable[[str], Awaitable[None]] | None = None,
    job_id: str | None = None,
    strategy: str | None = None,
) -> tuple[dict | None, dict | None]:
    """
    Phase B: tailored resume JSON and cover letter body.
    Returns (tailored_resume_or_None, cover_letter_or_None).

    ``include_cover_letter=False`` skips the cover letter call entirely.
    ``include_resume=False`` writes only the cover letter (original résumé mode).
    ``on_stage`` is awaited with "quality_retry" when a rewrite pass starts.
    ``strategy`` overrides the user's tailoring strategy ("job_first" or "evidence");
    ``job_id`` lets job-first score the tailored resume against the job's encoding.
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
    skill_plan = plan_required_skills(
        job_skill_terms(job_truncated, structured_block, company=_structured_company(structured_block)),
        profile_truncated,
        evidence_truncated,
    )
    job_anchors = skill_plan.posting_terms
    truthful_anchors = skill_plan.supported_terms
    # Required skills the profile lacks are assigned to a role, so the evidence checks accept them there.
    evidence_checked = "\n\n".join(p for p in (evidence_truncated, skill_plan.evidence_addendum()) if p)
    # The skills cap never drops a checklist item, even one spelled out beyond the posting ("Delta Lake").
    keep_skills_text = "\n".join([job_truncated, ", ".join(truthful_anchors)])
    role_cues = _role_domain_cues_from_context(structured_block, job_truncated)
    user_content = JOB_MATCH_PHASE_B_USER_TEMPLATE.format(
        job_text=job_truncated,
        profile_text=profile_truncated,
        structured_context=structured_block,
        must_cover_requirements=must_cover,
        company_domain_cues=domain_cues,
        match_summary=match_summary or "No match summary available.",
        project_evidence_context=evidence_truncated,
        role_evidence_map=build_role_evidence_block(profile_truncated, evidence_checked, truthful_anchors),
        source_facts=build_source_facts_block(profile_truncated, evidence_truncated),
        supported_job_terms=required_skills_block(skill_plan),
    )
    checks = {
        "job_anchor_terms": truthful_anchors,
        "role_domain_cues": role_cues,
        "profile_text": profile_truncated,
        "evidence_text": evidence_checked,
        "job_text": job_truncated,
        "claim_terms": job_anchors,
        "required_skills": skill_plan,
    }
    phase_b_max = max(settings.openai_max_tokens, int(get_effective_value_sync("phase_b_max_tokens")))
    phase_b_max = min(phase_b_max, 32768)
    # Slightly higher than Phase A: encourage job-specific rewrite while staying factual.
    phase_b_temperature = 0.4

    if user_id:
        async with get_session() as session:
            repo = UserRepository(session)
            user_strategy, resume_system, cover_system = await repo.get_phase_b_bundle(user_id)
            wanted = normalize_strategy(strategy) if strategy is not None else user_strategy
            if wanted != user_strategy:
                resume_system = (
                    JOB_FIRST_SYSTEM_PROMPT
                    if wanted == STRATEGY_JOB_FIRST
                    else (await repo.get_effective_phase_b_system_prompts(user_id))[0]
                )
        strategy = wanted
    else:
        strategy = normalize_strategy(strategy or DEFAULT_STRATEGY)
        resume_system = JOB_FIRST_SYSTEM_PROMPT if strategy == STRATEGY_JOB_FIRST else PHASE_B_RESUME_SYSTEM_PROMPT
        cover_system = COVER_LETTER_SYSTEM_PROMPT

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
        if not resume:
            return None
        resume = enforce_role_evidence(resume, profile_truncated, evidence_checked)
        resume = normalize_tailored_formatting(apply_keyword_emphasis_to_resume(resume, job_anchors))
        resume = expand_acronyms_once(resume, truthful_anchors)
        if resume and resume.get("technical_skills"):
            resume["technical_skills"] = cap_skills_section(
                rehome_misplaced_skills(resume["technical_skills"]), keep_skills_text
            )
        resume = ensure_required_skills(resume, skill_plan, profile_truncated)
        if resume and resume.get("technical_skills"):
            resume["technical_skills"] = cap_skills_section(resume["technical_skills"], keep_skills_text)
        return resume

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

    async def _no_result() -> None:
        return None

    if not include_resume:
        if not include_cover_letter:
            return None, None
        cover_letter = await _cover_call("phase_b_cover_letter")
        if not cover_letter:
            cover_letter = await _cover_call("phase_b_cover_letter_retry")
        if not cover_letter:
            logger.warning("cover_letter_section_missing_or_invalid", resume="original")
        return None, cover_letter

    if strategy == STRATEGY_JOB_FIRST:
        return await _job_first_phase_b(
            job_text=job_truncated,
            profile_text=profile_truncated,
            structured_block=structured_block,
            must_cover=must_cover,
            domain_cues=domain_cues,
            role_cues=role_cues,
            resume_system=resume_system,
            cover_system=cover_system,
            user_id=user_id,
            job_id=job_id,
            include_cover_letter=include_cover_letter,
            on_stage=on_stage,
            max_tokens=phase_b_max,
            temperature=phase_b_temperature,
            reasoning_effort=reasoning_effort,
        )

    first_resume, cover_letter = await asyncio.gather(
        _resume_call(user_content, "phase_b"),
        _cover_call("phase_b_cover_letter") if include_cover_letter else _no_result(),
    )
    tailored_resume = first_resume
    cover_missing = include_cover_letter and not cover_letter

    quality_issues = tailored_resume_quality_issues(tailored_resume, **checks)
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

    if blocking or cover_missing:
        if on_stage is not None:
            try:
                await on_stage("quality_retry")
            except Exception:  # noqa: BLE001 - progress reporting must never break the run
                pass
        retry_note = quality_retry_instructions(tailored_resume, blocking, **checks)
        logger.warning(
            "phase_b_quality_soft_retry",
            issues=quality_issues,
            cover_letter_missing=cover_missing,
            supported_anchors=len(truthful_anchors),
            jd_anchors=len(job_anchors),
            coverage=coverage,
            retry_note=retry_note,
        )
        retry_user = user_content + "\n\n" + retry_note

        retry_resume, retry_cover = await asyncio.gather(
            _resume_call(retry_user, "phase_b_quality_retry") if blocking else _no_result(),
            _cover_call("phase_b_cover_letter_retry") if cover_missing else _no_result(),
        )
        if retry_cover:
            cover_letter = retry_cover
        if blocking:
            chosen = _pick_better_tailored_resume(first_resume, retry_resume, **checks)
            if chosen is not None:
                tailored_resume = chosen
            remaining = tailored_resume_quality_issues(tailored_resume, **checks)
            if any(not _is_advisory_quality_issue(i) for i in remaining):
                logger.warning(
                    "phase_b_quality_issues_after_retry",
                    issues=remaining,
                    coverage=round(recent_anchor_coverage(tailored_resume, truthful_anchors), 3),
                )

    if not tailored_resume:
        logger.warning("tailored_resume_section_missing_or_invalid")
    if cover_missing and not cover_letter:
        logger.warning("cover_letter_section_missing_or_invalid")
    return tailored_resume, cover_letter


# Worth a retry note, but a draft that covers more of the posting still wins over one without them.
_JOB_FIRST_SOFT_ISSUES = frozenset({"copies_job_posting_phrases"})


def _format_retry_lines(resume: dict | None, issues: list[str], *, anchors: list[str], job_text: str) -> list[str]:
    """The evidence path's retry wording for layout issues, without its evidence-only rules."""
    if not issues:
        return []
    note = quality_retry_instructions(resume, issues, job_anchor_terms=anchors, job_text=job_text)
    return [ln[2:] for ln in note.splitlines()[1:-1] if ln.startswith("- ")]


async def _job_first_phase_b(
    *,
    job_text: str,
    profile_text: str,
    structured_block: str,
    must_cover: str,
    domain_cues: str,
    role_cues: list[str],
    resume_system: str,
    cover_system: str,
    user_id: str | None,
    job_id: str | None,
    include_cover_letter: bool,
    on_stage: Callable[[str], Awaitable[None]] | None,
    max_tokens: int,
    temperature: float,
    reasoning_effort: str | None,
) -> tuple[dict | None, dict | None]:
    """Job-first Phase B: draft, check, and rewrite until the resume meets every rule and the match target."""
    from app.services.tailored_match_check import (
        REQUIREMENT_MATCH_TARGET,
        posting_requirements,
        requirement_match,
        score_tailored_resume,
    )

    plan = build_job_first_plan(
        job_skill_terms(job_text, structured_block, company=_structured_company(structured_block)),
        profile_text,
        job_text,
    )
    anchors = plan.terms
    tasks, _facts = posting_requirements(structured_block, job_text)
    user_content = JOB_FIRST_USER_TEMPLATE.format(
        career_facts=career_facts_block(plan),
        education=education_block(profile_text),
        job_text=job_text,
        structured_context=structured_block,
        must_cover_requirements="\n".join(f"- {t}" for t in tasks) if tasks else must_cover,
        company_domain_cues=domain_cues,
        target_stack=target_stack_block(plan),
    )

    async def draft(content: str, observe_name: str) -> dict | None:
        parsed = await _call_openai_json(
            system_prompt=resume_system,
            user_content=content,
            max_tokens=max_tokens,
            observe_name=observe_name,
            user_id=user_id,
            job_type="resume_tailoring",
            temperature=temperature,
            reasoning_effort=reasoning_effort,
        )
        resume = _parse_tailored_resume(parsed.get("tailored_resume"))
        if not resume:
            return None
        resume = normalize_tailored_formatting(apply_keyword_emphasis_to_resume(resume, anchors))
        resume = expand_acronyms_once(resume, anchors)
        if resume and resume.get("technical_skills"):
            resume["technical_skills"] = rehome_misplaced_skills(resume["technical_skills"])
        return finalize_job_first_resume(resume, plan, profile_text, job_text)

    best: dict | None = None
    best_key: tuple | None = None
    best_report: tuple[list[str], dict[str, str], dict] = ([], {}, {})
    content = user_content
    for attempt in range(1 + MAX_REWRITE_RETRIES):
        observe = "phase_b" if attempt == 0 else f"phase_b_quality_retry_{attempt}"
        try:
            resume = await draft(content, observe)
        except AIParsingError:
            if attempt == 0:
                raise
            logger.warning("job_first_retry_call_failed", attempt=attempt)
            continue
        if not resume:
            continue
        layout = [
            i
            for i in tailored_resume_quality_issues(
                resume, job_anchor_terms=anchors, role_domain_cues=role_cues, job_text=job_text
            )
            if not _is_advisory_quality_issue(i)
        ]
        problems = job_first_problems(resume, plan, profile_text)
        try:
            match = await requirement_match(
                resume, skills=plan.placeable, structured_context=structured_block, job_text=job_text
            )
        except Exception as e:  # noqa: BLE001 - the rate steers retries; the draft stands without it
            logger.warning("requirement_match_failed", error=str(e)[:300])
            match = {}
        rate = match.get("rate")
        soft = [i for i in layout if i in _JOB_FIRST_SOFT_ISSUES]
        key = (len(layout) - len(soft) + len(problems), -(rate or 0), len(soft))
        if best_key is None or key < best_key:
            best, best_key, best_report = resume, key, (layout, problems, match)
        logger.info(
            "job_first_draft",
            attempt=attempt,
            issues=layout + list(problems),
            requirement_match=rate,
            uncovered_lines=len(match.get("uncovered_lines") or []),
            coverage=experience_skill_coverage(resume, plan),
        )
        layout, problems, match = best_report
        rate = match.get("rate")
        below = rate is not None and rate < REQUIREMENT_MATCH_TARGET
        if attempt == MAX_REWRITE_RETRIES or (not layout and not problems and not below):
            break
        if on_stage is not None:
            try:
                await on_stage("quality_retry")
            except Exception:  # noqa: BLE001 - progress reporting must never break the run
                pass
        extra = _format_retry_lines(best, layout, anchors=anchors, job_text=job_text)
        uncovered = match.get("uncovered_lines") or []
        if below and uncovered:
            extra.append(
                f"Requirement match is {rate}%; the target is {REQUIREMENT_MATCH_TARGET}%. No bullet does the work of "
                "these posting lines. For each, write a bullet in one of the two most recent roles that does that "
                "work with the posting's stack, inside the role's product or domain, using the line's key words "
                "in your own sentence (never a run of 8 or more words copied from the posting): "
                + " | ".join(f'"{line}"' for line in uncovered)
            )
        previous = {k: v for k, v in best.items() if k != "match_check"}
        content = (
            user_content
            + "\n\n## Your previous draft\n"
            + json.dumps({"tailored_resume": previous}, ensure_ascii=False)
            + "\n\n"
            + job_first_retry_note(problems, extra)
        )

    if best is None:
        logger.warning("tailored_resume_section_missing_or_invalid", strategy=STRATEGY_JOB_FIRST)
    else:
        layout, problems, match = best_report
        score = await score_tailored_resume(
            job_id, best, tailored_resume_to_profile_text(best, profile_text), user_id=user_id
        )
        best["match_check"] = {
            "strategy": STRATEGY_JOB_FIRST,
            "target": REQUIREMENT_MATCH_TARGET,
            "requirement_match": match.get("rate"),
            "skill_coverage": match.get("skill_coverage", experience_skill_coverage(best, plan)),
            "line_coverage": match.get("line_coverage"),
            "missing_skills": match.get("missing_skills") or [],
            "uncovered_lines": match.get("uncovered_lines") or [],
            "fact_lines": match.get("fact_lines") or [],
            "resume_fit": score.get("resume_fit") if score else None,
            "overall": score.get("overall") if score else None,
            "open_issues": layout + list(problems),
        }

    cover_letter = None
    if include_cover_letter:
        cover_user = COVER_LETTER_USER_TEMPLATE.format(
            job_text=job_text,
            profile_text=tailored_resume_to_profile_text(best, profile_text) if best else profile_text,
            structured_context=structured_block,
            company_domain_cues=domain_cues,
            match_summary=(
                "The candidate profile above is the resume sent with this application. The letter tells the same "
                "story: the same employers, work, technologies and results, nothing it does not state."
            ),
            project_evidence_context="Not used: the candidate profile above is the resume for this application.",
        )
        for observe in ("phase_b_cover_letter", "phase_b_cover_letter_retry"):
            try:
                parsed = await _call_openai_json(
                    system_prompt=cover_system,
                    user_content=cover_user,
                    max_tokens=_COVER_LETTER_MAX_TOKENS,
                    observe_name=observe,
                    user_id=user_id,
                    job_type="resume_tailoring",
                    temperature=temperature,
                    reasoning_effort=reasoning_effort,
                )
            except AIParsingError as e:
                logger.warning("cover_letter_call_failed", observe=observe, error=str(e))
                continue
            cover_letter = _parse_cover_letter(parsed.get("cover_letter"))
            if cover_letter:
                break
        if not cover_letter:
            logger.warning("cover_letter_section_missing_or_invalid", strategy=STRATEGY_JOB_FIRST)
    return best, cover_letter
