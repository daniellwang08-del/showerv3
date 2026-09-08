"""Fit the six match dimension weights from real application outcomes.

MATCH_DIMENSION_WEIGHTS is currently six hand-chosen constants. With 354
labelled applications and six features there is enough signal to fit them
instead of guessing, and to check under cross-validation whether the fitted
weights actually rank better than the hand-picked ones.

This does NOT need new data and does NOT settle the vector-vs-LLM question --
it asks a narrower question: given the sub-scores the vector engine already
produces, is the current way of combining them the best one?

Two cross-validation schemes are reported, because they answer different
questions:

  new jobs   grouped k-fold over pairs; test folds contain users also seen in
             training. This is the production case: known users, new postings.
  new users  leave-one-user-out. Harder, and the honest test of whether the
             weights generalise beyond the people they were fitted on.

Caveat inherited from the labels: applications were made while looking at a
displayed score, mostly the LLM's. The fitted weights therefore learn "which
vector dimensions agree with jobs users actually pursued", which is the useful
question, but the candidate pool itself was shaped by an earlier ranking.

Read-only; no LLM calls, no writes. Uses scikit-learn, which is present as a
transitive dependency of sentence-transformers rather than a declared one --
fine for an offline analysis script, but do not import it from app code.

Usage:
    python -m scripts.fit_match_weights
    python -m scripts.fit_match_weights --min-positives 10 --json fit.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections import defaultdict
from typing import Any

import numpy as np
from sqlalchemy import select, text
from sqlalchemy.orm import undefer

from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.vector_match_service import score_pair
from app.storage.database import close_database, get_session, init_database
from scripts.eval_match_ranking import roc_auc

DIMENSIONS = list(MATCH_DIMENSION_WEIGHTS)


# ── evaluation ───────────────────────────────────────────────────────────────


def _weighted_user_auc(
    scores: np.ndarray,
    labels: np.ndarray,
    users: np.ndarray,
) -> float | None:
    """Per-user AUC aggregated weighted by application count.

    Matches how eval_match_ranking reports, so the numbers are comparable:
    pooling across users would mostly measure differing base rates.
    """
    total_weight = 0
    total = 0.0
    for user in np.unique(users):
        mask = users == user
        auc = roc_auc(scores[mask].tolist(), labels[mask].astype(bool).tolist())
        if auc is None:
            continue
        weight = int(labels[mask].sum())
        total += auc * weight
        total_weight += weight
    return total / total_weight if total_weight else None


def _baseline_scores(features: np.ndarray) -> np.ndarray:
    """Overall score under the current hand-picked weights."""
    weights = np.array([MATCH_DIMENSION_WEIGHTS[d] for d in DIMENSIONS])
    return features @ weights


def _cross_validate(
    features: np.ndarray,
    labels: np.ndarray,
    users: np.ndarray,
    folds: list[tuple[np.ndarray, np.ndarray]],
    regularization: float = 1.0,
) -> dict[str, Any]:
    from sklearn.linear_model import LogisticRegression

    baseline_aucs: list[float] = []
    fitted_aucs: list[float] = []
    for train_idx, test_idx in folds:
        if labels[train_idx].sum() < 5 or labels[test_idx].sum() < 2:
            continue
        model = LogisticRegression(max_iter=5000, C=regularization)
        model.fit(features[train_idx], labels[train_idx])
        predicted = model.decision_function(features[test_idx])

        base = _weighted_user_auc(
            _baseline_scores(features[test_idx]), labels[test_idx], users[test_idx]
        )
        fit = _weighted_user_auc(predicted, labels[test_idx], users[test_idx])
        if base is not None and fit is not None:
            baseline_aucs.append(base)
            fitted_aucs.append(fit)

    if not fitted_aucs:
        return {"folds": 0}
    return {
        "folds": len(fitted_aucs),
        "baseline_auc": float(np.mean(baseline_aucs)),
        "fitted_auc": float(np.mean(fitted_aucs)),
        "delta": float(np.mean(fitted_aucs) - np.mean(baseline_aucs)),
        "per_fold": [
            {"baseline": round(b, 4), "fitted": round(f, 4)}
            for b, f in zip(baseline_aucs, fitted_aucs)
        ],
    }


# ── data ─────────────────────────────────────────────────────────────────────


async def _load(min_positives: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
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
        rows = (
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

        by_user: dict[str, list[tuple[list[float], int]]] = defaultdict(list)
        for job_id, user_id, applied in rows:
            job_enc, user_enc = job_encs.get(job_id), user_encs.get(user_id)
            if job_enc is None or user_enc is None:
                continue
            if job_enc.model_version != user_enc.model_version:
                continue
            dims = score_pair(job_enc, user_enc)["dimension_scores"]
            by_user[user_id].append(
                ([float(dims.get(d, 0)) for d in DIMENSIONS], int(bool(applied)))
            )

    features, labels, users = [], [], []
    for user_id, samples in by_user.items():
        positives = sum(label for _, label in samples)
        # Users whose outcome count cannot support a per-user AUC contribute
        # nothing but noise to the fold estimates.
        if positives < min_positives or positives == len(samples):
            continue
        for vector, label in samples:
            features.append(vector)
            labels.append(label)
            users.append(user_id)

    # Scale 0-100 sub-scores to 0-1 for a well-conditioned solver. Because all
    # six share a scale, the coefficients stay directly comparable with each
    # other and with MATCH_DIMENSION_WEIGHTS.
    return (
        np.asarray(features, dtype=float) / 100.0,
        np.asarray(labels, dtype=int),
        np.asarray(users),
    )


# ── reporting ────────────────────────────────────────────────────────────────


def _report(result: dict[str, Any]) -> None:
    print()
    print("Fitting match dimension weights to real application outcomes")
    print(f"  pairs             {result['pairs']}")
    print(f"  applications      {result['applications']}")
    print(f"  users             {result['users']}")

    print()
    print("  Weights: current hand-picked vs fitted on all data")
    print(f"    {'dimension':<24} {'current':>8} {'fitted':>8} {'change':>8}")
    for dim in DIMENSIONS:
        current = MATCH_DIMENSION_WEIGHTS[dim]
        fitted = result["fitted_weights"][dim]
        change = fitted - current
        print(f"    {dim:<24} {current:>8.3f} {fitted:>8.3f} {change:>+8.3f}")

    for name, key in (("new jobs, known users", "cv_jobs"), ("new users", "cv_users")):
        cv = result[key]
        print()
        print(f"  Cross-validated ranking quality - {name}")
        if not cv.get("folds"):
            print("    not enough labelled data to evaluate this scheme")
            continue
        verdict = (
            "fitted is better"
            if cv["delta"] > 0.01
            else "no meaningful difference"
            if cv["delta"] > -0.01
            else "fitted is WORSE"
        )
        print(f"    folds                   {cv['folds']}")
        print(f"    current weights         {cv['baseline_auc']:.3f}")
        print(f"    fitted weights          {cv['fitted_auc']:.3f}")
        print(f"    delta                   {cv['delta']:+.3f}   {verdict}")

    print()
    print("  Regularization sweep (fitted AUC; baselines above for comparison)")
    print(f"    {'C':>8}  {'new jobs':>10}  {'new users':>10}")
    for row in result["regularization_sweep"]:
        jobs = row["new_jobs"]
        users_ = row["new_users"]
        print(
            f"    {row['C']:>8}  "
            f"{('n/a' if jobs is None else f'{jobs:.3f}'):>10}  "
            f"{('n/a' if users_ is None else f'{users_:.3f}'):>10}"
        )

    print()
    print("  Labels come from applications made while a score was on screen, so")
    print("  the candidate pool was already shaped by an earlier ranking.")
    print()


async def _run(min_positives: int) -> dict[str, Any]:
    await init_database()
    try:
        features, labels, users = await _load(min_positives)
    finally:
        await close_database()

    if len(features) == 0:
        raise SystemExit("no labelled pairs met the threshold")

    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import LeaveOneGroupOut, StratifiedKFold

    full = LogisticRegression(max_iter=2000, C=1.0).fit(features, labels)
    coefficients = full.coef_[0]
    # Normalise to sum 1 so they read on the same scale as the current weights.
    # A negative coefficient means the dimension currently argues against the
    # outcome, which normalisation would hide, so report it raw as well.
    total = float(np.abs(coefficients).sum()) or 1.0
    fitted_weights = {
        dim: float(coefficients[i] / total) for i, dim in enumerate(DIMENSIONS)
    }

    # Split within users, not by user: a test fold holds unseen *jobs* for
    # users the model has already seen, which is the production case.
    jobs_folds = list(
        StratifiedKFold(n_splits=5, shuffle=True, random_state=0).split(
            features, labels
        )
    )
    users_folds = list(LeaveOneGroupOut().split(features, labels, groups=users))

    return {
        "pairs": int(len(labels)),
        "applications": int(labels.sum()),
        "users": int(len(np.unique(users))),
        "fitted_weights": fitted_weights,
        "raw_coefficients": {
            dim: float(coefficients[i]) for i, dim in enumerate(DIMENSIONS)
        },
        "cv_jobs": _cross_validate(features, labels, users, jobs_folds),
        "cv_users": _cross_validate(features, labels, users, users_folds),
        # Sweep regularization so a negative result cannot be blamed on one
        # arbitrary setting. Strong regularization shrinks the fit toward a
        # flat combination, so if the hand-picked weights still win across the
        # whole range, the data genuinely does not support re-weighting.
        "regularization_sweep": [
            {
                "C": c,
                "new_jobs": _cross_validate(
                    features, labels, users, jobs_folds, regularization=c
                ).get("fitted_auc"),
                "new_users": _cross_validate(
                    features, labels, users, users_folds, regularization=c
                ).get("fitted_auc"),
            }
            for c in (0.01, 0.1, 1.0, 10.0, 100.0)
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-positives",
        type=int,
        default=10,
        help="skip users with fewer applications than this (default 10)",
    )
    parser.add_argument("--json", help="also write the full result to this path")
    args = parser.parse_args()

    result = asyncio.run(_run(args.min_positives))
    _report(result)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
        print(f"  wrote {args.json}")


if __name__ == "__main__":
    main()
