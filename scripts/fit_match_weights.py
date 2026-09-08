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
from scripts.eval_match_ranking import auc_interval, roc_auc

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


def _per_dimension(
    features: np.ndarray, labels: np.ndarray, users: np.ndarray
) -> list[dict[str, Any]]:
    """How much signal each sub-score carries on its own.

    A dimension can fail to contribute in two distinct ways, and the fix
    differs: it can rank no better than chance (the signal is wrong), or it can
    be saturated at one value (there is no signal to rank with, whatever its
    weight). Both are invisible in the combined score.
    """
    n_pos = int(labels.sum())
    n_neg = int(len(labels) - n_pos)
    out: list[dict[str, Any]] = []
    for i, dim in enumerate(DIMENSIONS):
        column = features[:, i]
        auc = _weighted_user_auc(column, labels, users)
        values, counts = np.unique(column, return_counts=True)
        out.append(
            {
                "dimension": dim,
                "weight": MATCH_DIMENSION_WEIGHTS[dim],
                "auc": auc,
                # Approximate: ignores the per-user structure, adequate for
                # screening a dimension as near-chance.
                "ci": auc_interval(auc, n_pos, n_neg),
                "mean": float(column.mean() * 100),
                "std": float(column.std() * 100),
                "distinct_values": int(len(values)),
                "modal_share": float(counts.max() / len(column)),
            }
        )
    out.sort(key=lambda e: -(e["auc"] or 0))
    return out


def _candidate_weightings(
    per_dimension: list[dict[str, Any]]
) -> dict[str, np.ndarray]:
    """A few principled fixed weightings to compare against the current one.

    The free logistic fit generalised worse, partly because it handed negative
    coefficients to dimensions that cannot plausibly argue against a match.
    These candidates stay non-negative and have at most one degree of freedom,
    so they cannot overfit the way a six-parameter fit can.
    """
    auc_by_dim = {row["dimension"]: (row["auc"] or 0.5) for row in per_dimension}
    signal = np.array([max(auc_by_dim[d] - 0.5, 0.0) for d in DIMENSIONS])
    current = np.array([MATCH_DIMENSION_WEIGHTS[d] for d in DIMENSIONS])

    # Education is near-constant across pairs, so its weight buys nothing;
    # spread it over the rest in proportion to what they already carry.
    without_education = current.copy()
    idx = DIMENSIONS.index("education")
    freed = without_education[idx]
    without_education[idx] = 0.0
    without_education += without_education / without_education.sum() * freed

    return {
        "current": current,
        "equal": np.full(len(DIMENSIONS), 1.0 / len(DIMENSIONS)),
        "signal_proportional": signal / signal.sum(),
        "current_minus_education": without_education,
        "halfway_to_signal": (current + signal / signal.sum()) / 2.0,
    }


def _paired_bootstrap(
    features: np.ndarray,
    labels: np.ndarray,
    users: np.ndarray,
    candidates: dict[str, np.ndarray],
    iterations: int = 1000,
    seed: int = 0,
) -> dict[str, dict[str, float]]:
    """Confidence interval on each candidate's AUC *difference* from current.

    The candidates are compared on identical data, so their errors are highly
    correlated and separate per-candidate intervals would overstate the
    uncertainty of the gap. Resampling pairs within each user and recomputing
    both sides on the same resample measures the difference directly.
    """
    rng = np.random.default_rng(seed)
    user_indices = {u: np.flatnonzero(users == u) for u in np.unique(users)}
    current = candidates["current"]
    deltas: dict[str, list[float]] = {name: [] for name in candidates}

    for _ in range(iterations):
        drawn = np.concatenate(
            [rng.choice(idx, size=len(idx), replace=True) for idx in user_indices.values()]
        )
        boot_labels, boot_users = labels[drawn], users[drawn]
        boot_features = features[drawn]
        base = _weighted_user_auc(boot_features @ current, boot_labels, boot_users)
        if base is None:
            continue
        for name, weights in candidates.items():
            auc = _weighted_user_auc(boot_features @ weights, boot_labels, boot_users)
            if auc is not None:
                deltas[name].append(auc - base)

    out: dict[str, dict[str, float]] = {}
    for name, values in deltas.items():
        if not values:
            continue
        arr = np.asarray(values)
        lo, hi = np.percentile(arr, [2.5, 97.5])
        out[name] = {
            "mean_delta": float(arr.mean()),
            "lo": float(lo),
            "hi": float(hi),
            "beats_current": bool(lo > 0),
        }
    return out


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
    print("  Signal carried by each sub-score on its own")
    print(
        f"    {'dimension':<24} {'weight':>7} {'auc':>6} {'95% interval':>16} "
        f"{'mean':>7} {'sd':>6} {'modal':>7}"
    )
    for row in result["per_dimension"]:
        ci = row["ci"]
        span = "n/a" if ci is None else f"{ci[0]:.3f} - {ci[1]:.3f}"
        flag = "" if ci and ci[0] > 0.5 else "   <- at chance"
        print(
            f"    {row['dimension']:<24} {row['weight']:>7.2f} "
            f"{(row['auc'] or 0):>6.3f} {span:>16} "
            f"{row['mean']:>7.1f} {row['std']:>6.1f} "
            f"{row['modal_share'] * 100:>6.0f}%{flag}"
        )
    print("    modal = share of pairs sitting on the single most common value")

    print()
    print("  Fixed candidate weightings (no fitting, so no overfitting)")
    print(
        f"    {'weighting':<26} {'auc':>6} {'vs current':>11} "
        f"{'95% CI on gap':>18} {'verdict':>12}"
    )
    baseline = result["candidates"]["current"]["auc"] or 0
    for name, entry in sorted(
        result["candidates"].items(), key=lambda kv: -(kv[1]["auc"] or 0)
    ):
        auc = entry["auc"] or 0
        boot = result["bootstrap"].get(name)
        if name == "current":
            print(f"    {name:<26} {auc:>6.3f} {'':>11} {'':>18} {'baseline':>12}")
            continue
        span = "n/a" if boot is None else f"{boot['lo']:+.3f} to {boot['hi']:+.3f}"
        verdict = "real" if boot and boot["beats_current"] else "within noise"
        print(
            f"    {name:<26} {auc:>6.3f} {auc - baseline:>+11.3f} "
            f"{span:>18} {verdict:>12}"
        )

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

    per_dimension = _per_dimension(features, labels, users)
    candidate_weights = _candidate_weightings(per_dimension)

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
        "per_dimension": per_dimension,
        "candidates": {
            name: {
                "auc": _weighted_user_auc(features @ weights, labels, users),
                "weights": {d: float(weights[i]) for i, d in enumerate(DIMENSIONS)},
            }
            for name, weights in candidate_weights.items()
        },
        "bootstrap": _paired_bootstrap(features, labels, users, candidate_weights),
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
