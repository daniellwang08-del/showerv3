"""Real-profile quality evaluation for the resume tailoring engine (read-only).

Unlike ``eval_tailoring.py`` (synthetic candidates), this grades tailoring for a real
user's profile against real postings, using the ATS research rubric in
``eval_data/tailoring_rubric.md``. Nothing is written to the database and every LLM
call runs with ``user_id=None`` so usage is not billed to the user.

Phase A inputs are frozen once by ``snapshot`` so later runs compare Phase B prompt
and validator changes on identical inputs:

    python scripts/eval_tailoring_real.py snapshot --email a@b.com --jobs <id>,<id> --jd irvine=/tmp/irvine.txt
    python scripts/eval_tailoring_real.py tailor --label before        # run with the old checkout on PYTHONPATH
    python scripts/eval_tailoring_real.py tailor --label after
    python scripts/eval_tailoring_real.py judge --label after --against before
    python scripts/eval_tailoring_real.py judge --label before --against stored   # vs the resumes saved in the DB
    EVAL_TAILOR_MODEL=gpt-6.1-sol EVAL_TAILOR_EFFORT=high python scripts/eval_tailoring_real.py tailor --label ceiling

Files land in ``$EVAL_OUT`` (default /tmp/nao_eval). They contain the user's profile,
so keep them out of the repository.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import time
from pathlib import Path

OUT_DIR = Path(os.environ.get("EVAL_OUT", "/tmp/nao_eval"))
CASES_PATH = OUT_DIR / "real_cases.json"
RUBRIC_PATH = Path(__file__).parent / "eval_data" / "tailoring_rubric.md"
JUDGE_MODEL = os.environ.get("EVAL_JUDGE_MODEL", "gpt-6.1-sol")
NO_EVIDENCE = "No project source evidence available."

# A change ships only if the judged run clears every gate.
GATES = {
    "high_fabrications_max": 0,
    "truthfulness_min": 8.0,
    "exact_terminology_min": 7.0,
    "conciseness_min": 7.0,
}

GRADE_PROMPT = """{rubric}

## JOB POSTING
{jd}

## CANDIDATE PROFILE (the only source of truth about the candidate)
{profile}

## TAILORED RESUME (JSON; **text** renders as bold)
{resume}
"""

PAIR_PROMPT = """You are comparing two tailored resumes produced for the SAME job posting from the SAME
candidate profile. Judge as (1) a modern ATS ranking engine and (2) the recruiter who reads the
shortlist. Truthfulness to the profile is a hard constraint: a fabricated claim outweighs style.

Return JSON:
{{"winner": "A" | "B" | "tie", "margin": "slight" | "clear" | "decisive",
  "ats_winner": "A" | "B" | "tie", "recruiter_winner": "A" | "B" | "tie", "truthfulness_winner": "A" | "B" | "tie",
  "a_weaknesses": [..], "b_weaknesses": [..], "reasoning": "<4-6 sentences>"}}

## JOB POSTING
{jd}

## CANDIDATE PROFILE
{profile}

## RESUME A
{a}

## RESUME B
{b}
"""


def _match_summary(summary, strengths, gaps) -> str:
    parts = [str(summary).strip()] if (summary or "").strip() else []
    s = [f"- {x.strip()}" for x in strengths or [] if isinstance(x, str) and x.strip()][:8]
    if s:
        parts.append("Match strengths to emphasize:\n" + "\n".join(s))
    g = [f"- {x.strip()}" for x in gaps or [] if isinstance(x, str) and x.strip()][:6]
    if g:
        parts.append("Gaps to avoid inventing or overstating:\n" + "\n".join(g))
    return "\n\n".join(parts)


async def snapshot(email: str, job_ids: list[str], pasted: list[tuple[str, str]]) -> None:
    from sqlalchemy import text

    from app.models.schemas import JobDescriptionSchema
    from app.services.job_field_utils import parse_job_title
    from app.services.job_match_orchestrator import _load_job_and_profile
    from app.services.job_match_service import analyze_job_match_phase_a, build_structured_context
    from app.storage.database import get_session, init_database
    from app.storage.repository import JobExtractionRepository, JobMatchRepository
    from app.storage.user_repository import UserRepository

    await init_database()
    async with get_session() as s:
        user = (
            await s.execute(text("select id, job_match_preferences from users where email=:e"), {"e": email})
        ).first()
    if not user:
        raise SystemExit(f"no user {email}")
    uid, prefs = str(user[0]), user[1] or ""

    async def existing(job_id: str) -> dict:
        ext_id, job_text, profile_text = await _load_job_and_profile(job_id, uid, None)
        async with get_session() as s:
            ext = await JobExtractionRepository(s).get_by_id(ext_id)
            m = await JobMatchRepository(s).get(job_id, uid)
            stored = (
                await s.execute(
                    text("select tailored_resume_data from resume_build_results where job_id=:j and user_id=:u"),
                    {"j": job_id, "u": uid},
                )
            ).first()
        structured = None
        if ext and ext.description:
            structured = JobDescriptionSchema(
                title=parse_job_title(ext.title), company=ext.company, location=ext.location,
                employment_type=ext.employment_type, salary_range=ext.salary_range,
                description=ext.description or "", responsibilities=ext.responsibilities or [],
                requirements=ext.requirements or [], benefits=ext.benefits or [],
                remote_policy=ext.remote_policy, work_mode=ext.work_mode,
                experience_level=ext.experience_level, industry=ext.industry,
            )
        return {
            "key": job_id[:8], "title": ext.title if ext else "", "company": ext.company if ext else "",
            "job_text": job_text, "profile_text": profile_text,
            "structured_context": build_structured_context(structured),
            "match_summary": _match_summary(m.summary if m else "", m.strengths if m else [], m.gaps if m else []),
            "stored_resume": stored[0] if stored else None,
        }

    async def pasted_case(key: str, path: str) -> dict:
        jd = Path(path).read_text(encoding="utf-8")
        async with get_session() as s:
            profile_text = await UserRepository(s).get_profile_openai_text(uid)
        match, structured, _ = await analyze_job_match_phase_a(
            jd, profile_text, job_preferences=prefs, custom_guidance="", source_documents_context=""
        )
        return {
            "key": key, "title": structured.title if structured else "",
            "company": structured.company if structured else "",
            "job_text": jd, "profile_text": profile_text,
            "structured_context": build_structured_context(structured),
            "match_summary": _match_summary(match.get("summary"), match.get("strengths"), match.get("gaps")),
            "stored_resume": None,
        }

    cases = list(await asyncio.gather(*[existing(j) for j in job_ids], *[pasted_case(k, p) for k, p in pasted]))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CASES_PATH.write_text(json.dumps(cases, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"wrote {len(cases)} cases to {CASES_PATH}")


def _override_tailor_model() -> None:
    """Point Phase B at ``$EVAL_TAILOR_MODEL`` / ``$EVAL_TAILOR_EFFORT`` for this process only."""
    model = os.environ.get("EVAL_TAILOR_MODEL", "").strip()
    effort = os.environ.get("EVAL_TAILOR_EFFORT", "").strip()
    if not model and not effort:
        return
    from app.core import llm_client
    from app.core.llm_client import get_llm_client
    from app.services import job_match_service as svc

    if model:
        is_reasoning = llm_client._is_openai_reasoning_model
        llm_client._is_openai_reasoning_model = lambda m: m == model or is_reasoning(m)

        async def _client(user_id=None, job_type=None):
            return get_llm_client(provider="openai", openai_model=model)

        svc.get_llm_client_for_user = _client
    original = svc._call_openai_json

    async def _call(**kwargs):
        if effort:
            kwargs["reasoning_effort"] = effort
            kwargs["max_tokens"] = max(kwargs.get("max_tokens") or 0, 32000)
        return await original(**kwargs)

    svc._call_openai_json = _call
    print(f"tailor override: model={model or 'default'} effort={effort or 'default'}", flush=True)


async def tailor(label: str) -> None:
    from app.services.job_match_service import generate_tailored_content_phase_b
    from app.storage.database import init_database

    _override_tailor_model()
    await init_database()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    sem = asyncio.Semaphore(int(os.environ.get("EVAL_CONCURRENCY", "6")))

    async def one(case: dict) -> dict:
        async with sem:
            retried = False

            async def on_stage(stage: str) -> None:
                nonlocal retried
                retried = retried or stage == "quality_retry"

            t0 = time.monotonic()
            try:
                resume, _ = await generate_tailored_content_phase_b(
                    case["job_text"],
                    case["profile_text"],
                    structured_context=case["structured_context"],
                    match_summary=case["match_summary"],
                    project_evidence_context=NO_EVIDENCE,
                    include_cover_letter=False,
                    on_stage=on_stage,
                )
            except Exception as e:  # noqa: BLE001 - one failed case must not sink the run
                resume = None
                print(f"{case['key']}: {e!r}", flush=True)
            secs = round(time.monotonic() - t0, 1)
            print(f"{case['key']} {case['title'][:40]} t={secs}s retry={retried} ok={bool(resume)}", flush=True)
            return {"key": case["key"], "resume": resume, "seconds": secs, "quality_retry": retried}

    rows = await asyncio.gather(*(one(c) for c in cases))
    path = OUT_DIR / f"{label}.resumes.json"
    path.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {path}")


def _sections(r: dict) -> dict[str, str]:
    we = r.get("work_experience") or []

    def roles(entries: list) -> str:
        return "\n".join(
            "\n".join([e.get("project_description") or "", e.get("used_skills") or ""] + list(e.get("bullets") or []))
            for e in entries
        )

    out = {
        "summary": r.get("profile_summary") or "",
        "skills": "\n".join(f"{s.get('category')}: {s.get('skills')}" for s in r.get("technical_skills") or []),
        "recent": roles(we[:2]),
        "older": roles(we[2:]),
    }
    return {k: v.replace("**", "").lower() for k, v in out.items()}


def stats(r: dict) -> dict:
    we = r.get("work_experience") or []
    bullets = [b for e in we for b in e.get("bullets") or []]
    words = [len(b.replace("**", "").split()) for b in bullets]
    summary = (r.get("profile_summary") or "").replace("**", "")
    total = sum(words) + len(summary.split())
    total += sum(len((e.get("project_description") or "").split()) for e in we)
    total += sum(len((s.get("skills") or "").split()) for s in r.get("technical_skills") or [])
    metric = re.compile(r"\d+(\.\d+)?\s?(%|x|k|m|ms|s|\+|million|billion|hours|users|requests)|\$\d", re.I)
    return {
        "bullets": len(bullets),
        "bullets_per_role": [len(e.get("bullets") or []) for e in we],
        "total_words": total,
        "est_pages": round(total / 520, 2),
        "avg_bullet_words": round(sum(words) / max(len(words), 1), 1),
        "bullets_with_metric": sum(1 for b in bullets if metric.search(b)),
        "summary_words": len(summary.split()),
        "skills_count": sum(
            len([x for x in (s.get("skills") or "").split(",") if x.strip()]) for s in r.get("technical_skills") or []
        ),
    }


def coverage(keywords: list[str], r: dict) -> dict:
    sec = _sections(r)
    kws = [k for k in keywords if isinstance(k, str) and k.strip()]

    def has(k: str, t: str) -> bool:
        return re.search(r"(?<![a-z0-9])" + re.escape(k.lower()) + r"(?![a-z0-9])", t) is not None

    res = {name: round(sum(1 for k in kws if has(k, t)) / max(len(kws), 1), 3) for name, t in sec.items()}
    allt = " ".join(sec.values())
    res["anywhere"] = round(sum(1 for k in kws if has(k, allt)) / max(len(kws), 1), 3)
    return res


async def _judge_call(client, prompt: str) -> dict:
    for attempt in range(3):
        try:
            resp = await client.chat.completions.create(
                model=JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                reasoning_effort="high",
                max_completion_tokens=40000,
            )
            return json.loads(resp.choices[0].message.content or "{}")
        except Exception as e:  # noqa: BLE001
            print("judge retry", attempt, repr(e)[:200], flush=True)
            await asyncio.sleep(5)
    return {"error": "judge failed"}


def _load_resumes(label: str, cases: list[dict]) -> dict[str, dict | None]:
    if label == "stored":
        return {c["key"]: c.get("stored_resume") for c in cases}
    rows = json.loads((OUT_DIR / f"{label}.resumes.json").read_text(encoding="utf-8"))
    return {r["key"]: r.get("resume") for r in rows}


def _avg(vals) -> float:
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(sum(vals) / max(len(vals), 1), 2)


async def judge(label: str, against: str | None) -> None:
    from openai import AsyncOpenAI

    from app.core.config import get_settings
    from app.utils.resume_evidence import is_mentioned

    rubric = RUBRIC_PATH.read_text(encoding="utf-8")
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    mine = _load_resumes(label, cases)
    other = _load_resumes(against, cases) if against else {}
    client = AsyncOpenAI(api_key=get_settings().openai_api_key)
    sem = asyncio.Semaphore(int(os.environ.get("EVAL_CONCURRENCY", "6")))
    rng = random.Random(7)

    async def one(case: dict) -> dict | None:
        resume = mine.get(case["key"])
        if not resume:
            return None
        rival = other.get(case["key"])
        jd, prof = case["job_text"], case["profile_text"]
        async with sem:
            tasks = {"grade": _judge_call(client, GRADE_PROMPT.format(
                rubric=rubric, jd=jd, profile=prof, resume=json.dumps(resume, indent=1)))}
            mine_is_a = rng.random() < 0.5
            if rival:
                a, b = (resume, rival) if mine_is_a else (rival, resume)
                tasks["pair"] = _judge_call(client, PAIR_PROMPT.format(
                    jd=jd, profile=prof, a=json.dumps(a, indent=1), b=json.dumps(b, indent=1)))
            res = dict(zip(tasks, await asyncio.gather(*tasks.values())))
        kws = res["grade"].get("jd_keywords") or {}
        flat = [k for v in (kws.values() if isinstance(kws, dict) else [kws]) for k in (v if isinstance(v, list) else [])]
        # Coverage counts only terms the profile supports: matching the rest means inventing them.
        flat = [k for k in flat if isinstance(k, str) and is_mentioned(k, prof)]
        row = {"key": case["key"], "title": case["title"], "grade": res["grade"], "stats": stats(resume),
               "coverage": coverage(flat, resume)}
        if rival:
            pair = res["pair"]

            def side(x):
                return x if x == "tie" or x is None else ("mine" if (x == "A") == mine_is_a else "rival")

            row["rival_coverage"] = coverage(flat, rival)
            row["pair"] = {k: side(pair.get(k)) for k in ("winner", "ats_winner", "recruiter_winner", "truthfulness_winner")}
            row["pair"]["margin"] = pair.get("margin")
            row["pair"]["reasoning"] = pair.get("reasoning")
        print(f"{case['key']} overall={(row['grade'].get('scores') or {}).get('overall')} "
              f"pair={row.get('pair', {}).get('winner')}", flush=True)
        return row

    rows = [r for r in await asyncio.gather(*(one(c) for c in cases)) if r]
    path = OUT_DIR / f"{label}.judge.json"
    path.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")

    scores = [r["grade"].get("scores") or {} for r in rows]
    print(f"\n== {label}: {len(rows)} cases judged by {JUDGE_MODEL} ==")
    for d in sorted({k for s in scores for k in s}):
        print(f"{d:>24}: {_avg([s.get(d) for s in scores])}")
    fabs = [f for r in rows for f in r["grade"].get("fabrications") or [] if isinstance(f, dict)]
    by_sev = {sev: sum(1 for f in fabs if f.get("severity") == sev) for sev in ("high", "medium", "low")}
    print(f"{'fabrications':>24}: {by_sev}")
    for k in ("bullets", "total_words", "est_pages", "avg_bullet_words", "bullets_with_metric", "summary_words", "skills_count"):
        print(f"{k:>24}: {_avg([r['stats'][k] for r in rows])}")
    cov = _avg([r["coverage"]["anywhere"] for r in rows])
    print(f"{'supported_coverage':>24}: {cov}  recent={_avg([r['coverage']['recent'] for r in rows])}")

    gates = {
        "high_fabrications": by_sev["high"] <= GATES["high_fabrications_max"],
        "truthfulness": _avg([s.get("truthfulness") for s in scores]) >= GATES["truthfulness_min"],
        "exact_terminology": _avg([s.get("exact_terminology") for s in scores]) >= GATES["exact_terminology_min"],
        "conciseness": _avg([s.get("conciseness") for s in scores]) >= GATES["conciseness_min"],
    }
    paired = [r for r in rows if "pair" in r]
    if paired:
        rival_cov = _avg([r["rival_coverage"]["anywhere"] for r in paired])
        gates["supported_coverage_vs_" + str(against)] = _avg([r["coverage"]["anywhere"] for r in paired]) >= rival_cov
        wins = {w: sum(1 for r in paired if r["pair"]["winner"] == w) for w in ("mine", "rival", "tie")}
        ats = {w: sum(1 for r in paired if r["pair"]["ats_winner"] == w) for w in ("mine", "rival", "tie")}
        print(f"pairwise vs {against}: overall {wins}, ats {ats}, rival coverage {rival_cov}")
    print("gates:", {k: "pass" if v else "FAIL" for k, v in gates.items()})
    print(f"wrote {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("--email", required=True)
    s.add_argument("--jobs", default="", help="comma-separated stored job ids")
    s.add_argument("--jd", action="append", default=[], help="key=path to a pasted posting")
    t = sub.add_parser("tailor")
    t.add_argument("--label", required=True)
    j = sub.add_parser("judge")
    j.add_argument("--label", required=True)
    j.add_argument("--against", default=None, help="another label, or 'stored' for the saved resumes")
    args = ap.parse_args()
    if args.cmd == "snapshot":
        pasted = [tuple(x.split("=", 1)) for x in args.jd]
        asyncio.run(snapshot(args.email, [x for x in args.jobs.split(",") if x.strip()], pasted))
    elif args.cmd == "tailor":
        asyncio.run(tailor(args.label))
    else:
        asyncio.run(judge(args.label, args.against))


if __name__ == "__main__":
    main()
