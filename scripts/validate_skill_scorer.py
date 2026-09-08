"""Decide whether the Jaccard skill scorer should replace the current one.

diagnose_skill_matching found that scoring the same stored skill sets by
Jaccard ranks better than the current scorer at the dimension level. That is
not enough to justify changing the scorer, for two reasons this script exists
to settle:

  selection   Jaccard was the best of four variants measured on one dataset.
              The gap needs an interval, not a point estimate, and the paired
              bootstrap over the same resamples is what gives one.
  dilution    skills_match is one of six dimensions carrying weight 0.32. A
              dimension-level gain shrinks by roughly that factor, and shrinks
              further to the extent the new scorer merely re-states what the
              title and industry dimensions already say. Only the overall
              score matters, so that is what gets measured here.

The bar: the overall gain's 95% interval must exclude zero. A dimension-level
win that does not survive dilution is not worth a scorer change.

Read-only; no LLM calls, no writes.

Usage:
    python -m scripts.validate_skill_scorer
"""

from __future__ import annotations

import asyncio
import math
from collections import Counter
from typing import Callable

import numpy as np
from sqlalchemy import select, text
from sqlalchemy.orm import undefer

from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.vector_match_service import score_pair
from app.storage.database import close_database, get_session, init_database
from scripts.fit_match_weights import _weighted_user_auc

DIMENSIONS = list(MATCH_DIMENSION_WEIGHTS)
SKILL_WEIGHT = MATCH_DIMENSION_WEIGHTS["skills_match"]


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
    AUCs separately. Resampling happens within each user because the reported
    AUC is a per-user average.
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


def _jaccard(job_skills: dict, user_skills: dict) -> float:
    union = set(job_skills) | set(user_skills)
    if not union:
        return 50.0
    return 100.0 * len(set(job_skills) & set(user_skills)) / len(union)


def _idf_scorer(document_frequency: Counter, corpus: int) -> Callable:
    def score(job_skills: dict, user_skills: dict) -> float:
        if not job_skills:
            return 50.0
        weight = lambda s: math.log(corpus / (1 + document_frequency.get(s, 0)))
        total = sum(weight(s) for s in job_skills) or 1.0
        return 100.0 * sum(weight(s) for s in job_skills if s in user_skills) / total

    return score


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

    document_frequency: Counter = Counter()
    for enc in job_encs.values():
        document_frequency.update(dict(enc.skills or {}).keys())
    idf_score = _idf_scorer(document_frequency, max(len(job_encs), 1))

    current_skill, jaccard_skill, idf_skill = [], [], []
    overall_current, overall_jaccard, overall_idf = [], [], []
    features_jaccard: list[list[float]] = []
    labels, owners = [], []

    for job_id, user_id, applied in pairs:
        job_enc, user_enc = job_encs.get(job_id), user_encs.get(user_id)
        if job_enc is None or user_enc is None:
            continue
        if job_enc.model_version != user_enc.model_version:
            continue
        dims = score_pair(job_enc, user_enc)["dimension_scores"]
        job_skills = dict(job_enc.skills or {})
        user_skills = dict(user_enc.skills or {})

        base_skill = float(dims.get("skills_match", 0))
        alt_j = _jaccard(job_skills, user_skills)
        alt_i = idf_score(job_skills, user_skills)
        total = sum(float(dims.get(d, 0)) * MATCH_DIMENSION_WEIGHTS[d] for d in DIMENSIONS)

        labels.append(int(bool(applied)))
        owners.append(user_id)
        current_skill.append(base_skill)
        jaccard_skill.append(alt_j)
        idf_skill.append(alt_i)
        overall_current.append(total)
        # Swap only the skills term, leaving every other dimension and the
        # weights untouched, so the comparison isolates the scorer change.
        overall_jaccard.append(total + SKILL_WEIGHT * (alt_j - base_skill))
        overall_idf.append(total + SKILL_WEIGHT * (alt_i - base_skill))
        features_jaccard.append(
            [
                alt_j if d == "skills_match" else float(dims.get(d, 0))
                for d in DIMENSIONS
            ]
        )

    label_array = np.asarray(labels)
    owner_array = np.asarray(owners)
    print()
    print("Validating the Jaccard skill scorer")
    print(f"  pairs                       {len(labels)}")
    print(f"  applications                {int(label_array.sum())}")
    print(f"  users                       {len(np.unique(owner_array))}")

    for heading, base, candidates in (
        (
            "Skills dimension alone",
            np.asarray(current_skill),
            {"jaccard": np.asarray(jaccard_skill), "idf": np.asarray(idf_skill)},
        ),
        (
            f"Overall match score (skills carries weight {SKILL_WEIGHT})",
            np.asarray(overall_current),
            {"jaccard": np.asarray(overall_jaccard), "idf": np.asarray(overall_idf)},
        ),
    ):
        base_auc = _weighted_user_auc(base, label_array, owner_array)
        print()
        print(f"  {heading}")
        print(f"    {'scorer':<12} {'auc':>6} {'delta':>8} {'95% CI on gap':>20} {'verdict':>14}")
        print(f"    {'current':<12} {(base_auc or 0):>6.3f} {'':>8} {'':>20} {'baseline':>14}")
        for name, values in candidates.items():
            auc = _weighted_user_auc(values, label_array, owner_array)
            mean, lo, hi = _paired_bootstrap(base, values, label_array, owner_array)
            verdict = "real gain" if lo > 0 else "within noise"
            print(
                f"    {name:<12} {(auc or 0):>6.3f} {mean:>+8.3f} "
                f"{f'{lo:+.3f} to {hi:+.3f}':>20} {verdict:>14}"
            )

    _compound_with_weights(
        np.asarray(features_jaccard),
        np.asarray(overall_current),
        label_array,
        owner_array,
    )

    print()
    print("  Ship only if the overall gain's interval excludes zero; a dimension-level")
    print("  win that does not survive dilution is not worth changing the scorer for.")
    print()


def _compound_with_weights(
    features: np.ndarray,
    baseline_overall: np.ndarray,
    labels: np.ndarray,
    users: np.ndarray,
) -> None:
    """Does fixing the scorer change which weighting is best?

    The current weights were chosen while skills_match was the weakest of the
    six. A scorer that makes it competitive invalidates that tuning, so the two
    changes may compound rather than each being separately marginal. Everything
    is bootstrapped against the real production baseline -- current scorer and
    current weights -- so the numbers are the total gain a user would see, not
    a gain over some intermediate configuration.
    """
    current = np.array([MATCH_DIMENSION_WEIGHTS[d] for d in DIMENSIONS])
    weightings = {
        "current weights": current,
        "equal weights": np.full(len(DIMENSIONS), 1.0 / len(DIMENSIONS)),
        # Skills now carries real signal, so give it back parity with the other
        # strong dimensions rather than the 0.32 it held when it was noise.
        "skills at parity": np.array(
            [0.20 if d == "skills_match" else w for d, w in
             zip(DIMENSIONS, [MATCH_DIMENSION_WEIGHTS[x] for x in DIMENSIONS])]
        ) / sum(
            0.20 if d == "skills_match" else MATCH_DIMENSION_WEIGHTS[d]
            for d in DIMENSIONS
        ),
    }

    print()
    print("  Jaccard scorer combined with alternative weightings")
    print(f"    {'configuration':<20} {'auc':>6} {'delta':>8} {'95% CI on gap':>20} {'verdict':>14}")
    base_auc = _weighted_user_auc(baseline_overall, labels, users)
    print(f"    {'production today':<20} {(base_auc or 0):>6.3f} {'':>8} {'':>20} {'baseline':>14}")
    for name, weights in weightings.items():
        scores = features @ weights
        auc = _weighted_user_auc(scores, labels, users)
        mean, lo, hi = _paired_bootstrap(baseline_overall, scores, labels, users)
        verdict = "real gain" if lo > 0 else "within noise"
        print(
            f"    {name:<20} {(auc or 0):>6.3f} {mean:>+8.3f} "
            f"{f'{lo:+.3f} to {hi:+.3f}':>20} {verdict:>14}"
        )


if __name__ == "__main__":
    asyncio.run(_run())
