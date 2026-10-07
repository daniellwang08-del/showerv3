"""Offline quality evaluation for the resume tailoring engine.

Generates (once) ten very different candidate profiles with matching job postings,
runs each through the real Phase A + Phase B pipeline, and asks a stronger judge
model to grade the tailored resume (ATS fit, skills taxonomy, bullets, truthfulness,
formatting). JD keyword coverage is also measured deterministically.

Usage (inside the app environment, after ``set -a; source .env; set +a``):

    python scripts/eval_tailoring.py generate            # writes the case file
    python scripts/eval_tailoring.py run --label after   # tailor + judge every case
    python scripts/eval_tailoring.py run --label after --only 3,7

Results land in ``$EVAL_OUT`` (default /tmp/nao_eval/<label>.json). Run it against a
second checkout (PYTHONPATH) to compare prompt versions on identical cases.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

from openai import AsyncOpenAI

CASES_PATH = Path(os.environ.get("EVAL_CASES", Path(__file__).parent / "eval_data" / "tailoring_cases.json"))
OUT_DIR = Path(os.environ.get("EVAL_OUT", "/tmp/nao_eval"))
JUDGE_MODEL = os.environ.get("EVAL_JUDGE_MODEL", "gpt-5.5")

ROLE_BRIEFS = [
    "Senior Full Stack Engineer (React, TypeScript, Node.js, PostgreSQL, AWS) at a fintech payments startup",
    "Data Engineer (Spark, Airflow, Snowflake, dbt, Python) at a healthcare analytics company",
    "Machine Learning Engineer (LLMs, PyTorch, RAG, MLOps on GCP) at a B2B SaaS company",
    "Site Reliability Engineer (Kubernetes, Terraform, AWS, Prometheus, incident response) at an e-commerce marketplace",
    "Senior iOS Engineer (Swift, SwiftUI, Combine, Core Data, CI for mobile) at a consumer fitness app",
    "QA Automation Engineer (Playwright, Cypress, API testing, Java or TypeScript, CI) at an insurance company",
    "Cloud Security Engineer (AWS security, IAM, SIEM, threat detection, Python automation; no clearance) at a gov-tech vendor",
    "Data Analyst / BI Analyst (SQL, Tableau, dbt, Excel, A/B testing) at an omnichannel retailer",
    "Embedded Firmware Engineer (C, C++, FreeRTOS, ARM Cortex-M, BLE, hardware bring-up) at a medical device maker",
    "Technical Product Manager (API platform, B2B SaaS, roadmap, SQL, analytics, developer experience)",
]

GENERATE_PROMPT = """Create one realistic test case for a resume tailoring system.

Role brief for the JOB POSTING: {brief}

Return JSON with two keys:
1. "job_description": a realistic, complete posting (400-650 words): company intro, role summary,
   responsibilities, required qualifications, nice-to-haves, benefits. Plain text with simple "-" bullets.
2. "profile": a realistic candidate who is a good but imperfect fit (about 70% overlap: some required
   tools missing, some adjacent tools present, 6-12 years of experience). Shape:
   {{
     "name_first", "name_last", "profile_title", "profile_email", "profile_summary",
     "technical_skills": [{{"category", "skills"}}],
     "work_experience": [{{"company_name", "job_title", "period_start" (e.g. "Mar 2021"), "period_end" ("" if current),
        "location", "project_title", "project_intro", "contributions": [4-7 strings], "used_skills"}}],
     "education": [{{"university_name", "degree", "period_start", "period_end"}}]
   }}
   4-5 work entries, most recent first. Make the profile look like a real person wrote it: skill categories
   are messy and inconsistent (e.g. "Frontend & Libraries", "Backend & APIs", "Database & Storage",
   "Tools/Other"), used_skills sometimes have no spaces after commas, and contribution bullets are
   uneven in quality (some vague, some with metrics). Use fictional company names. No em dashes."""

JUDGE_PROMPT = """You are a principal technical recruiter and ATS expert. Grade a TAILORED resume produced
for the JOB POSTING from the CANDIDATE PROFILE (the only source of truth about the candidate).

Score each dimension 1-10 (10 = flawless, what a top resume writer would produce):
- ats_keyword_match: required/preferred JD keywords and phrases that the candidate truthfully has are present
  in the summary, skills and recent roles, phrased the way the JD phrases them.
- skills_taxonomy: technical skills grouped into clean, professional, single-concept categories expected for
  this role family (e.g. Languages, Frontend, Backend, Databases, Cloud, DevOps), correct placement, sensible
  order, no soft skills, no duplicates, no messy names like "Frontend & Libraries".
- bullet_quality: action verb + what + how + measurable impact, specific, varied, no fluff or repetition,
  mapped to the JD responsibilities.
- summary_quality: specific to this role, credible, concise, strong opening.
- truthfulness: nothing invented (employers, titles, dates, technologies, metrics) vs the profile.
  10 = no fabrication. List every fabricated claim.
- formatting: bold (**text**) used sparingly on high-value terms only, never inside skill lists; clean
  comma-separated lists; consistent tense; no markdown noise.
- overall: would you shortlist this resume for this posting.

Also return:
- "estimated_ats_match_pct": 0-100, the match score a modern ATS would give this resume for the posting.
- "jd_keywords": the 15-25 most important hard-skill keywords/phrases from the posting (short strings).
- "fabrications": list of strings.
- "top_issues": the 3-6 most important concrete problems, most severe first.

Return JSON: {{"scores": {{...}}, "estimated_ats_match_pct": n, "jd_keywords": [...],
"fabrications": [...], "top_issues": [...]}}

## JOB POSTING
{jd}

## CANDIDATE PROFILE
{profile}

## TAILORED RESUME (JSON)
{resume}"""


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])


async def _json_call(client: AsyncOpenAI, prompt: str, *, effort: str = "medium") -> dict:
    resp = await client.chat.completions.create(
        model=JUDGE_MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        reasoning_effort=effort,
        max_completion_tokens=16000,
    )
    return json.loads(resp.choices[0].message.content or "{}")


async def generate() -> None:
    client = _client()
    sem = asyncio.Semaphore(5)

    async def one(i: int, brief: str) -> dict:
        async with sem:
            data = await _json_call(client, GENERATE_PROMPT.format(brief=brief), effort="low")
            print(f"generated case {i}: {brief[:50]}", flush=True)
            return {"id": i, "brief": brief, **data}

    cases = await asyncio.gather(*(one(i, b) for i, b in enumerate(ROLE_BRIEFS, start=1)))
    CASES_PATH.parent.mkdir(parents=True, exist_ok=True)
    CASES_PATH.write_text(json.dumps(cases, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(cases)} cases to {CASES_PATH}")


def _resume_text(resume: dict) -> str:
    parts = [resume.get("profile_summary") or ""]
    for sk in resume.get("technical_skills") or []:
        parts.append(f"{sk.get('category')}: {sk.get('skills')}")
    for e in resume.get("work_experience") or []:
        parts += [e.get("project_description") or "", e.get("used_skills") or ""]
        parts += [b for b in e.get("bullets") or [] if isinstance(b, str)]
    return "\n".join(parts).replace("**", "")


def _coverage(keywords: list[str], text: str) -> float:
    low = text.lower()
    hits = [k for k in keywords if isinstance(k, str) and k.strip() and k.lower() in low]
    return round(len(hits) / max(len(keywords), 1), 3)


def _format_stats(resume: dict) -> dict:
    bullets = [b for e in resume.get("work_experience") or [] for b in e.get("bullets") or []]
    bold_per_bullet = [b.count("**") // 2 for b in bullets]
    skills = resume.get("technical_skills") or []
    return {
        "categories": [s.get("category") for s in skills],
        "bold_in_skills": sum((s.get("skills") or "").count("**") // 2 for s in skills),
        "avg_bold_per_bullet": round(sum(bold_per_bullet) / max(len(bold_per_bullet), 1), 2),
        "max_bold_per_bullet": max(bold_per_bullet or [0]),
        "bullets": len(bullets),
        "used_skills_unspaced": sum(
            1 for e in resume.get("work_experience") or [] if re.search(r",\S", e.get("used_skills") or "")
        ),
    }


async def run(label: str, only: set[int] | None) -> None:
    sys.path.insert(0, os.environ.get("PYTHONPATH", "").split(":")[0] or ".")
    from app.services.job_match_service import (
        analyze_job_match_phase_a,
        build_structured_context,
        generate_tailored_content_phase_b,
    )
    from app.storage.database import init_database
    from app.utils.profile_converter import user_profile_to_openai_text

    await init_database()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    if only:
        cases = [c for c in cases if c["id"] in only]
    client = _client()
    sem = asyncio.Semaphore(int(os.environ.get("EVAL_CONCURRENCY", "5")))

    async def one(case: dict) -> dict:
        async with sem:
            t0 = time.monotonic()
            jd = case["job_description"]
            profile_text = user_profile_to_openai_text(case["profile"])
            match, structured, _ = await analyze_job_match_phase_a(
                jd, profile_text, job_preferences="", custom_guidance="", source_documents_context=""
            )
            resume, _ = await generate_tailored_content_phase_b(
                jd,
                profile_text,
                structured_context=build_structured_context(structured),
                match_summary=str(match.get("summary") or ""),
                include_cover_letter=False,
            )
            tailor_s = round(time.monotonic() - t0, 1)
            if not resume:
                print(f"case {case['id']}: tailoring failed", flush=True)
                return {"id": case["id"], "brief": case["brief"], "error": "no resume"}
            verdict = await _json_call(
                client,
                JUDGE_PROMPT.format(jd=jd, profile=profile_text, resume=json.dumps(resume, indent=1)),
            )
            kws = verdict.get("jd_keywords") or []
            row = {
                "id": case["id"],
                "brief": case["brief"],
                "tailor_seconds": tailor_s,
                "match_score": match.get("overall_score"),
                "scores": verdict.get("scores") or {},
                "estimated_ats_match_pct": verdict.get("estimated_ats_match_pct"),
                "coverage_profile": _coverage(kws, profile_text),
                "coverage_tailored": _coverage(kws, _resume_text(resume)),
                "fabrications": verdict.get("fabrications") or [],
                "top_issues": verdict.get("top_issues") or [],
                "format": _format_stats(resume),
                "resume": resume,
            }
            print(
                f"case {case['id']} overall={row['scores'].get('overall')} ats={row['estimated_ats_match_pct']} "
                f"cov {row['coverage_profile']}->{row['coverage_tailored']} t={tailor_s}s",
                flush=True,
            )
            return row

    rows = await asyncio.gather(*(one(c) for c in cases))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{label}.json"
    out.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")

    ok = [r for r in rows if "scores" in r]
    dims = sorted({k for r in ok for k in r["scores"]})
    print(f"\n== {label}: {len(ok)}/{len(rows)} cases ==")
    for d in dims:
        vals = [r["scores"].get(d) for r in ok if isinstance(r["scores"].get(d), (int, float))]
        print(f"{d:>20}: {sum(vals) / max(len(vals), 1):.2f}")
    for key in ("estimated_ats_match_pct", "coverage_profile", "coverage_tailored", "tailor_seconds"):
        vals = [r[key] for r in ok if isinstance(r.get(key), (int, float))]
        print(f"{key:>24}: {sum(vals) / max(len(vals), 1):.2f}")
    print(f"wrote {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate")
    r = sub.add_parser("run")
    r.add_argument("--label", default="run")
    r.add_argument("--only", default="")
    args = ap.parse_args()
    if args.cmd == "generate":
        asyncio.run(generate())
    else:
        only = {int(x) for x in args.only.split(",") if x.strip()} or None
        asyncio.run(run(args.label, only))


if __name__ == "__main__":
    main()
