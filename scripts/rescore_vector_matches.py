"""Re-score stored vector-engine match results with the current scorer.

Stored scores carry the scorer_version that produced them. When the scorer
changes, existing rows keep the old numbers until something re-analyses the
job, so what a user sees can disagree with what the engine would say today.
This closes that gap without waiting for re-ingestion.

Only rows attributed to the vector engine are touched. LLM-era rows are left
alone on purpose: their summary, strengths and gaps are model-written prose,
and replacing them with vector output would not be a consistency fix but a
silent downgrade of those rows to a different engine's analysis.

Defaults to a dry run that reports the score movement it would cause. Pass
--apply to write.

Usage:
    python -m scripts.rescore_vector_matches
    python -m scripts.rescore_vector_matches --apply
"""

from __future__ import annotations

import argparse
import asyncio

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.models.database import JobEncoding, JobMatchResult, UserEncoding
from app.services.vector_match_service import SCORER_VERSION, score_pair
from app.storage.database import close_database, get_session, init_database


async def _rescore(apply_changes: bool, batch_size: int) -> None:
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
                            undefer(UserEncoding.chunk_vecs),
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
                            undefer(JobEncoding.chunk_vecs),
                        )
                    )
                )
                .scalars()
                .all()
            }
            rows = (
                (
                    await session.execute(
                        select(JobMatchResult).where(
                            JobMatchResult.match_engine == "vector"
                        )
                    )
                )
                .scalars()
                .all()
            )

            print()
            print(f"Re-scoring vector-engine rows with {SCORER_VERSION}")
            print(f"  candidate rows              {len(rows)}")

            deltas: list[int] = []
            already_current = 0
            missing_encoding = 0
            mismatched_model = 0
            changed = 0

            for row in rows:
                if row.scorer_version == SCORER_VERSION:
                    already_current += 1
                    continue
                job_enc = job_encs.get(row.job_id)
                user_enc = user_encs.get(row.user_id)
                if job_enc is None or user_enc is None:
                    missing_encoding += 1
                    continue
                if job_enc.model_version != user_enc.model_version:
                    # Cosines across different embedding models are meaningless;
                    # re-encoding is the fix, not re-scoring.
                    mismatched_model += 1
                    continue

                result = score_pair(job_enc, user_enc)
                deltas.append(int(result["overall_score"]) - int(row.overall_score or 0))
                changed += 1

                if apply_changes:
                    row.overall_score = result["overall_score"]
                    row.dimension_scores = result["dimension_scores"]
                    row.summary = result["summary"]
                    row.strengths = result["strengths"]
                    row.gaps = result["gaps"]
                    row.recommendation = str(result["recommendation"])[:50]
                    row.scorer_version = result["scorer_version"]
                    row.model_version = result["model_version"]
                    row.inputs_fingerprint = result["inputs_fingerprint"]
                    if changed % batch_size == 0:
                        await session.flush()

            print(f"  already on {SCORER_VERSION[:20]:<20} {already_current}")
            print(f"  skipped, no encoding        {missing_encoding}")
            print(f"  skipped, model mismatch     {mismatched_model}")
            print(f"  {'rewritten' if apply_changes else 'would rewrite':<27} {changed}")

            if deltas:
                arr = np.asarray(deltas)
                print()
                print("  Score movement")
                print(f"    mean                      {arr.mean():+.1f}")
                print(f"    median                    {np.median(arr):+.1f}")
                print(f"    p10 / p90                 {np.percentile(arr, 10):+.0f} / {np.percentile(arr, 90):+.0f}")
                print(f"    unchanged                 {int((arr == 0).sum())}")
                print(f"    moved more than 10 points {int((np.abs(arr) > 10).sum())}")

            if apply_changes:
                await session.commit()
                print()
                print("  committed")
            else:
                print()
                print("  dry run, nothing written. Pass --apply to commit.")
            print()
    finally:
        await close_database()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="write the new scores (default: dry run)"
    )
    parser.add_argument("--batch-size", type=int, default=200)
    args = parser.parse_args()
    asyncio.run(_rescore(args.apply, args.batch_size))


if __name__ == "__main__":
    main()
