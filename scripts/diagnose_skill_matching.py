"""Why the skills dimension ranks barely better than chance.

skills_match carries the largest weight in MATCH_DIMENSION_WEIGHTS (0.32) but
scores an AUC of ~0.575 against real applications -- the second weakest of the
six. This script separates the candidate explanations, because they imply
different fixes:

  no signal to match     the job has no extracted skills at all, so _score_skills
                         returns a flat 50 and the dimension is a constant.
  vocabulary mismatch    both sides have skills but the exact-string lookup
                         (`if skill in user_skills`) misses pairs a human would
                         call the same skill: "Postgres"/"PostgreSQL",
                         "React.js"/"React", differing case or punctuation.
  genuinely disjoint     the skills really are different, and the low score is
                         correct.

Only the middle one is a bug in the scorer; the first is an extraction gap and
the last is not a problem at all. The counts below say which dominates.

Read-only; no LLM calls, no writes.

Usage:
    python -m scripts.diagnose_skill_matching
"""

from __future__ import annotations

import asyncio
import math
import re
from collections import Counter

import numpy as np
from sqlalchemy import select, text

from app.models.database import JobEncoding, UserEncoding
from app.services.vector_match_service import _score_skills
from app.storage.database import close_database, get_session, init_database
from scripts.fit_match_weights import _weighted_user_auc


def _normalize(skill: str) -> str:
    """Casefold and strip punctuation/spacing the exact lookup treats as distinct."""
    return re.sub(r"[^a-z0-9]", "", skill.casefold())


async def _run() -> None:
    await init_database()
    try:
        async with get_session() as session:
            users = {
                u.user_id: {str(k): v for k, v in dict(u.skills or {}).items()}
                for u in (await session.execute(select(UserEncoding))).scalars().all()
            }
            jobs = {
                j.job_id: {str(k): v for k, v in dict(j.skills or {}).items()}
                for j in (await session.execute(select(JobEncoding))).scalars().all()
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

    empty_jobs = sum(1 for s in jobs.values() if not s)
    print()
    print("Skill extraction coverage")
    print(f"  jobs encoded                {len(jobs)}")
    print(f"  jobs with no skills at all  {empty_jobs}  ({empty_jobs / max(len(jobs), 1):.0%})")
    sizes = [len(s) for s in jobs.values() if s]
    if sizes:
        sizes.sort()
        print(f"  skills per job (median)     {sizes[len(sizes) // 2]}")
    print()
    print("Users")
    for user_id, skills in users.items():
        print(f"  {str(user_id)[:8]}  {len(skills):>4} skills")

    # How the exact lookup performs on real pairs, and what normalisation alone
    # would recover. A large gap here means the scorer is throwing away matches
    # it already has the data for.
    exact_hits = 0
    normalized_hits = 0
    considered = 0
    constant_pairs = 0
    recovered: Counter[str] = Counter()

    for job_id, user_id, _applied in pairs:
        job_skills, user_skills = jobs.get(job_id), users.get(user_id)
        if job_skills is None or user_skills is None:
            continue
        if not job_skills:
            constant_pairs += 1
            continue
        norm_user = {_normalize(s): s for s in user_skills}
        for skill in job_skills:
            considered += 1
            if skill in user_skills:
                exact_hits += 1
                normalized_hits += 1
            elif _normalize(skill) in norm_user:
                normalized_hits += 1
                recovered[f"{skill!r} ~ {norm_user[_normalize(skill)]!r}"] += 1

    print()
    print("Skill lookups across labelled pairs")
    print(f"  pairs scored                {len(pairs)}")
    print(
        f"  pairs with no job skills    {constant_pairs} "
        f" ({constant_pairs / max(len(pairs), 1):.0%} score a flat 50)"
    )
    print(f"  individual skill lookups    {considered}")
    print(f"  hit, exact match            {exact_hits}  ({exact_hits / max(considered, 1):.1%})")
    print(
        f"  hit, after normalisation    {normalized_hits} "
        f" ({normalized_hits / max(considered, 1):.1%})"
    )
    gained = normalized_hits - exact_hits
    print(
        f"  recovered by normalisation  {gained} "
        f" (+{gained / max(considered, 1):.1%} of all lookups)"
    )
    if recovered:
        print()
        print("  Most common near-misses the exact lookup drops")
        for label, count in recovered.most_common(15):
            print(f"    {count:>5}x  {label}")

    _compare_scorers(jobs, users, pairs)
    print()


def _compare_scorers(
    jobs: dict[str, dict[str, str]],
    users: dict[str, dict[str, float]],
    pairs: list[tuple[str, str, bool]],
) -> None:
    """Does a different way of scoring the same skill sets rank any better?

    A match on "Python" says almost nothing -- most postings in a field list it.
    A match on something only 2% of postings ask for is far more telling. The
    current scorer weights only by the posting's own stated importance, which
    does not capture that. These variants test whether rarity is the missing
    ingredient, using the skill data already stored.
    """
    document_frequency: Counter[str] = Counter()
    for skills in jobs.values():
        document_frequency.update(skills.keys())
    corpus = max(len(jobs), 1)

    def idf(skill: str) -> float:
        return math.log(corpus / (1 + document_frequency.get(skill, 0)))

    variants: dict[str, list[float]] = {
        "current": [],
        "idf_weighted": [],
        "jaccard": [],
        "rare_skills_only": [],
    }
    labels: list[int] = []
    owners: list[str] = []

    for job_id, user_id, applied in pairs:
        job_skills, user_skills = jobs.get(job_id), users.get(user_id)
        if not job_skills or user_skills is None:
            continue
        labels.append(int(bool(applied)))
        owners.append(user_id)

        coverage = _score_skills(job_skills, user_skills)[0]
        variants["current"].append(50.0 if coverage is None else 100.0 * coverage)

        total = sum(idf(s) for s in job_skills) or 1.0
        got = sum(idf(s) for s in job_skills if s in user_skills)
        variants["idf_weighted"].append(100.0 * got / total)

        union = set(job_skills) | set(user_skills)
        overlap = set(job_skills) & set(user_skills)
        variants["jaccard"].append(100.0 * len(overlap) / max(len(union), 1))

        # Only skills asked for by fewer than 10% of postings.
        rare = [s for s in job_skills if document_frequency.get(s, 0) < 0.1 * corpus]
        hit = sum(1 for s in rare if s in user_skills)
        variants["rare_skills_only"].append(100.0 * hit / len(rare) if rare else 50.0)

    label_array = np.asarray(labels)
    owner_array = np.asarray(owners)
    print()
    print("Ranking quality of alternative skill scorers (same underlying data)")
    print(f"  pairs with job skills       {len(labels)}")
    print(f"    {'scorer':<22} {'auc':>6} {'vs current':>11}")
    base = _weighted_user_auc(
        np.asarray(variants["current"]), label_array, owner_array
    )
    for name, values in variants.items():
        auc = _weighted_user_auc(np.asarray(values), label_array, owner_array)
        if auc is None or base is None:
            print(f"    {name:<22} {'n/a':>6}")
            continue
        delta = "" if name == "current" else f"{auc - base:+.3f}"
        print(f"    {name:<22} {auc:>6.3f} {delta:>11}")


if __name__ == "__main__":
    asyncio.run(_run())
