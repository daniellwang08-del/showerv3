"""Score a tailored resume against its job with the platform's vector engine.

The tailored resume is encoded in memory the same way a profile is and scored
against the job's stored encoding, so the number is comparable to the job's
match score. Nothing is written to the database.

"Resume fit" is the part of the score a rewrite controls: the skills and
experience dimensions. Title similarity, industry, education and preferences
follow from the career facts and settings, which tailoring keeps.

The "requirement match rate" is the number tailoring drives to its target: the
share of the posting's skills named inside role bullets, averaged with the
share of its requirement and responsibility lines that a bullet covers.
Lines about facts tailoring cannot change (degree, years, certifications,
work authorization, benefits) are listed separately and left out of the rate.
"""

from __future__ import annotations

import re

from app.core.logging import get_logger
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.resume_tailoring import BOILERPLATE_RE
from app.services.required_skills import CORE, PREFERRED, REQUIRED, lexicon_hits, posting_sections
from app.utils.resume_evidence import is_mentioned

logger = get_logger(__name__)

FIT_DIMENSIONS = ("skills_match", "experience_match")

REQUIREMENT_MATCH_TARGET = 98
# all-MiniLM-L6-v2 cosine between a posting line and one bullet. Bullets that do the work score
# 0.45 to 0.8; unrelated bullets stay under 0.4.
LINE_MATCH_SIMILARITY = 0.45
# A line whose technologies all appear in the experience needs only a loosely related bullet.
NAMED_LINE_SIMILARITY = 0.35
_MAX_REQUIREMENT_LINES = 24

_STRUCTURED_HEADINGS = ("key requirements", "key responsibilities")
_FACT_LINE_RE = re.compile(
    r"\b(?:degree|bachelor|master'?s|ph\.?\s?d|diploma|\d+\+?\s*(?:years?|yrs)|years? of (?:professional )?"
    r"experience|certifi\w*|clearance|citizen\w*|authori[sz]ed to work|work authori[sz]ation|visa|sponsor\w*|"
    r"relocat\w*|travel|salary|compensation|benefits|pto|paid time off|holidays?|401\s?\(?k|insurance|"
    r"department of defense|dod|public sector|government|"
    r"consulting|professional services|side projects?|open[- ]source contributions?|hackathons?)\b",
    re.IGNORECASE,
)
_QUESTION_HEADING_RE = re.compile(r"^(?:what|who|why|how|where|when)\b", re.IGNORECASE)
# Soft skills show in work as verbs: "explained" and "presented" demonstrate communication.
_TRAIT_STEMS = {
    "commun": ("commun", "explai", "presen", "articu", "convey"),
    "collab": ("collab", "partne", "cooper"),
    "solve": ("proble", "solvin", "solved", "troubl", "resolv", "diagno", "debugg"),
    "clear": ("clarit", "clearl", "concis"),
    "mentor": ("mentor", "coach"),
    "owner": ("owners", "owned", "owning"),
    "drive": ("drive", "drives", "drivin", "drove", "proact"),
}
_TRAIT_OF = {prefix: trait for trait, prefixes in _TRAIT_STEMS.items() for prefix in prefixes}
_BULLET_RE = re.compile(r"^[\-\*\u2022]\s*")
_SMALL_WORDS = frozenset({"a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "you", "your", "with"})
# Words every requirement line uses; they say nothing about the work.
_FILLER_WORDS = frozenset(
    {
        "ability", "able", "abilities", "experience", "experienced", "strong", "excellent", "solid", "proven",
        "track", "record", "skills", "skill", "knowledge", "familiarity", "familiar", "understanding",
        "working", "work", "hands", "including", "related", "etc", "using", "across", "other", "such",
        "plus", "preferred", "required", "ideal", "candidate", "deep", "good", "great", "comfortable",
        "demonstrated", "years", "year", "role", "team", "teams", "within", "will", "who", "can", "are",
        "have", "has", "be", "is", "that", "this", "their", "our", "we", "they", "as", "by", "from", "into",
        "make", "use", "used", "see", "how", "them", "well", "properly", "proper", "fast", "quickly", "where",
        "appropriate", "genuine", "clear", "real", "what", "when", "not", "because", "wanted", "asked",
        "knack", "ideas", "idea",
    }
)
# Share of a line's key words one bullet must use for the line to count as covered by wording alone.
# Long lines carry more incidental words, so they need a smaller share.
WORDING_OVERLAP = 0.6
LONG_LINE_WORDING_OVERLAP = 0.5
_LONG_LINE_KEYS = 8
# A short trait list ("troubleshooting, communication, and presentation skills") may spread over
# several bullets, as long as every trait is shown somewhere in the experience.
_TRAIT_LIST_KEYS = 6


def _is_heading(line: str) -> bool:
    words = re.findall(r"[A-Za-z][\w'\u2019-]*", line)
    if not words or len(words) > 8 or line.rstrip().endswith((".", "!", "?")):
        return False
    if _QUESTION_HEADING_RE.match(line):
        return True
    return all(w[0].isupper() for w in words if w.lower() not in _SMALL_WORDS) and not lexicon_hits(line)


def _stems(text: str) -> set[str]:
    out: set[str] = set()
    for tok in re.findall(r"[a-z][a-z0-9+#]*", text.lower().replace("**", "")):
        if len(tok) > 2 and tok not in _FILLER_WORDS and tok not in _SMALL_WORDS:
            out.add(_TRAIT_OF.get(tok[:6], tok[:6]))
    return out


def _wording_covered(line: str, units: list[set[str]], ignore: set[str]) -> bool:
    keys = _stems(line) - ignore
    if len(keys) < 2:
        return False
    share = LONG_LINE_WORDING_OVERLAP if len(keys) > _LONG_LINE_KEYS else WORDING_OVERLAP
    if any(len(keys & u) >= share * len(keys) for u in units):
        return True
    return len(keys) <= _TRAIT_LIST_KEYS and keys <= set().union(*units)


def _posting_company(structured_context: str) -> str:
    for line in str(structured_context or "").splitlines():
        if line.strip().lower().startswith("company:"):
            return line.split(":", 1)[1].strip()
    return ""


def _clean_line(line: str) -> str:
    return " ".join(_BULLET_RE.sub("", line.strip()).split())


def posting_requirements(structured_context: str, job_text: str) -> tuple[list[str], list[str]]:
    """(lines tailoring must cover, fact lines it cannot change).

    The extractor's requirement and responsibility lists come first; without them, the posting's
    requirement and preference sections, then its bulleted lines.
    """
    lines: list[str] = []
    section = False
    for raw in str(structured_context or "").splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.lower().startswith(_STRUCTURED_HEADINGS):
            section = True
        elif section and s.startswith("- "):
            lines.append(_clean_line(s))
        elif not s.startswith("- "):
            section = False
    if not lines:
        sections = posting_sections(job_text)
        listed = [line for kind, line in sections if kind in (REQUIRED, PREFERRED)]
        if not listed:
            listed = [line for kind, line in sections if kind == CORE and _BULLET_RE.match(line)]
        if not listed:
            # Prose postings and recruiter emails: their sentences; outreach and benefits drop below.
            listed = [line for kind, line in sections if kind == CORE and len(line.split()) >= 6]
        lines = [_clean_line(line) for line in listed]
    tasks: list[str] = []
    facts: list[str] = []
    seen: set[str] = set()
    for line in lines:
        key = line.lower()
        if key in seen or len(line.split()) < 3 or len(line) > 320 or line.endswith(":") or _is_heading(line):
            continue
        if BOILERPLATE_RE.search(line):
            continue
        seen.add(key)
        (facts if _FACT_LINE_RE.search(line) else tasks).append(line)
    return tasks[:_MAX_REQUIREMENT_LINES], facts


def _experience_units(resume: dict) -> list[str]:
    out: list[str] = []
    for e in resume.get("work_experience") or []:
        if not isinstance(e, dict):
            continue
        out.append(str(e.get("project_description") or ""))
        out += [str(b) for b in e.get("bullets") or [] if isinstance(b, str)]
    return [u.replace("**", "").strip() for u in out if u and u.strip()]


async def requirement_match(
    resume: dict | None,
    *,
    skills: list[str],
    structured_context: str,
    job_text: str,
) -> dict:
    """{"rate", "skill_coverage", "line_coverage", "missing_skills", "uncovered_lines", "fact_lines"}."""
    from app.services.encoding_service import encode_texts_async

    tasks, facts = posting_requirements(structured_context, job_text)
    units = _experience_units(resume or {})
    prose = "\n".join(units)
    missing = [t for t in skills if not is_mentioned(t, prose)]
    skill_cov = 1.0 if not skills else (len(skills) - len(missing)) / len(skills)

    uncovered = list(tasks)
    if tasks and units:
        sims = (await encode_texts_async(tasks)) @ (await encode_texts_async(units)).T
        unit_stems = [_stems(u) for u in units]
        ignore = _stems(_posting_company(structured_context))
        uncovered = []
        for line, row in zip(tasks, sims):
            named = [t for t in skills if is_mentioned(t, line)]
            floor = NAMED_LINE_SIMILARITY if named and all(t not in missing for t in named) else LINE_MATCH_SIMILARITY
            if float(row.max()) < floor and not _wording_covered(line, unit_stems, ignore):
                uncovered.append(line)
    line_cov = 1.0 if not tasks else (len(tasks) - len(uncovered)) / len(tasks)
    return {
        "rate": int(round(100 * (skill_cov + line_cov) / 2)),
        "skill_coverage": round(skill_cov, 3),
        "line_coverage": round(line_cov, 3),
        "missing_skills": missing,
        "uncovered_lines": uncovered,
        "fact_lines": facts,
    }


def resume_fit(dims: dict) -> int | None:
    weights = {k: MATCH_DIMENSION_WEIGHTS[k] for k in FIT_DIMENSIONS}
    if not all(isinstance(dims.get(k), (int, float)) for k in weights):
        return None
    return int(round(sum(dims[k] * w for k, w in weights.items()) / sum(weights.values())))


def tailored_work_experience(resume: dict) -> list[dict]:
    out: list[dict] = []
    for e in resume.get("work_experience") or []:
        if not isinstance(e, dict):
            continue
        out.append(
            {
                "company_name": e.get("company_name") or "",
                "job_title": e.get("job_title") or "",
                "period_start": e.get("period_start") or "",
                "period_end": e.get("period_end") or "",
                "location": e.get("location") or "",
                "project_title": e.get("project_name") or "",
                "project_intro": str(e.get("project_description") or "").replace("**", ""),
                "used_skills": e.get("used_skills") or "",
                "contributions": [str(b).replace("**", "") for b in e.get("bullets") or [] if isinstance(b, str)],
            }
        )
    return out


async def _job_encoding(job_id: str):
    from sqlalchemy import select
    from sqlalchemy.orm import undefer

    from app.models.database import JobEncoding
    from app.storage.database import get_session

    async with get_session() as session:
        row = (
            await session.execute(
                select(JobEncoding).options(undefer("*")).where(JobEncoding.job_id == job_id)
            )
        ).scalar_one_or_none()
        if row is not None:
            session.expunge(row)
        return row


async def _education(user_id: str | None) -> list:
    if not user_id:
        return []
    from sqlalchemy import select

    from app.models.database import User
    from app.storage.database import get_session

    async with get_session() as session:
        raw = (await session.execute(select(User.education).where(User.id == user_id))).scalar_one_or_none()
    return list(raw or [])


async def score_tailored_resume(
    job_id: str | None, resume: dict | None, tailored_profile_text: str, *, user_id: str | None = None
) -> dict | None:
    """{"overall", "resume_fit", "dimensions", "gaps"} for the tailored resume, None when it cannot be scored."""
    if not job_id or not resume:
        return None
    try:
        from app.models.database import UserEncoding
        from app.services.encoding_service import build_domain_proxy_text, build_user_encoding
        from app.services.vector_match_service import score_pair_v5

        job_enc = await _job_encoding(job_id)
        if job_enc is None:
            return None
        work = tailored_work_experience(resume)
        education = await _education(user_id)
        skills = ", ".join(
            str(r.get("skills") or "") for r in resume.get("technical_skills") or [] if isinstance(r, dict)
        )
        fields = await build_user_encoding(
            profile_text=tailored_profile_text,
            work_experience=work,
            education=education,
            prefs_text="",
            domain_text=build_domain_proxy_text(work, education),
            profile_title=work[0]["job_title"] if work else None,
            profile_summary=str(resume.get("profile_summary") or "").replace("**", ""),
            technical_skills=skills,
        )
        if fields.get("model_version") != job_enc.model_version:
            return None
        user_enc = UserEncoding(user_id=user_id or "tailored", **fields)
        result = await score_pair_v5(job_enc, user_enc)
    except Exception as e:  # noqa: BLE001 - the check is advisory; tailoring must not fail on it
        logger.warning("tailored_match_check_failed", job_id=job_id, error=str(e)[:300])
        return None
    dims = result.get("dimension_scores") or {}
    return {
        "overall": result.get("overall_score"),
        "resume_fit": resume_fit(dims),
        "dimensions": dims,
        "gaps": [g for g in result.get("gaps") or [] if isinstance(g, str)][:6],
    }
