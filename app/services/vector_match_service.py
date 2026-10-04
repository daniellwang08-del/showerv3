"""Non-LLM job x profile match scoring from stored encodings.

Produces the exact Phase A match-result shape (overall_score,
dimension_scores with the same six keys, summary/strengths/gaps,
recommendation, requires_security_clearance) so post-analysis dedup,
persistence, auto-post thresholds, and the frontend work unchanged.

Pure numpy math over rows written by ``encoding_service`` - never loads the
embedding model, so it is safe to call from the analysis worker (~1-5 ms per
pair).

How a pair is scored (scorer v4):

1. Gates. A page that is not an open posting, or a role that needs a security
   clearance, scores 0.
2. Features. Role-family and specialty fit from ``role_taxonomy`` (does the
   candidate do this kind of work at all), embedding similarity of titles,
   of the whole profile, and of each posting line against each profile line,
   skill coverage from the lexicon, years and seniority gaps, and market
   overlap from ``industry_taxonomy``.
3. Dimensions. Each of the six dimensions is a small linear model over those
   features, clipped to 0-100. The coefficients were fitted to reference
   judgements by a stronger LLM on 221 real postings across 21 varied
   profiles (engineering, data, design, product, sales, marketing, finance,
   recruiting, support), validated by holding one profile out at a time.
4. Overall. The fixed MATCH_DIMENSION_WEIGHTS blend, as for the LLM engine.
"""

from __future__ import annotations

import hashlib
import json

import numpy as np
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.core.logging import get_logger
from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.encoding_service import b64_to_vec, bytes_to_matrix, bytes_to_vec
from app.services.industry_taxonomy import industry_overlap
from app.services.role_taxonomy import (
    MID_LEVEL,
    SPECIALTY_FAMILIES,
    family_affinity,
    specialty_affinity,
)
from app.services.skill_lexicon import skill_category
from app.storage.database import get_session

logger = get_logger(__name__)

SCORER_VERSION = "minilm-v4-roles-industry"

_RECOMMENDATION_THRESHOLDS = (
    (80, "strong_match"),
    (65, "good_match"),
    (50, "moderate_match"),
    (35, "weak_match"),
)

# Dimension models: score = intercept + sum(weight * feature), clipped to 0-100.
_DIMENSION_MODELS: dict[str, dict[str, float]] = {
    "job_title_similarity": {
        "intercept": -2.6,
        "role_fit": 28.2,
        "role_fit_sq": 8.2,
        "role_fit_x_title_cos": 41.7,
        "title_cos": 20.1,
        "level_above": -9.7,
        "level_below": -7.0,
        "level_far_above": 7.6,
        "level_far_below": -6.4,
    },
    "experience_match": {
        "intercept": -19.6,
        "role_fit": 46.8,
        "role_fit_sq": -15.2,
        "role_fit_x_chunk_top": 55.3,
        "years_ratio": 30.4,
        "level_above": -14.9,
        "level_below": -6.6,
        "level_far_above": 11.8,
        "level_far_below": -1.7,
    },
    "skills_match": {
        "intercept": 12.0,
        "role_fit": 21.3,
        "role_fit_sq": -7.3,
        "role_fit_x_skill_coverage": 40.7,
        "role_fit_x_chunk_top": 52.5,
        "missing_skill_area": -20.3,
        "skill_evidence": 8.0,
        "level_above": -3.1,
        "level_far_above": -2.0,
    },
    "industry_domain_match": {
        "intercept": -5.2,
        "industry_overlap": 27.0,
        "industry_unknown": 2.8,
        "domain_cos": 6.9,
        "chunk_mean": 22.4,
        "experience_cos": 66.2,
        "family_fit": 5.7,
        "skill_coverage": 27.7,
    },
    "education": {
        "intercept": 73.0,
        "role_fit": 22.0,
        "degree_required": -5.4,
        "degree_waived": -1.9,
        "degree_missing": -30.0,
    },
    "user_preferences": {
        "intercept": 2.5,
        "role_fit": 57.7,
        "prefs_content_cos": 31.8,
        "prefs_industry_miss": -17.6,
    },
}
# The LLM engine's rule for an unset preference: neutral, never inferred.
_NO_PREFERENCES_SCORE = 50

# Lexicon credit by where the posting mentions a skill.
_SKILL_IMPORTANCE = {"required": 1.0, "preferred": 0.5, "mentioned": 0.7}
# A missing skill from a category the candidate does work in.
_SAME_CATEGORY_CREDIT = 0.35
# Postings that list fewer lexicon skills than this are mostly described in
# words the lexicon does not know, so the coverage figure is discounted.
_FULL_EVIDENCE_SKILL_WEIGHT = 6.0
_CHUNK_TOP_K = 10

# Neutral stand-ins for encodings written before a signal existed.
_DEFAULT_COS = 0.3

_FAMILY_LABELS = {
    "software": "software engineering",
    "data": "data and machine learning",
    "security": "security",
    "eng_management": "engineering management",
    "solutions": "solutions and sales engineering",
    "hardware": "hardware engineering",
    "product": "product management",
    "program": "program management",
    "tech_support": "technical support",
    "design": "design",
    "sales": "sales",
    "marketing": "marketing",
    "customer": "customer success and support",
    "finance": "finance and accounting",
    "people": "people and recruiting",
    "legal": "legal",
    "operations": "operations",
}
_SPECIALTY_LABELS = {
    "backend": "backend services",
    "platform": "platform and infrastructure",
    "frontend": "frontend",
    "fullstack": "full-stack",
    "mobile": "mobile apps",
    "data_eng": "data engineering",
    "ml": "machine learning and AI",
    "data_science": "data science",
    "analytics": "analytics and business intelligence",
    "security": "security",
    "qa": "quality and test",
    "it": "IT and internal systems",
    "hardware": "hardware",
    "product_marketing": "product marketing",
    "customer_marketing": "customer marketing",
    "field_marketing": "field and partner marketing",
    "growth_marketing": "growth and demand generation",
    "content_marketing": "content, brand and communications",
    "sdr": "sales development",
    "partnerships": "partnerships and business development",
    "account_management": "account management",
    "account_executive": "closing new business",
}
_LEVEL_LABELS = {
    0.0: "intern",
    1.0: "junior or associate",
    MID_LEVEL: "mid-level",
    2.0: "senior",
    3.0: "staff, lead or manager",
    4.0: "principal or director",
    5.0: "VP or executive",
}

_POSTING_ISSUE_TEXT = {
    "closed": "the posting has been closed",
    "not_found": "the page no longer exists",
    "careers_index": "the page is a careers index, not a single posting",
}


def _cos(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    if a is None or b is None or a.size == 0 or b.size == 0 or a.size != b.size:
        return None
    # Vectors are stored L2-normalized; dot product is cosine.
    return float(np.dot(a, b))


def _recommendation(overall: int) -> str:
    for threshold, label in _RECOMMENDATION_THRESHOLDS:
        if overall >= threshold:
            return label
    return "poor_match"


def _compute_overall(dims: dict[str, int]) -> int:
    total = sum(dims.get(key, 0) * weight for key, weight in MATCH_DIMENSION_WEIGHTS.items())
    return max(0, min(100, round(total)))


def _loaded(obj, name: str):
    """Attribute value, or None when it is a deferred column that was never loaded.

    Touching an unloaded deferred column lazy-loads, which raises under an
    AsyncSession. Older callers that undefer only the original vector columns
    then score without the newer inputs instead of crashing.
    """
    try:
        state = sa_inspect(obj)
    except Exception:
        return getattr(obj, name, None)
    if name in state.unloaded:
        return None
    return getattr(obj, name, None)


def _score_skills(
    job_skills: dict[str, str], user_skills: dict[str, float]
) -> tuple[float | None, list[str], list[str], float, float]:
    """(coverage 0-1 or None, matched, missing_required, missing_area_share, evidence 0-1).

    coverage is the importance-weighted share of the posting's lexicon skills
    the profile shows, with partial credit for a missing skill in a category
    the candidate works in. missing_area_share is the weight of skills from
    categories the profile has nothing in at all (a mobile posting for a
    backend engineer). evidence says how much of the posting the lexicon could
    read; both are discounted by it.
    """
    matched = sorted(skill for skill in job_skills if skill in user_skills)
    missing_required = sorted(
        skill
        for skill, importance in job_skills.items()
        if importance == "required" and skill not in user_skills
    )
    total = sum(_SKILL_IMPORTANCE.get(i, 0.7) for i in job_skills.values())
    if not total or not user_skills:
        return None, matched, missing_required, 0.0, 0.0
    user_categories = {skill_category(skill) for skill in user_skills}
    got = 0.0
    missing_area = 0.0
    for skill, importance in job_skills.items():
        weight = _SKILL_IMPORTANCE.get(importance, 0.7)
        if skill in user_skills:
            got += weight
        elif skill_category(skill) in user_categories:
            got += weight * _SAME_CATEGORY_CREDIT
        else:
            missing_area += weight
    evidence = min(1.0, total / _FULL_EVIDENCE_SKILL_WEIGHT)
    return got / total, matched, missing_required, missing_area / total, evidence


def _best_title_cosine(
    job_title_vec: np.ndarray | None, user_title_vecs: list
) -> float | None:
    if job_title_vec is None or not user_title_vecs:
        return None
    best: float | None = None
    for item in user_title_vecs:
        vec = b64_to_vec(item.get("vec")) if isinstance(item, dict) else None
        cos = _cos(job_title_vec, vec)
        if cos is not None and (best is None or cos > best):
            best = cos
    return best


def _chunk_coverage(
    job_chunks: np.ndarray | None, user_chunks: np.ndarray | None
) -> tuple[float | None, float | None]:
    """(mean of the best-matching profile line per posting line, mean of the top 10)."""
    if job_chunks is None or user_chunks is None or not len(job_chunks) or not len(user_chunks):
        return None, None
    if job_chunks.shape[1] != user_chunks.shape[1]:
        return None, None
    best = (job_chunks @ user_chunks.T).max(axis=1)
    top = np.sort(best)[::-1][:_CHUNK_TOP_K]
    return float(best.mean()), float(top.mean())


def _years_ratio(years_required: int | None, years_experience: float | None) -> float:
    if not years_required or years_experience is None:
        return 1.0
    return min(1.0, years_experience / float(years_required))


def _level_gaps(job_level: float | None, user_signals: dict) -> tuple[float, float]:
    """(levels the job sits above the candidate, levels it sits below them).

    Only gaps beyond the noise of title wording count: one band up is a normal
    promotion step, and one band down is a normal lateral move.
    """
    if job_level is None:
        return 0.0, 0.0
    title_level = user_signals.get("level")
    years_level = user_signals.get("level_from_years")
    known = [lvl for lvl in (title_level, years_level) if lvl is not None]
    if not known:
        return 0.0, 0.0
    current = title_level if title_level is not None else years_level
    above = max(0.0, job_level - current - 0.5)
    below = max(0.0, max(known) - job_level - 1.0)
    return above, below


def _features(job_enc: JobEncoding, user_enc: UserEncoding) -> tuple[dict, dict]:
    """(model features, raw signals for the narrative and explain output)."""
    job_signals = dict(_loaded(job_enc, "signals") or {})
    user_signals = dict(_loaded(user_enc, "signals") or {})

    job_title_vec = bytes_to_vec(job_enc.title_vec)
    job_content_vec = bytes_to_vec(job_enc.content_vec)
    job_industry_vec = bytes_to_vec(_loaded(job_enc, "industry_vec"))
    experience_vec = bytes_to_vec(user_enc.experience_vec)
    prefs_vec = bytes_to_vec(_loaded(user_enc, "prefs_vec"))
    domain_vec = bytes_to_vec(_loaded(user_enc, "domain_vec"))
    dim = int(job_content_vec.size) if job_content_vec is not None else 0
    job_chunks = bytes_to_matrix(_loaded(job_enc, "chunk_vecs"), dim)
    user_chunks = bytes_to_matrix(_loaded(user_enc, "chunk_vecs"), dim)

    title_cos = _best_title_cosine(job_title_vec, list(user_enc.title_vecs or []))
    experience_cos = _cos(experience_vec, job_content_vec)
    domain_cos = _cos(domain_vec, job_industry_vec)
    chunk_mean, chunk_top = _chunk_coverage(job_chunks, user_chunks)
    prefs_content_cos = _cos(prefs_vec, job_content_vec)
    prefs_title_cos = _cos(prefs_vec, job_title_vec)

    job_skills = dict(job_enc.skills or {})
    user_skills = {k: float(v) for k, v in dict(user_enc.skills or {}).items()}
    coverage, matched, missing_required, missing_area, evidence = _score_skills(
        job_skills, user_skills
    )

    job_family = job_signals.get("family") or "other"
    job_specialty = job_signals.get("specialty") or "general"
    family_fit = family_affinity(job_family, user_signals.get("families") or [])
    specialty_fit = (
        specialty_affinity(job_specialty, user_signals.get("specialties") or {})
        if job_family in SPECIALTY_FAMILIES
        else 1.0
    )
    role_fit = family_fit * specialty_fit
    level_above, level_below = _level_gaps(job_signals.get("level"), user_signals)
    job_industries = job_signals.get("industries") or {}
    industry_fit = industry_overlap(job_industries, user_signals.get("industries"))
    preferred_industries = user_signals.get("preferred_industries") or {}
    prefs_industry_fit = industry_overlap(job_industries, preferred_industries)

    exp = experience_cos if experience_cos is not None else _DEFAULT_COS
    title = title_cos if title_cos is not None else _DEFAULT_COS
    top = chunk_top if chunk_top is not None else exp
    skill_cov = (coverage or 0.0) * evidence
    degree_required = job_enc.degree_required is True
    features = {
        "role_fit": role_fit,
        "family_fit": family_fit,
        "specialty_fit": specialty_fit,
        "title_cos": title,
        "experience_cos": exp,
        "chunk_top": top,
        "chunk_mean": chunk_mean if chunk_mean is not None else exp,
        "domain_cos": domain_cos if domain_cos is not None else exp,
        "skill_coverage": skill_cov,
        "missing_skill_area": missing_area * evidence,
        "skill_evidence": evidence,
        "years_ratio": _years_ratio(job_enc.years_required, user_enc.years_experience),
        "level_above": level_above,
        "level_below": level_below,
        # Gaps past one band are a different kind of mismatch, not more of the same.
        "level_far_above": max(0.0, level_above - 1.0),
        "level_far_below": max(0.0, level_below - 0.5),
        "degree_required": 1.0 if degree_required else 0.0,
        "degree_waived": 1.0 if job_enc.degree_required is False else 0.0,
        "degree_missing": 1.0 if degree_required and user_enc.has_degree is not True else 0.0,
        "prefs_content_cos": prefs_content_cos or 0.0,
        "prefs_title_cos": prefs_title_cos or 0.0,
        "industry_overlap": industry_fit or 0.0,
        "industry_unknown": 1.0 if industry_fit is None else 0.0,
        # Stated industries the posting is not in count against it; none stated is neutral.
        "prefs_industry_miss": (
            1.0 - (prefs_industry_fit or 0.0) if preferred_industries and job_industries else 0.0
        ),
    }
    features["role_fit_sq"] = role_fit * role_fit
    features["role_fit_x_title_cos"] = role_fit * title
    features["role_fit_x_experience_cos"] = role_fit * exp
    features["role_fit_x_chunk_top"] = role_fit * top
    features["role_fit_x_skill_coverage"] = role_fit * skill_cov
    features["role_fit_x_prefs_title_cos"] = role_fit * features["prefs_title_cos"]

    raw = {
        "job_family": job_family,
        "job_specialty": job_specialty,
        "job_level": job_signals.get("level"),
        "posting_issue": job_signals.get("posting_issue"),
        "user_families": user_signals.get("families") or [],
        "user_specialties": user_signals.get("specialties") or {},
        "user_level": user_signals.get("level"),
        "user_level_from_years": user_signals.get("level_from_years"),
        "job_industries": job_industries,
        "user_industries": user_signals.get("industries") or {},
        "preferred_industries": preferred_industries,
        "has_preferences": prefs_vec is not None,
        "matched": matched,
        "missing_required": missing_required,
        "job_skills": job_skills,
        "user_skill_count": len(user_skills),
        "cosines": {
            "experience_to_content": None if experience_cos is None else round(experience_cos, 4),
            "domain_to_industry": None if domain_cos is None else round(domain_cos, 4),
            "prefs_to_content": None if prefs_content_cos is None else round(prefs_content_cos, 4),
            "best_title": None if title_cos is None else round(title_cos, 4),
            "chunk_mean": None if chunk_mean is None else round(chunk_mean, 4),
            "chunk_top": None if chunk_top is None else round(chunk_top, 4),
        },
    }
    return features, raw


def _apply_model(model: dict[str, float], features: dict[str, float]) -> int:
    total = model.get("intercept", 0.0)
    for name, weight in model.items():
        if name != "intercept":
            total += weight * features[name]
    return int(round(max(0.0, min(100.0, total))))


def _dimension_scores(features: dict[str, float], has_preferences: bool) -> dict[str, int]:
    dims = {key: _apply_model(model, features) for key, model in _DIMENSION_MODELS.items()}
    if not has_preferences:
        dims["user_preferences"] = _NO_PREFERENCES_SCORE
    return {key: dims[key] for key in MATCH_DIMENSION_WEIGHTS}


def _level_label(level: float | None) -> str | None:
    return None if level is None else _LEVEL_LABELS.get(level)


def _build_narrative(
    overall: int,
    dims: dict[str, int],
    features: dict[str, float],
    raw: dict,
    job: JobEncoding,
    years_experience: float | None,
) -> tuple[str, list[str], list[str]]:
    strengths: list[str] = []
    gaps: list[str] = []
    job_family = raw["job_family"]
    family_label = _FAMILY_LABELS.get(job_family)
    user_family_labels = [
        _FAMILY_LABELS[f] for f in dict.fromkeys(raw["user_families"]) if f in _FAMILY_LABELS
    ]
    specialty_label = _SPECIALTY_LABELS.get(raw["job_specialty"])

    if features["family_fit"] >= 0.99 and family_label:
        strengths.append(f"Your recent roles are in the same function as this one ({family_label}).")
    elif features["family_fit"] < 0.4 and family_label and user_family_labels:
        gaps.append(
            f"This is a {family_label} role, while your recent roles are in "
            f"{' and '.join(user_family_labels[:2])}. Experience from a different function "
            "counts for little here."
        )
    if job_family in SPECIALTY_FAMILIES and specialty_label:
        if features["specialty_fit"] >= 0.9:
            strengths.append(f"Your experience is in this role's specialty ({specialty_label}).")
        elif features["specialty_fit"] < 0.5:
            gaps.append(
                f"The role focuses on {specialty_label}, which your profile shows little of."
            )

    matched = raw["matched"]
    if matched:
        strengths.append(f"Direct overlap with the posting's stack: {', '.join(matched[:8])}.")
    if raw["missing_required"]:
        gaps.append(
            "The posting lists required skills that do not appear in the profile or "
            f"attached evidence: {', '.join(raw['missing_required'][:6])}. If you have "
            "adjacent experience with these, adding it to your profile raises the skills score."
        )

    if job.years_required and years_experience is not None:
        if years_experience >= job.years_required:
            strengths.append(
                f"Meets the {job.years_required}+ years of experience requirement "
                f"(about {years_experience:.0f} years of history)."
            )
        else:
            gaps.append(
                f"The role asks for {job.years_required}+ years of experience while the "
                f"profile shows about {years_experience:.0f}."
            )

    job_level_label = _level_label(raw["job_level"])
    if features["level_above"] > 0 and job_level_label:
        gaps.append(
            f"The role is {job_level_label} level, above the level of your recent titles."
        )
    if features["level_below"] > 0 and job_level_label:
        gaps.append(
            f"The role is {job_level_label} level, well below your experience; expect to be "
            "seen as overqualified."
        )

    if features["degree_missing"]:
        gaps.append("The posting requires a degree that is not present in the profile.")

    label = _recommendation(overall).replace("_", " ")
    summary = (
        f"Deterministic match score {overall}/100 ({label}), from how closely your recent "
        "roles match this role's function and seniority, the skills your profile evidences, "
        "and line-by-line similarity of your experience to the posting."
    )
    if family_label and features["family_fit"] < 0.4:
        summary += f" This is a {family_label} role, outside your recent work."
    elif matched and raw["missing_required"]:
        summary += (
            f" Strongest signal: {len(matched)} matching skills; main gap: "
            f"{len(raw['missing_required'])} required skills not evidenced."
        )
    elif matched:
        summary += f" {len(matched)} of the posting's skills are directly evidenced."
    return summary, strengths, gaps


async def load_encodings(
    job_id: str, user_id: str
) -> tuple[JobEncoding | None, UserEncoding | None]:
    """Load encoding rows with vector blobs eagerly undeferred.

    The vector columns are ``deferred()``. Sync attribute access under
    AsyncSession raises MissingGreenlet (sqlalchemy xd2s), never "touch" them;
    undefer in the SELECT instead.
    """
    async with get_session() as session:
        job_enc = (
            await session.execute(
                select(JobEncoding)
                .options(
                    undefer(JobEncoding.title_vec),
                    undefer(JobEncoding.content_vec),
                    undefer(JobEncoding.industry_vec),
                    undefer(JobEncoding.chunk_vecs),
                )
                .where(JobEncoding.job_id == job_id)
            )
        ).scalar_one_or_none()
        user_enc = (
            await session.execute(
                select(UserEncoding)
                .options(
                    undefer(UserEncoding.experience_vec),
                    undefer(UserEncoding.prefs_vec),
                    undefer(UserEncoding.domain_vec),
                    undefer(UserEncoding.chunk_vecs),
                )
                .where(UserEncoding.user_id == user_id)
            )
        ).scalar_one_or_none()
        # Materialize deferred bytes while the session is still open so
        # score_pair can run after the context exits.
        if job_enc is not None:
            job_enc.title_vec = job_enc.title_vec
            job_enc.content_vec = job_enc.content_vec
            job_enc.industry_vec = job_enc.industry_vec
            job_enc.chunk_vecs = job_enc.chunk_vecs
        if user_enc is not None:
            user_enc.experience_vec = user_enc.experience_vec
            user_enc.prefs_vec = user_enc.prefs_vec
            user_enc.domain_vec = user_enc.domain_vec
            user_enc.chunk_vecs = user_enc.chunk_vecs
        return job_enc, user_enc


def encoding_fingerprint(job_enc: JobEncoding, user_enc: UserEncoding) -> str:
    """Stable hash over every input ``score_pair`` reads.

    Stored alongside the score so a later re-score can tell the two failure
    modes apart: same fingerprint with a different score means the scorer
    changed, a different fingerprint means the encodings moved underneath it.
    Without this the two are indistinguishable, and a tuning change cannot be
    told apart from drift.
    """
    digest = hashlib.sha256()
    for blob in (
        job_enc.title_vec,
        job_enc.content_vec,
        _loaded(job_enc, "industry_vec"),
        _loaded(job_enc, "chunk_vecs"),
        user_enc.experience_vec,
        _loaded(user_enc, "prefs_vec"),
        _loaded(user_enc, "domain_vec"),
        _loaded(user_enc, "chunk_vecs"),
    ):
        digest.update(b"\x00" if blob is None else bytes(blob))
        digest.update(b"|")
    digest.update(
        json.dumps(
            {
                "model": job_enc.model_version,
                "job_skills": dict(sorted(dict(job_enc.skills or {}).items())),
                "job_years": job_enc.years_required,
                "job_degree": job_enc.degree_required,
                "job_clearance": bool(job_enc.requires_security_clearance),
                "job_signals": _loaded(job_enc, "signals"),
                "user_skills": dict(sorted(dict(user_enc.skills or {}).items())),
                "user_years": user_enc.years_experience,
                "user_degree": user_enc.has_degree,
                "user_signals": _loaded(user_enc, "signals"),
                "user_titles": [
                    item.get("vec")
                    for item in (user_enc.title_vecs or [])
                    if isinstance(item, dict)
                ],
            },
            sort_keys=True,
            default=str,
        ).encode("utf-8")
    )
    return digest.hexdigest()


def _provenance(job_enc: JobEncoding, user_enc: UserEncoding) -> dict:
    return {
        "scorer_version": SCORER_VERSION,
        "model_version": job_enc.model_version,
        "inputs_fingerprint": encoding_fingerprint(job_enc, user_enc),
    }


def _gated_result(
    job_enc: JobEncoding,
    user_enc: UserEncoding,
    *,
    summary: str,
    gate: str,
    explain: bool,
    requires_clearance: bool,
) -> dict:
    result = {
        "overall_score": 0,
        "dimension_scores": {k: 0 for k in MATCH_DIMENSION_WEIGHTS},
        "summary": summary,
        "strengths": [],
        "gaps": [],
        "recommendation": "poor_match",
        "requires_security_clearance": requires_clearance,
        **_provenance(job_enc, user_enc),
    }
    if gate == "not_a_job_posting":
        result["is_job_posting"] = False
    if explain:
        result["explain"] = {
            "model_version": job_enc.model_version,
            "scorer_version": SCORER_VERSION,
            "gated": gate,
            "signals": {
                "requires_security_clearance": bool(job_enc.requires_security_clearance),
                "posting_issue": (_loaded(job_enc, "signals") or {}).get("posting_issue"),
                "years_required": job_enc.years_required,
                "years_experience": user_enc.years_experience,
            },
        }
    return result


def score_pair(job_enc: JobEncoding, user_enc: UserEncoding, *, explain: bool = False) -> dict:
    """Score one user x job pair from loaded encodings (sync, pure math)."""
    posting_issue = (_loaded(job_enc, "signals") or {}).get("posting_issue")
    if posting_issue:
        return _gated_result(
            job_enc,
            user_enc,
            summary=f"Not a job posting: {_POSTING_ISSUE_TEXT.get(posting_issue, posting_issue)}.",
            gate="not_a_job_posting",
            explain=explain,
            requires_clearance=False,
        )
    if job_enc.requires_security_clearance:
        return _gated_result(
            job_enc,
            user_enc,
            summary="Requires security clearance - not scored",
            gate="security_clearance",
            explain=explain,
            requires_clearance=True,
        )

    features, raw = _features(job_enc, user_enc)
    dims = _dimension_scores(features, raw["has_preferences"])
    overall = _compute_overall(dims)
    summary, strengths, gaps = _build_narrative(
        overall, dims, features, raw, job_enc, user_enc.years_experience
    )
    result = {
        "overall_score": overall,
        "dimension_scores": dims,
        "summary": summary,
        "strengths": strengths,
        "gaps": gaps,
        "recommendation": _recommendation(overall),
        "requires_security_clearance": False,
        **_provenance(job_enc, user_enc),
    }
    if explain:
        result["explain"] = {
            "model_version": job_enc.model_version,
            "scorer_version": SCORER_VERSION,
            "cosines": raw["cosines"],
            "features": {k: round(float(v), 4) for k, v in features.items()},
            "roles": {
                "job_family": raw["job_family"],
                "job_specialty": raw["job_specialty"],
                "job_level": raw["job_level"],
                "user_families": raw["user_families"],
                "user_specialties": raw["user_specialties"],
                "user_level": raw["user_level"],
                "user_level_from_years": raw["user_level_from_years"],
            },
            "skills": {
                "job_skill_count": len(raw["job_skills"]),
                "user_skill_count": raw["user_skill_count"],
                "job_skills": dict(sorted(raw["job_skills"].items())),
                "matched": raw["matched"],
                "missing_required": raw["missing_required"],
            },
            "signals": {
                "years_required": job_enc.years_required,
                "years_experience": user_enc.years_experience,
                "degree_required": job_enc.degree_required,
                "has_degree": user_enc.has_degree,
                "has_preferences": raw["has_preferences"],
                "requires_security_clearance": False,
            },
            "dimension_contributions": {
                key: {
                    "score": int(dims.get(key, 0)),
                    "weight": float(weight),
                    "weighted": round(float(dims.get(key, 0)) * float(weight), 2),
                }
                for key, weight in MATCH_DIMENSION_WEIGHTS.items()
            },
            "overall_from_weights": overall,
        }
    return result


def user_encoding_is_scorable(user_enc: UserEncoding) -> bool:
    """True when the profile carries evidence the scorer can compare.

    With no skills and no job titles there is no role function or skill
    evidence to compare, and every posting lands in the same band. That number
    looks like a judgement but is noise, so such profiles are not scored.
    """
    return bool(user_enc.skills) or bool(user_enc.title_vecs)


class ProfileTooThinError(Exception):
    """The user's encoding has no skills and no titles to match against."""


async def compute_vector_match(
    job_id: str, user_id: str, *, explain: bool = False
) -> dict | None:
    """Load encodings and score. None when encodings are missing/stale.

    Raises ``ProfileTooThinError`` when the profile cannot be scored at all.
    """
    job_enc, user_enc = await load_encodings(job_id, user_id)
    if job_enc is None or user_enc is None:
        logger.info(
            "vector_match_encodings_missing",
            job_id=job_id,
            user_id=user_id,
            have_job=job_enc is not None,
            have_user=user_enc is not None,
        )
        return None
    if not user_encoding_is_scorable(user_enc):
        logger.info("vector_match_profile_too_thin", job_id=job_id, user_id=user_id)
        raise ProfileTooThinError(user_id)
    if job_enc.model_version != user_enc.model_version:
        logger.warning(
            "vector_match_model_version_mismatch",
            job_id=job_id,
            user_id=user_id,
            job_model=job_enc.model_version,
            user_model=user_enc.model_version,
        )
        return None
    return score_pair(job_enc, user_enc, explain=explain)
