"""Offline ranking-quality evaluation for the vector match engine.

Read-only. Re-scores every labeled (job, user) pair with the *current* vector
scorer and measures how well that ranking separates jobs a user actually
applied to from jobs they did not.

  Ground truth   valid_job_user_applications (applied = positive)
  Candidate pool job_match_results (pairs that were actually scored/surfaced)

Metrics are computed per user and then aggregated. Base rates and pool sizes
differ a lot between users, so a single pooled AUC would mostly measure
between-user differences rather than ranking quality.

The stored score on each row is evaluated alongside the freshly computed one.
Use --era to grade an engine only on the rows it wrote, which is the fairest
head-to-head the historical data supports; otherwise the engine whose scores
were on screen at decision time gets an unearned advantage.

Where a stored inputs_fingerprint exists, the run also reports how many scores
are no longer reproducible, split by whether the encodings moved or the scorer
did.

Caveat that no metric here can remove: users see the score in the dashboard and
low-scoring jobs are surfaced less aggressively, so applications are partly a
consequence of the score rather than an independent judgment of it.

Usage:
    python -m scripts.eval_match_ranking
    python -m scripts.eval_match_ranking --min-positives 3 --json report.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from collections import defaultdict
from typing import Any, Iterable, Sequence

from sqlalchemy import select, text
from sqlalchemy.orm import undefer

from app.models.database import JobEncoding, UserEncoding
from app.services.vector_match_service import SCORER_VERSION, score_pair
from app.storage.database import close_database, get_session, init_database

TOP_K = (5, 10, 25, 50)

# Each era's *stored* score is the one that was actually displayed to the user
# while they decided whether to apply. Grading an engine on its own era is the
# closest thing to a fair head-to-head the historical data supports: both
# engines then carry the same presentation bias rather than only one.
#
# job_match_results.match_engine is populated going forward and was backfilled
# by migration 067 from the date the vector scorer landed (2026-09-02).
ERAS = ("all", "llm", "vector")


# ── metrics ──────────────────────────────────────────────────────────────────


def roc_auc(scores: Sequence[float], labels: Sequence[bool]) -> float | None:
    """Rank-based ROC-AUC (Mann-Whitney U) with correct handling of ties.

    Returns None when the sample is degenerate (all positive or all negative),
    which is common per-user and must not be silently counted as 0.5.
    """
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        shared = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = shared
        i = j + 1

    n_pos = sum(1 for label in labels if label)
    n_neg = len(labels) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    positive_rank_sum = sum(r for r, label in zip(ranks, labels) if label)
    return (positive_rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def auc_interval(
    auc: float | None, n_pos: int, n_neg: int, z: float = 1.96
) -> tuple[float, float] | None:
    """95% confidence interval for an AUC (Hanley & McNeil).

    A handful of positives produces an interval so wide that the point estimate
    carries no information. Reporting the estimate alone invites reading noise
    as a defect and chasing a bug that is not there.
    """
    if auc is None or n_pos <= 0 or n_neg <= 0:
        return None
    q1 = auc / (2 - auc)
    q2 = 2 * auc * auc / (1 + auc)
    variance = (
        auc * (1 - auc)
        + (n_pos - 1) * (q1 - auc * auc)
        + (n_neg - 1) * (q2 - auc * auc)
    ) / (n_pos * n_neg)
    se = math.sqrt(max(variance, 0.0))
    return max(0.0, auc - z * se), min(1.0, auc + z * se)


def precision_recall_at_k(
    scores: Sequence[float], labels: Sequence[bool], k: int
) -> tuple[float, float] | None:
    """Precision and recall over the top-k ranked items. None if pool < k."""
    if len(scores) < k:
        return None
    n_pos = sum(1 for label in labels if label)
    if n_pos == 0:
        return None
    ranked = sorted(range(len(scores)), key=lambda i: -scores[i])[:k]
    hits = sum(1 for i in ranked if labels[i])
    return hits / k, hits / n_pos


def _mean(values: Iterable[float]) -> float | None:
    collected = [v for v in values if v is not None]
    return sum(collected) / len(collected) if collected else None


# ── data loading ─────────────────────────────────────────────────────────────


async def _evaluate(
    min_positives: int, exclude_stale: bool, era: str
) -> dict[str, Any]:
    await init_database()
    try:
        return await _evaluate_inner(min_positives, exclude_stale, era)
    finally:
        await close_database()


async def _evaluate_inner(
    min_positives: int, exclude_stale: bool, era: str
) -> dict[str, Any]:
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

        params: dict[str, Any] = {}
        where = ""
        if era != "all":
            where = "WHERE r.match_engine = :engine"
            params["engine"] = era

        rows = (
            await session.execute(
                text(
                    f"""
                    SELECT r.job_id,
                           r.user_id,
                           r.overall_score              AS stored_score,
                           r.inputs_fingerprint         AS stored_fingerprint,
                           (a.id IS NOT NULL)           AS applied,
                           (e.encoded_at < j.updated_at) AS stale_encoding
                    FROM job_match_results r
                    JOIN jobs j ON j.id = r.job_id
                    LEFT JOIN job_encodings e ON e.job_id = r.job_id
                    LEFT JOIN valid_job_user_applications a
                           ON a.job_id = r.job_id AND a.user_id = r.user_id
                    {where}
                    """
                ),
                params,
            )
        ).all()

        skipped = {
            "no_job_encoding": 0,
            "no_user_encoding": 0,
            "model_mismatch": 0,
            "stale_encoding": 0,
        }
        stale_seen = 0
        # Drift accounting, only possible for rows written after migration 067.
        drift = {"comparable": 0, "inputs_changed": 0, "scorer_changed": 0}
        per_user: dict[str, dict[str, list]] = defaultdict(
            lambda: {"fresh": [], "stored": [], "labels": []}
        )

        for job_id, user_id, stored_score, stored_fp, applied, stale in rows:
            user_enc = user_encs.get(user_id)
            job_enc = job_encs.get(job_id)
            if user_enc is None:
                skipped["no_user_encoding"] += 1
                continue
            if job_enc is None:
                skipped["no_job_encoding"] += 1
                continue
            if job_enc.model_version != user_enc.model_version:
                skipped["model_mismatch"] += 1
                continue
            if stale:
                stale_seen += 1
                if exclude_stale:
                    skipped["stale_encoding"] += 1
                    continue

            scored = score_pair(job_enc, user_enc)
            fresh_score = float(scored["overall_score"])

            if stored_fp:
                drift["comparable"] += 1
                if scored["inputs_fingerprint"] != stored_fp:
                    drift["inputs_changed"] += 1
                elif fresh_score != float(stored_score or 0):
                    # Identical inputs, different score: the scorer itself moved.
                    drift["scorer_changed"] += 1

            bucket = per_user[user_id]
            bucket["fresh"].append(fresh_score)
            bucket["stored"].append(float(stored_score or 0))
            bucket["labels"].append(bool(applied))

    # ── aggregate ────────────────────────────────────────────────────────────
    users: list[dict[str, Any]] = []
    for user_id, bucket in per_user.items():
        labels = bucket["labels"]
        n_pos = sum(1 for label in labels if label)
        if n_pos < min_positives or n_pos == len(labels):
            continue
        auc_fresh = roc_auc(bucket["fresh"], labels)
        ci = auc_interval(auc_fresh, n_pos, len(labels) - n_pos)
        entry: dict[str, Any] = {
            "user_id": user_id,
            "pool": len(labels),
            "applied": n_pos,
            "base_rate": n_pos / len(labels),
            "auc_fresh": auc_fresh,
            "auc_stored": roc_auc(bucket["stored"], labels),
            "auc_fresh_ci": ci,
            # A result is only informative if its interval excludes chance.
            "conclusive": bool(ci and (ci[0] > 0.5 or ci[1] < 0.5)),
        }
        for k in TOP_K:
            for name, scores in (("fresh", bucket["fresh"]), ("stored", bucket["stored"])):
                got = precision_recall_at_k(scores, labels, k)
                entry[f"p@{k}_{name}"] = got[0] if got else None
                entry[f"r@{k}_{name}"] = got[1] if got else None
        users.append(entry)

    users.sort(key=lambda e: -e["pool"])
    total_pos = sum(e["applied"] for e in users)

    def weighted(metric: str) -> float | None:
        """Average across users, weighted by positive count."""
        pairs = [(e[metric], e["applied"]) for e in users if e.get(metric) is not None]
        if not pairs:
            return None
        return sum(v * w for v, w in pairs) / sum(w for _, w in pairs)

    all_diffs = [
        abs(f - s)
        for bucket in per_user.values()
        for f, s in zip(bucket["fresh"], bucket["stored"])
    ]

    summary: dict[str, Any] = {
        "era": era,
        "stored_engine": {"llm": "LLM", "vector": "vector", "all": "mixed"}[era],
        "scorer_version": SCORER_VERSION,
        "evaluated_pairs": sum(e["pool"] for e in users),
        "evaluated_users": len(users),
        "total_applications": total_pos,
        "pooled_base_rate": (
            total_pos / sum(e["pool"] for e in users) if users else None
        ),
        "skipped": skipped,
        "stale_encoding_pairs": stale_seen,
        "excluded_stale": exclude_stale,
        "mean_abs_diff_fresh_vs_stored": _mean(all_diffs),
        "drift": drift,
        "auc_fresh_weighted": weighted("auc_fresh"),
        "auc_stored_weighted": weighted("auc_stored"),
        "auc_fresh_macro": _mean(e["auc_fresh"] for e in users),
        "auc_stored_macro": _mean(e["auc_stored"] for e in users),
        "conclusive_users": sum(1 for e in users if e["conclusive"]),
        "auc_fresh_macro_conclusive": _mean(
            e["auc_fresh"] for e in users if e["conclusive"]
        ),
    }
    for k in TOP_K:
        summary[f"p@{k}_fresh"] = weighted(f"p@{k}_fresh")
        summary[f"p@{k}_stored"] = weighted(f"p@{k}_stored")
        summary[f"r@{k}_fresh"] = weighted(f"r@{k}_fresh")

    return {"summary": summary, "per_user": users}


# ── reporting ────────────────────────────────────────────────────────────────


def _pct(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value * 100:.{digits}f}%"


def _num(value: float | None, digits: int = 3) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _print_report(report: dict[str, Any]) -> None:
    s = report["summary"]
    print()
    print("Vector match engine - ranking quality vs real applications")
    print(f"  era               {s['era']}  (stored score was produced by: {s['stored_engine']})")
    print(f"  scorer_version    {s['scorer_version']}")
    print(f"  evaluated         {s['evaluated_pairs']} pairs / {s['evaluated_users']} users")
    print(f"  applications      {s['total_applications']} (base rate {_pct(s['pooled_base_rate'], 2)})")
    skipped = s["skipped"]
    if any(skipped.values()):
        print(f"  skipped           {skipped}")
    print(
        f"  stale encodings   {s['stale_encoding_pairs']} pairs"
        f"{' (excluded)' if s['excluded_stale'] else ' (included)'}"
    )
    print(f"  fresh vs stored   {_num(s['mean_abs_diff_fresh_vs_stored'], 1)} mean absolute point difference")
    drift = s["drift"]
    if drift["comparable"]:
        print(
            f"  reproducibility   {drift['comparable']} pairs have a stored fingerprint: "
            f"{drift['inputs_changed']} encodings changed, "
            f"{drift['scorer_changed']} scorer changed"
        )
    else:
        print("  reproducibility   no stored fingerprints yet (rows predate migration 067)")

    print()
    print("  ROC-AUC (1.0 perfect, 0.5 random) - per user, weighted by applications")
    print(f"    current vector engine   {_num(s['auc_fresh_weighted'])}   (macro {_num(s['auc_fresh_macro'])})")
    print(
        f"    stored ({s['stored_engine']}) as shown  {_num(s['auc_stored_weighted'])}"
        f"   (macro {_num(s['auc_stored_macro'])})"
    )
    print(
        f"    macro over the {s['conclusive_users']} users whose interval excludes chance: "
        f"{_num(s['auc_fresh_macro_conclusive'])}"
    )

    print()
    print("  Top-k precision / recall - current vector engine")
    header = f"    {'k':>4}  {'precision':>10}  {'recall':>8}  {'lift':>6}   {'stored p@k':>10}"
    print(header)
    base = s["pooled_base_rate"] or 0
    for k in TOP_K:
        p = s[f"p@{k}_fresh"]
        r = s[f"r@{k}_fresh"]
        lift = (p / base) if (p is not None and base) else None
        print(
            f"    {k:>4}  {_pct(p):>10}  {_pct(r):>8}  "
            f"{('n/a' if lift is None else f'{lift:.1f}x'):>6}   {_pct(s[f'p@{k}_stored']):>10}"
        )

    print()
    print("  Per user")
    print(
        f"    {'user':>10}  {'pool':>6}  {'applied':>8}  {'base':>7}  "
        f"{'auc':>6}  {'95% interval':>16}  {'verdict':>12}"
    )
    for e in report["per_user"]:
        ci = e["auc_fresh_ci"]
        span = "n/a" if ci is None else f"{ci[0]:.3f} - {ci[1]:.3f}"
        if not e["conclusive"]:
            verdict = "inconclusive"
        elif (e["auc_fresh"] or 0) > 0.5:
            verdict = "better"
        else:
            verdict = "INVERTED"
        print(
            f"    {e['user_id'][:8]:>10}  {e['pool']:>6}  {e['applied']:>8}  "
            f"{_pct(e['base_rate'], 1):>7}  {_num(e['auc_fresh'], 3):>6}  "
            f"{span:>16}  {verdict:>12}"
        )
    print()
    print("  Applications are partly caused by the score (users see it, and low")
    print("  scorers are surfaced less), so treat these as an upper bound.")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--min-positives",
        type=int,
        default=2,
        help="skip users with fewer applications than this (default 2)",
    )
    parser.add_argument(
        "--exclude-stale",
        action="store_true",
        help="drop pairs whose job encoding predates the job's last update",
    )
    parser.add_argument(
        "--era",
        choices=ERAS,
        default="all",
        help="restrict to rows whose match_engine column is llm or vector",
    )
    parser.add_argument("--json", help="also write the full report to this path")
    args = parser.parse_args()

    report = asyncio.run(_evaluate(args.min_positives, args.exclude_stale, args.era))
    _print_report(report)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"  wrote {args.json}")


if __name__ == "__main__":
    main()
