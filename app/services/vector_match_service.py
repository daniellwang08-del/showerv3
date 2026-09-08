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

import hashlib
import json

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.core.logging import get_logger
from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.encoding_service import b64_to_vec, bytes_to_vec
from app.storage.database import get_session

logger = get_logger(__name__)


def _cos(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    if a is None or b is None or a.size == 0 or b.size == 0 or a.size != b.size:
        return None
    # Vectors are stored L2-normalized; dot product is cosine.
    return float(np.dot(a, b))


def _cos_to_score(cos: float | None, points: tuple[tuple[float, float], ...]) -> int:
    """Piecewise-linear map from a similarity in [0, 1] to a 0-100 score."""
    if cos is None:
        return 50
    if cos <= points[0][0]:
        return int(points[0][1])
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        if cos <= x2:
            frac = (cos - x1) / (x2 - x1) if x2 > x1 else 0.0
            return int(round(y1 + frac * (y2 - y1)))
    return int(points[-1][1])


# Calibration for all-MiniLM-L6-v2 (production). MiniLM same-domain cosines
# typically sit higher/tighter than mpnet; these anchors stretch mid-band
# matches and reserve ≥80 for clearly strong cosine overlap.
_EXPERIENCE_POINTS = ((0.10, 18), (0.30, 42), (0.42, 62), (0.52, 78), (0.62, 90), (0.72, 97))
_TITLE_POINTS = ((0.20, 18), (0.38, 42), (0.52, 68), (0.65, 85), (0.80, 97))
# Industry uses an independent company/domain embedding vs user domain history.
_INDUSTRY_POINTS = ((0.08, 20), (0.25, 42), (0.40, 65), (0.52, 80), (0.65, 92), (0.78, 97))
_PREFS_POINTS = ((0.08, 25), (0.22, 45), (0.38, 65), (0.52, 80), (0.68, 93))
# Jaccard overlap runs far lower than the other similarities -- postings list
# ~13 skills against profiles carrying 36-82, so even a strong match rarely
# clears 0.25. These anchors are a quantile map measured against the previous
# scorer's output, which keeps the visible score distribution and the absolute
# recommendation and auto-post thresholds where they already are.
_SKILLS_POINTS = (
    (0.000, 0),
    (0.014, 37),
    (0.041, 45),
    (0.095, 50),
    (0.153, 64),
    (0.202, 75),
    (0.226, 80),
    (0.439, 100),
)

SCORER_VERSION = "minilm-v3-jaccard-skills"

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
    """(score, matched_skills, missing_required_skills).

    Scored by Jaccard overlap -- intersection over union -- rather than by the
    share of the posting's skills the profile happens to cover. Dividing by the
    posting alone ignores how broad the profile is, and since profiles here
    carry 36-82 skills against postings listing about 13, almost anything in a
    user's field cleared the bar. Measured against real applications that cost
    the dimension most of its discriminating power: 0.574 AUC for the old
    scorer against 0.654 for this one.

    An empty skill set on either side is missing information rather than a
    mismatch, so it scores neutral instead of zero.
    """
    if not job_skills or not user_skills:
        return 50, [], []

    matched = [skill for skill in job_skills if skill in user_skills]
    missing_required = [
        skill
        for skill, importance in job_skills.items()
        if importance == "required" and skill not in user_skills
    ]
    union = len(set(job_skills) | set(user_skills))
    score = _cos_to_score(len(matched) / union, _SKILLS_POINTS) if union else 50
    return score, matched, missing_required


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
    """Load encoding rows with vector blobs eagerly undeferred.

    ``title_vec`` / ``content_vec`` / ``experience_vec`` / ``prefs_vec`` are
    ``deferred()`` columns. Sync attribute access under AsyncSession raises
    MissingGreenlet (sqlalchemy xd2s) — never "touch" them; undefer in the
    SELECT instead.
    """
    async with get_session() as session:
        job_enc = (
            await session.execute(
                select(JobEncoding)
                .options(
                    undefer(JobEncoding.title_vec),
                    undefer(JobEncoding.content_vec),
                    undefer(JobEncoding.industry_vec),
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
        if user_enc is not None:
            user_enc.experience_vec = user_enc.experience_vec
            user_enc.prefs_vec = user_enc.prefs_vec
            user_enc.domain_vec = user_enc.domain_vec
        return job_enc, user_enc


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


def _build_explain(
    *,
    job_enc: JobEncoding,
    user_enc: UserEncoding,
    dims: dict[str, int],
    overall: int,
    matched: list[str],
    missing_required: list[str],
    cos_experience: float | None,
    cos_industry: float | None,
    cos_prefs: float | None,
    cos_title: float | None,
    job_skills: dict[str, str],
    user_skills: dict[str, float],
) -> dict:
    contributions = {
        key: {
            "score": int(dims.get(key, 0)),
            "weight": float(weight),
            "weighted": round(float(dims.get(key, 0)) * float(weight), 2),
        }
        for key, weight in MATCH_DIMENSION_WEIGHTS.items()
    }
    return {
        "model_version": job_enc.model_version,
        "scorer_version": SCORER_VERSION,
        "cosines": {
            "experience_to_content": (
                round(cos_experience, 4) if cos_experience is not None else None
            ),
            "domain_to_industry": (
                round(cos_industry, 4) if cos_industry is not None else None
            ),
            "prefs_to_content": round(cos_prefs, 4) if cos_prefs is not None else None,
            "best_title": round(cos_title, 4) if cos_title is not None else None,
        },
        "skills": {
            "job_skill_count": len(job_skills),
            "user_skill_count": len(user_skills),
            "job_skills": dict(sorted(job_skills.items())),
            "matched": sorted(matched),
            "missing_required": sorted(missing_required),
        },
        "signals": {
            "years_required": job_enc.years_required,
            "years_experience": user_enc.years_experience,
            "degree_required": job_enc.degree_required,
            "has_degree": user_enc.has_degree,
            "requires_security_clearance": bool(job_enc.requires_security_clearance),
        },
        "dimension_contributions": contributions,
        "overall_from_weights": overall,
        "calibration": {
            "experience_points": list(_EXPERIENCE_POINTS),
            "title_points": list(_TITLE_POINTS),
            "industry_points": list(_INDUSTRY_POINTS),
            "prefs_points": list(_PREFS_POINTS),
            "note": (
                "experience_match uses experience↔content; industry_domain_match "
                "uses domain↔industry (independent embeddings)."
            ),
        },
    }


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
        getattr(job_enc, "industry_vec", None),
        user_enc.experience_vec,
        user_enc.prefs_vec,
        getattr(user_enc, "domain_vec", None),
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
                "user_skills": dict(sorted(dict(user_enc.skills or {}).items())),
                "user_years": user_enc.years_experience,
                "user_degree": user_enc.has_degree,
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


def score_pair(job_enc: JobEncoding, user_enc: UserEncoding, *, explain: bool = False) -> dict:
    """Score one user x job pair from loaded encodings (sync, pure math)."""
    if job_enc.requires_security_clearance:
        result = {
            "overall_score": 0,
            "dimension_scores": {k: 0 for k in MATCH_DIMENSION_WEIGHTS},
            "summary": "Requires security clearance - not scored",
            "strengths": [],
            "gaps": [],
            "recommendation": "poor_match",
            "requires_security_clearance": True,
            **_provenance(job_enc, user_enc),
        }
        if explain:
            result["explain"] = {
                "model_version": job_enc.model_version,
                "scorer_version": SCORER_VERSION,
                "gated": "security_clearance",
                "signals": {
                    "requires_security_clearance": True,
                    "years_required": job_enc.years_required,
                    "years_experience": user_enc.years_experience,
                },
            }
        return result

    job_title_vec = bytes_to_vec(job_enc.title_vec)
    job_content_vec = bytes_to_vec(job_enc.content_vec)
    job_industry_vec = bytes_to_vec(getattr(job_enc, "industry_vec", None))
    experience_vec = bytes_to_vec(user_enc.experience_vec)
    prefs_vec = bytes_to_vec(user_enc.prefs_vec)
    domain_vec = bytes_to_vec(getattr(user_enc, "domain_vec", None))
    title_vecs = list(user_enc.title_vecs or [])

    cos_experience = _cos(experience_vec, job_content_vec)
    # Independent industry signal: user domain history ↔ job company/industry.
    # Fall back to experience↔content only when industry/domain vecs are missing
    # (pre-migration encodings); once re-encoded they diverge.
    if job_industry_vec is not None and domain_vec is not None:
        cos_industry = _cos(domain_vec, job_industry_vec)
    elif job_industry_vec is not None and experience_vec is not None:
        cos_industry = _cos(experience_vec, job_industry_vec)
    else:
        cos_industry = None
    cos_prefs = _cos(prefs_vec, job_content_vec) if prefs_vec is not None else None
    cos_title = _best_title_cosine(job_title_vec, title_vecs)
    job_skills = dict(job_enc.skills or {})
    user_skills = {k: float(v) for k, v in dict(user_enc.skills or {}).items()}

    skills_score, matched, missing_required = _score_skills(job_skills, user_skills)
    dims = {
        "skills_match": skills_score,
        "experience_match": _score_experience(
            job_enc, cos_experience, user_enc.years_experience
        ),
        "job_title_similarity": _cos_to_score(cos_title, _TITLE_POINTS),
        "industry_domain_match": _cos_to_score(
            cos_industry if cos_industry is not None else cos_experience,
            _INDUSTRY_POINTS,
        ),
        "education": _score_education(job_enc, user_enc.has_degree),
        "user_preferences": (
            _cos_to_score(cos_prefs, _PREFS_POINTS) if cos_prefs is not None else 50
        ),
    }
    overall = _compute_overall(dims)
    summary, strengths, gaps = _build_narrative(
        overall, dims, matched, missing_required, job_enc, user_enc.years_experience
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
        result["explain"] = _build_explain(
            job_enc=job_enc,
            user_enc=user_enc,
            dims=dims,
            overall=overall,
            matched=matched,
            missing_required=missing_required,
            cos_experience=cos_experience,
            cos_industry=cos_industry,
            cos_prefs=cos_prefs,
            cos_title=cos_title,
            job_skills=job_skills,
            user_skills=user_skills,
        )
    return result


async def compute_vector_match(
    job_id: str, user_id: str, *, explain: bool = False
) -> dict | None:
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
    return score_pair(job_enc, user_enc, explain=explain)
