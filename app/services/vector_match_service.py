"""Non-LLM job x profile match scoring from stored encodings.

Produces the exact Phase A match-result shape (overall_score,
dimension_scores with the same six keys, summary/strengths/gaps,
recommendation, requires_security_clearance) so post-analysis dedup,
persistence, auto-post thresholds, and the frontend work unchanged.

Pure numpy math over rows written by ``encoding_service`` — never loads the
embedding model, so it is safe to call from the analysis worker (~1-5 ms per
pair).
"""

from __future__ import annotations

import numpy as np
from sqlalchemy import select

from app.core.logging import get_logger
from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.encoding_service import b64_to_vec, bytes_to_vec
from app.services.skill_lexicon import skill_category
from app.storage.database import get_session

logger = get_logger(__name__)

_IMPORTANCE_WEIGHTS = {"required": 1.0, "preferred": 0.5, "mentioned": 0.25}
_SAME_CATEGORY_CREDIT = 0.6
# Floor applied to user-skill recency weights so an old-but-real skill still
# counts substantially toward overlap.
_RECENCY_FLOOR = 0.5


def _cos(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    if a is None or b is None or a.size == 0 or b.size == 0 or a.size != b.size:
        return None
    # Vectors are stored L2-normalized; dot product is cosine.
    return float(np.dot(a, b))


def _cos_to_score(cos: float | None, points: tuple[tuple[float, float], ...]) -> int:
    """Piecewise-linear map from cosine similarity to a 0-100 score."""
    if cos is None:
        return 50
    if cos <= points[0][0]:
        return int(points[0][1])
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        if cos <= x2:
            frac = (cos - x1) / (x2 - x1) if x2 > x1 else 0.0
            return int(round(y1 + frac * (y2 - y1)))
    return int(points[-1][1])


# Calibration anchor points (cosine -> score). Starting values chosen for
# all-mpnet-base-v2 similarity ranges; shadow-mode comparisons refine them.
_EXPERIENCE_POINTS = ((0.05, 15), (0.25, 40), (0.45, 65), (0.60, 82), (0.75, 95))
_TITLE_POINTS = ((0.20, 15), (0.40, 40), (0.55, 62), (0.70, 82), (0.85, 97))
_INDUSTRY_POINTS = ((0.05, 25), (0.25, 45), (0.45, 68), (0.60, 84), (0.75, 95))
_PREFS_POINTS = ((0.05, 30), (0.20, 45), (0.40, 62), (0.55, 78), (0.70, 92))

_RECOMMENDATION_THRESHOLDS = (
    (80, "strong_match"),
    (65, "good_match"),
    (50, "moderate_match"),
    (35, "weak_match"),
)


def _recommendation(overall: int) -> str:
    for threshold, label in _RECOMMENDATION_THRESHOLDS:
        if overall >= threshold:
            return label
    return "poor_match"


def _compute_overall(dims: dict[str, int]) -> int:
    total = sum(dims.get(key, 0) * weight for key, weight in MATCH_DIMENSION_WEIGHTS.items())
    return max(0, min(100, round(total)))


def _score_skills(
    job_skills: dict[str, str], user_skills: dict[str, float]
) -> tuple[int, list[str], list[str]]:
    """(score, matched_skills, missing_required_skills)."""
    if not job_skills:
        return 50, [], []

    user_categories = {skill_category(s) for s in user_skills}
    matched: list[str] = []
    missing_required: list[str] = []
    got = 0.0
    total = 0.0
    for skill, importance in job_skills.items():
        imp_w = _IMPORTANCE_WEIGHTS.get(importance, 0.25)
        total += imp_w
        if skill in user_skills:
            recency = max(user_skills[skill], _RECENCY_FLOOR)
            got += imp_w * recency
            matched.append(skill)
        else:
            if skill_category(skill) in user_categories:
                # Adjacent-stack credit (e.g. knows MySQL, JD wants PostgreSQL)…
                got += imp_w * _SAME_CATEGORY_CREDIT
            # …but a required skill without direct evidence is still a gap.
            if importance == "required":
                missing_required.append(skill)
    if total <= 0:
        return 50, [], []
    return int(round(100 * got / total)), matched, missing_required


def _score_experience(
    job: JobEncoding, cos_experience: float | None, years_experience: float | None
) -> int:
    base = _cos_to_score(cos_experience, _EXPERIENCE_POINTS)
    years_required = job.years_required
    if years_required and years_experience is not None:
        ratio = min(1.0, years_experience / float(years_required))
        factor = 0.55 + 0.45 * ratio
        return int(round(base * factor))
    return base


def _score_title(job_title_vec: np.ndarray | None, user_title_vecs: list) -> int:
    if job_title_vec is None or not user_title_vecs:
        return 50
    best: float | None = None
    for item in user_title_vecs:
        vec = b64_to_vec(item.get("vec")) if isinstance(item, dict) else None
        cos = _cos(job_title_vec, vec)
        if cos is not None and (best is None or cos > best):
            best = cos
    return _cos_to_score(best, _TITLE_POINTS)


def _score_education(job: JobEncoding, has_degree: bool | None) -> int:
    if job.degree_required is True:
        if has_degree is True:
            return 90
        if has_degree is None:
            return 55
        return 30
    # Not required / unknown / explicitly waived: don't over-penalize.
    return 75


def _build_narrative(
    overall: int,
    dims: dict[str, int],
    matched: list[str],
    missing_required: list[str],
    job: JobEncoding,
    years_experience: float | None,
) -> tuple[str, list[str], list[str]]:
    strengths: list[str] = []
    gaps: list[str] = []

    if matched:
        top = ", ".join(sorted(matched)[:8])
        strengths.append(f"Direct overlap with the posting's stack: {top}.")
    if dims["job_title_similarity"] >= 70:
        strengths.append("Recent job titles closely match the posted role.")
    if job.years_required and years_experience and years_experience >= job.years_required:
        strengths.append(
            f"Meets the {job.years_required}+ years of experience requirement "
            f"(~{years_experience:.0f} years of relevant history)."
        )
    if dims["industry_domain_match"] >= 70:
        strengths.append("Work history is semantically close to this company's domain.")

    if missing_required:
        missing = ", ".join(sorted(missing_required)[:6])
        gaps.append(
            "The posting lists required skills that do not appear in the profile "
            f"or attached evidence: {missing}. If you have adjacent experience with "
            "these tools, adding it to your profile would raise the skills score."
        )
    if job.years_required and years_experience is not None and years_experience < job.years_required:
        gaps.append(
            f"The role asks for {job.years_required}+ years of experience while the "
            f"profile shows roughly {years_experience:.0f}; expect the experience "
            "dimension to be discounted accordingly."
        )
    if dims["job_title_similarity"] < 40:
        gaps.append(
            "The posted title differs substantially from your recent titles, which "
            "usually signals a different role family or seniority track."
        )
    if job.degree_required is True and not gaps and dims["education"] <= 40:
        gaps.append("The posting requires a degree that is not present in the profile.")

    label = _recommendation(overall).replace("_", " ")
    summary = (
        f"Deterministic match score {overall}/100 ({label}), computed from skill "
        f"overlap, semantic similarity of your experience to the posting, title "
        f"similarity, and stated requirements."
    )
    if matched and missing_required:
        summary += (
            f" Strongest signal: {len(matched)} matching skills; main gap: "
            f"{len(missing_required)} required skills not evidenced."
        )
    elif matched:
        summary += f" {len(matched)} of the posting's skills are directly evidenced."
    return summary, strengths, gaps


async def load_encodings(
    job_id: str, user_id: str
) -> tuple[JobEncoding | None, UserEncoding | None]:
    async with get_session() as session:
        job_enc = (
            await session.execute(
                select(JobEncoding).where(JobEncoding.job_id == job_id)
            )
        ).scalar_one_or_none()
        user_enc = (
            await session.execute(
                select(UserEncoding).where(UserEncoding.user_id == user_id)
            )
        ).scalar_one_or_none()
        if job_enc is not None:
            # Touch deferred vector columns inside the session.
            _ = job_enc.title_vec, job_enc.content_vec
        if user_enc is not None:
            _ = user_enc.experience_vec, user_enc.prefs_vec
        return job_enc, user_enc


def score_pair(job_enc: JobEncoding, user_enc: UserEncoding) -> dict:
    """Score one user x job pair from loaded encodings (sync, pure math)."""
    if job_enc.requires_security_clearance:
        return {
            "overall_score": 0,
            "dimension_scores": {k: 0 for k in MATCH_DIMENSION_WEIGHTS},
            "summary": "Requires security clearance - not scored",
            "strengths": [],
            "gaps": [],
            "recommendation": "poor_match",
            "requires_security_clearance": True,
        }

    job_title_vec = bytes_to_vec(job_enc.title_vec)
    job_content_vec = bytes_to_vec(job_enc.content_vec)
    experience_vec = bytes_to_vec(user_enc.experience_vec)
    prefs_vec = bytes_to_vec(user_enc.prefs_vec)

    cos_experience = _cos(experience_vec, job_content_vec)
    job_skills = dict(job_enc.skills or {})
    user_skills = {k: float(v) for k, v in dict(user_enc.skills or {}).items()}

    skills_score, matched, missing_required = _score_skills(job_skills, user_skills)
    dims = {
        "skills_match": skills_score,
        "experience_match": _score_experience(
            job_enc, cos_experience, user_enc.years_experience
        ),
        "job_title_similarity": _score_title(
            job_title_vec, list(user_enc.title_vecs or [])
        ),
        "industry_domain_match": _cos_to_score(cos_experience, _INDUSTRY_POINTS),
        "education": _score_education(job_enc, user_enc.has_degree),
        "user_preferences": (
            _cos_to_score(_cos(prefs_vec, job_content_vec), _PREFS_POINTS)
            if prefs_vec is not None
            else 50
        ),
    }
    overall = _compute_overall(dims)
    summary, strengths, gaps = _build_narrative(
        overall, dims, matched, missing_required, job_enc, user_enc.years_experience
    )
    return {
        "overall_score": overall,
        "dimension_scores": dims,
        "summary": summary,
        "strengths": strengths,
        "gaps": gaps,
        "recommendation": _recommendation(overall),
        "requires_security_clearance": False,
    }


async def compute_vector_match(job_id: str, user_id: str) -> dict | None:
    """Load encodings and score. None when encodings are missing/stale."""
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
    if job_enc.model_version != user_enc.model_version:
        logger.warning(
            "vector_match_model_version_mismatch",
            job_id=job_id,
            user_id=user_id,
            job_model=job_enc.model_version,
            user_model=user_enc.model_version,
        )
        return None
    return score_pair(job_enc, user_enc)
