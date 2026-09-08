"""Before/after check on the Jaccard skills scorer that shipped in v3.

An earlier exploratory version of this script compared *raw* Jaccard against
the old scorer and measured +0.016 overall. That number did not describe a
shippable change: raw Jaccard has a median of 9.5 against the other
dimensions' 50-60, so feeding it into the weighted sum quietly shrank the
skills contribution, and the measurement conflated the new ordering with that
scale change. The shipped scorer quantile-maps Jaccard back onto the previous
distribution, so the effect has to be re-measured against what actually runs.

Baseline here is the v2 scorer, reproduced below rather than imported, because
it no longer exists in the codebase. Candidate is whatever
vector_match_service currently does, so this keeps working as the scorer moves.

Read-only; no LLM calls, no writes.

Usage:
    python -m scripts.validate_skill_scorer
"""

from __future__ import annotations

import asyncio

import numpy as np
from sqlalchemy import select, text
from sqlalchemy.orm import undefer

from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.skill_lexicon import skill_category
from app.services.vector_match_service import SCORER_VERSION, _score_skills, score_pair
from app.storage.database import close_database, get_session, init_database
from scripts.fit_match_weights import _weighted_user_auc

DIMENSIONS = list(MATCH_DIMENSION_WEIGHTS)
SKILL_WEIGHT = MATCH_DIMENSION_WEIGHTS["skills_match"]

_V2_IMPORTANCE = {"required": 1.2, "preferred": 0.5, "mentioned": 0.25}
_V2_SAME_CATEGORY_CREDIT = 0.55
_V2_RECENCY_FLOOR = 0.5
_V2_MISSING_REQUIRED_PENALTY = 8


def _legacy_score_skills(job_skills: dict, user_skills: dict) -> int:
    """The v2 scorer, kept only so the change has a baseline to be measured against."""
    if not job_skills:
        return 50
    user_categories = {skill_category(s) for s in user_skills}
    missing_required: list[str] = []
    got = 0.0
    total = 0.0
    for skill, importance in job_skills.items():
        imp_w = _V2_IMPORTANCE.get(importance, 0.25)
        total += imp_w
        if skill in user_skills:
            got += imp_w * max(user_skills[skill], _V2_RECENCY_FLOOR)
        else:
            if skill_category(skill) in user_categories:
                got += imp_w * _V2_SAME_CATEGORY_CREDIT
            if importance == "required":
                missing_required.append(skill)
    if total <= 0:
        return 50
    score = int(round(100 * got / total))
    if missing_required:
        score = max(0, score - _V2_MISSING_REQUIRED_PENALTY * min(3, len(missing_required)))
    return score


def _paired_bootstrap(
    baseline: np.ndarray,
    candidate: np.ndarray,
    labels: np.ndarray,
    users: np.ndarray,
    iterations: int = 1000,
    seed: int = 0,
) -> tuple[float, float, float]:
    """(mean delta, low, high) for candidate AUC minus baseline AUC.

    Both sides are recomputed on the same resample, so the correlated part of
    their error cancels and the interval describes the gap rather than the two
    AUCs separately. Resampling is within user because the reported AUC is a
    per-user average.
    """
    rng = np.random.default_rng(seed)
    index_by_user = [np.flatnonzero(users == u) for u in np.unique(users)]
    deltas: list[float] = []
    for _ in range(iterations):
        drawn = np.concatenate(
            [rng.choice(idx, size=len(idx), replace=True) for idx in index_by_user]
        )
        boot_labels, boot_users = labels[drawn], users[drawn]
        base = _weighted_user_auc(baseline[drawn], boot_labels, boot_users)
        cand = _weighted_user_auc(candidate[drawn], boot_labels, boot_users)
        if base is not None and cand is not None:
            deltas.append(cand - base)
    if not deltas:
        return 0.0, 0.0, 0.0
    arr = np.asarray(deltas)
    lo, hi = np.percentile(arr, [2.5, 97.5])
    return float(arr.mean()), float(lo), float(hi)


async def _run() -> None:
    await init_database()
    try:
        async with get_session() as session:
            user_encs = {
                u.user_id: u
                for u in (
                    await session.execute(
                        select(UserEncoding).options(
                            undefer(UserEncoding.experience_vec),
                            undefer(UserEncoding.prefs_vec),
                            undefer(UserEncoding.domain_vec),
                        )
                    )
                )
                .scalars()
                .all()
            }
            job_encs = {
                j.job_id: j
                for j in (
                    await session.execute(
                        select(JobEncoding).options(
                            undefer(JobEncoding.title_vec),
                            undefer(JobEncoding.content_vec),
                            undefer(JobEncoding.industry_vec),
                        )
                    )
                )
                .scalars()
                .all()
            }
            pairs = (
                await session.execute(
                    text(
                        """
                        SELECT r.job_id, r.user_id, (a.id IS NOT NULL) AS applied
                        FROM job_match_results r
                        LEFT JOIN valid_job_user_applications a
                               ON a.job_id = r.job_id AND a.user_id = r.user_id
                        """
                    )
                )
            ).all()
    finally:
        await close_database()

    skills_v2, skills_v3, overall_v2, overall_v3 = [], [], [], []
    labels, owners = [], []

    for job_id, user_id, applied in pairs:
        job_enc, user_enc = job_encs.get(job_id), user_encs.get(user_id)
        if job_enc is None or user_enc is None:
            continue
        if job_enc.model_version != user_enc.model_version:
            continue
        dims = score_pair(job_enc, user_enc)["dimension_scores"]
        job_skills = dict(job_enc.skills or {})
        user_skills = {k: float(v) for k, v in dict(user_enc.skills or {}).items()}

        new_skill = float(dims.get("skills_match", 0))
        old_skill = float(_legacy_score_skills(job_skills, user_skills))
        total = sum(float(dims.get(d, 0)) * MATCH_DIMENSION_WEIGHTS[d] for d in DIMENSIONS)

        labels.append(int(bool(applied)))
        owners.append(user_id)
        skills_v2.append(old_skill)
        skills_v3.append(new_skill)
        overall_v3.append(total)
        overall_v2.append(total + SKILL_WEIGHT * (old_skill - new_skill))

    label_array = np.asarray(labels)
    owner_array = np.asarray(owners)
    print()
    print(f"Before/after for scorer {SCORER_VERSION}")
    print(f"  pairs                       {len(labels)}")
    print(f"  applications                {int(label_array.sum())}")
    print(f"  users                       {len(np.unique(owner_array))}")

    for heading, base, cand in (
        ("Skills dimension alone", np.asarray(skills_v2), np.asarray(skills_v3)),
        (
            f"Overall match score (skills weight {SKILL_WEIGHT})",
            np.asarray(overall_v2),
            np.asarray(overall_v3),
        ),
    ):
        base_auc = _weighted_user_auc(base, label_array, owner_array)
        cand_auc = _weighted_user_auc(cand, label_array, owner_array)
        mean, lo, hi = _paired_bootstrap(base, cand, label_array, owner_array)
        print()
        print(f"  {heading}")
        print(f"    v2 (previous)   {(base_auc or 0):.3f}")
        print(f"    v3 (shipped)    {(cand_auc or 0):.3f}")
        print(
            f"    change          {mean:+.3f}   95% CI {lo:+.3f} to {hi:+.3f}"
            f"   {'real gain' if lo > 0 else 'within noise'}"
        )

    # The calibration exists to keep the visible numbers and the absolute
    # recommendation/auto-post thresholds where they were. If this drifts, users
    # see their scores move for reasons unrelated to ranking quality.
    print()
    print("  Score distribution, which the calibration is meant to preserve")
    print(f"    {'':<10} {'mean':>7} {'sd':>7} {'p10':>7} {'p50':>7} {'p90':>7}")
    for name, values in (
        ("skills v2", np.asarray(skills_v2)),
        ("skills v3", np.asarray(skills_v3)),
        ("overall v2", np.asarray(overall_v2)),
        ("overall v3", np.asarray(overall_v3)),
    ):
        print(
            f"    {name:<10} {values.mean():>7.1f} {values.std():>7.1f} "
            f"{np.percentile(values, 10):>7.1f} {np.percentile(values, 50):>7.1f} "
            f"{np.percentile(values, 90):>7.1f}"
        )
    print()


if __name__ == "__main__":
    asyncio.run(_run())
