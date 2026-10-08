import asyncio
import copy
import re

import numpy as np
import pytest

from app.services import encoding_service, job_match_service
from app.services.job_first_tailoring import (
    build_job_first_plan,
    career_facts_block,
    experience_skill_coverage,
    finalize_job_first_resume,
    job_first_problems,
    normalize_strategy,
    tailored_resume_to_profile_text,
    target_stack_block,
)
from app.services.required_skills import job_skill_terms
from app.services.tailored_match_check import posting_requirements, requirement_match
from app.services.tech_eras import intro_year, usable_in_role

_STOP = {"and", "the", "with", "in", "of", "for", "a", "to", "on", "by", "from", "into", "as"}


async def _bag_of_words(texts: list[str]) -> np.ndarray:
    out = np.zeros((len(texts), 256), dtype=np.float32)
    for i, text in enumerate(texts):
        for tok in re.findall(r"[a-z0-9]+", text.lower()):
            if tok not in _STOP:
                out[i, hash(tok) % 256] += 1.0
        norm = np.linalg.norm(out[i])
        if norm:
            out[i] /= norm
    return out


@pytest.fixture(autouse=True)
def _fake_encoder(monkeypatch):
    monkeypatch.setattr(encoding_service, "encode_texts_async", _bag_of_words)

PROFILE = """# Jane Doe
Senior Software Engineer | jane@example.com

## Summary
Backend engineer.

## Technical Skills
- **Languages**: Java, PHP
- **Databases**: MySQL
- **Tools**: Jenkins, SVN

## Work Experience
**Acme Payments** | Senior Software Engineer | Jan 2021 - Present
Remote, Full-time
Project: Merchant Ledger
Project description: Ledger platform that reconciles card payments for 4,000 merchants.
- Built Java services on Jenkins pipelines that cut reconciliation time by 40%.
- Maintained PHP admin tools with MySQL reports for the finance team.
Technologies: Java, PHP, MySQL, Jenkins

**Globex Health** | Software Engineer | Mar 2018 - Dec 2020
- Wrote PHP modules for patient scheduling used by 120 clinics.
- Migrated nightly reports from SVN scripts to Jenkins jobs.
Technologies: PHP, MySQL, SVN

**Initech** | Junior Developer | Jun 2012 - Feb 2015
- Built internal PHP pages for billing.
Technologies: PHP

## Education
**State University** | BSc Computer Science
"""

JOB = """Senior Backend Engineer
Requirements:
- 5+ years with Python and FastAPI
- Kubernetes and Docker in production
- PostgreSQL and Redis
- AWS
Nice to have:
- Kafka
- LangChain
"""


def _plan():
    return build_job_first_plan(job_skill_terms(JOB), PROFILE)


def _good_resume() -> dict:
    return {
        "profile_summary": "Senior Backend Engineer with 9 years building payment and healthcare platforms in "
        "**Python** and **FastAPI** on **Kubernetes**, cutting reconciliation time by 40%.",
        "technical_skills": [
            {"category": "Tools", "skills": "SVN, Jenkins"},
            {"category": "Backend", "skills": "FastAPI, Python"},
        ],
        "work_experience": [
            {
                "company_name": "Acme Payments Inc",
                "job_title": "Backend Lead",
                "period_start": "2021",
                "project_name": "Merchant Ledger",
                "project_description": "Ledger platform reconciling card payments, built as Python services on AWS.",
                "used_skills": "PHP, Python, SVN",
                "bullets": [
                    "Designed **Python** and **FastAPI** reconciliation services on **Kubernetes** with **Docker** "
                    "images, cutting reconciliation time by 40%.",
                    "Modeled ledger tables in **PostgreSQL** with **Redis** caching for merchant balance lookups.",
                    "Streamed settlement events through **Kafka** into the ledger on **AWS**.",
                    "Added a **LangChain** assistant that answers merchant dispute questions from ledger history.",
                ],
            },
            {
                "company_name": "Globex Health",
                "job_title": "Software Engineer",
                "period_start": "Mar 2018",
                "project_description": "",
                "used_skills": "Python",
                "bullets": [
                    "Built **Python** **FastAPI** scheduling APIs for 120 clinics, deployed with **Docker** on "
                    "**Kubernetes**.",
                    "Stored appointments in **PostgreSQL** and cached clinic calendars in **Redis** on **AWS**.",
                ],
            },
            {
                "company_name": "Initech",
                "job_title": "Junior Developer",
                "bullets": ["Wrote **Python** billing jobs that loaded invoices into **PostgreSQL** on **AWS**."],
            },
        ],
    }


def test_strategy_defaults_to_job_first():
    assert normalize_strategy(None) == "job_first"
    assert normalize_strategy("evidence") == "evidence"
    assert normalize_strategy("anything") == "job_first"


def test_tech_eras():
    assert intro_year("Kubernetes") == 2015
    assert intro_year("k8s") == 2015
    assert intro_year("LangChain") == 2022
    assert intro_year("Some Internal Tool") is None
    assert not usable_in_role("LangChain", 2020, is_current=False)
    assert usable_in_role("LangChain", 2026, is_current=True)
    assert not usable_in_role("Kubernetes", 2015, is_current=False)


def test_plan_makes_the_posting_stack_primary_and_respects_eras():
    plan = _plan()
    primary = [s.term for s in plan.primary]
    for term in ("Python", "FastAPI", "Kubernetes", "Docker", "PostgreSQL", "Redis", "AWS"):
        assert term in primary
    assert {"Kafka", "LangChain"} <= {s.term for s in plan.secondary}
    acme, globex, initech = plan.roles
    assert "LangChain" in acme.stack
    assert "LangChain" in globex.too_new
    assert "Kubernetes" in initech.too_new and "FastAPI" in initech.too_new
    assert "Python" in initech.stack
    # Primary skills belong to both recent roles; secondary ones to the most recent role that can hold them.
    python = next(s for s in plan.skills if s.term == "Python")
    assert python.roles == ["Acme Payments", "Globex Health"]
    langchain = next(s for s in plan.skills if s.term == "LangChain")
    assert langchain.roles == ["Acme Payments"]
    # The old stack survives only where it complements the posting's categories.
    assert "MySQL" in plan.complementary
    assert "SVN" in plan.off_target


def test_prompt_blocks_carry_facts_not_contributions():
    plan = _plan()
    facts = career_facts_block(plan)
    assert "[0] Acme Payments | Senior Software Engineer | Jan 2021 - Present | Remote, Full-time" in facts
    assert "Product / domain: Ledger platform" in facts
    assert "cut reconciliation time by 40%" in facts
    # A role without a project description gets domain clues, labelled as context only.
    assert "Domain clues" in facts and "patient scheduling" in facts
    stack = target_stack_block(plan)
    assert "Never name anywhere" in stack and "SVN" in stack
    assert "[1] Globex Health ended before these existed" in stack and "LangChain" in stack


def test_finalize_restores_facts_and_leads_with_the_posting_stack():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    acme = resume["work_experience"][0]
    assert acme["company_name"] == "Acme Payments"
    assert acme["job_title"] == "Senior Software Engineer"
    assert acme["period_start"] == "Jan 2021"
    used = [u.strip() for u in acme["used_skills"].split(",")]
    assert "SVN" not in used and used[0] == "Python"
    assert {"FastAPI", "Kubernetes", "PostgreSQL"} <= set(used)
    skills_text = ", ".join(r["skills"] for r in resume["technical_skills"])
    assert "SVN" not in skills_text
    for term in plan.terms:
        if next(s for s in plan.skills if s.term == term).injectable:
            assert term in skills_text
    assert resume["technical_skills"][0]["skills"].split(", ")[0] == "Python"


def test_a_job_first_draft_meets_every_rule():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    assert job_first_problems(resume, plan, PROFILE) == {}
    assert experience_skill_coverage(resume, plan) == 1.0


def test_checks_catch_old_stack_eras_invented_numbers_and_reuse():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    bad = copy.deepcopy(resume)
    globex = bad["work_experience"][1]
    globex["bullets"] = [
        "Wrote PHP modules for patient scheduling used by 120 clinics with SVN.",
        "Migrated nightly reports from SVN scripts to Jenkins jobs, lifting uptime to 99.9%.",
        "Built a **LangChain** triage bot on **Python**.",
    ]
    problems = job_first_problems(bad, plan, PROFILE)
    assert "work_experience[1]_missing_primary_skills" in problems
    assert "FastAPI" in problems["work_experience[1]_missing_primary_skills"]
    assert "SVN" in problems["work_experience[1]_off_target_technology"]
    assert "LangChain" in problems["work_experience[1]_anachronistic_technology"]
    assert "99.9%" in problems["work_experience[1]_invented_metric"]
    assert "work_experience[1]_reuses_original_wording" in problems

    over = copy.deepcopy(resume)
    over["profile_summary"] = "Staff Backend Engineer with 9 years building Python platforms on AWS for payments."
    assert "profile_summary_level_above_held" in job_first_problems(over, plan, PROFILE)


def test_tailored_profile_text_keeps_header_and_education():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    text = tailored_resume_to_profile_text(resume, PROFILE)
    assert text.startswith("# Jane Doe")
    assert "## Education" in text and "State University" in text
    assert "FastAPI" in text and "Wrote PHP modules" not in text


STRUCTURED = """Title: Senior Backend Engineer
Company: Acme

Key requirements (prioritize these in tailored content):
- 5+ years with Python and FastAPI
- Bachelor's degree in Computer Science
- Kubernetes and Docker in production
Key responsibilities (mirror language where truthful):
- Model ledger tables in PostgreSQL with Redis caching
- Mentor engineers through design reviews
- What Success Looks Like
- Prior experience supporting Department of Defense (DoD) programs
"""


def test_posting_requirements_prefers_extracted_lists_and_sets_facts_aside():
    tasks, facts = posting_requirements(STRUCTURED, JOB)
    assert tasks == [
        "Kubernetes and Docker in production",
        "Model ledger tables in PostgreSQL with Redis caching",
        "Mentor engineers through design reviews",
    ]
    assert facts == [
        "5+ years with Python and FastAPI",
        "Bachelor's degree in Computer Science",
        "Prior experience supporting Department of Defense (DoD) programs",
    ]
    # Without extracted lists, the posting's requirement sections are read.
    tasks, facts = posting_requirements("Title: Senior Backend Engineer", JOB)
    assert "Kubernetes and Docker in production" in tasks and "PostgreSQL and Redis" in tasks
    assert facts == ["5+ years with Python and FastAPI"]


def test_requirement_match_counts_skills_and_uncovered_lines():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=STRUCTURED, job_text=JOB))
    assert match["skill_coverage"] == 1.0 and match["missing_skills"] == []
    assert match["uncovered_lines"] == ["Mentor engineers through design reviews"]
    assert match["rate"] == 83

    resume["work_experience"][1]["bullets"].append(
        "Mentored engineers through design reviews of **FastAPI** scheduling services."
    )
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=STRUCTURED, job_text=JOB))
    assert match["rate"] == 100 and match["uncovered_lines"] == []


def test_phase_b_retries_for_uncovered_posting_lines(monkeypatch):
    calls: list[str] = []
    prompts: dict[str, str] = {}
    covered = _good_resume()
    covered["work_experience"][1]["bullets"].append(
        "Mentored engineers through design reviews of **FastAPI** scheduling services."
    )

    async def fake_call(*, observe_name, user_content, **_kwargs):
        calls.append(observe_name)
        prompts[observe_name] = user_content
        return {"tailored_resume": copy.deepcopy(_good_resume() if observe_name == "phase_b" else covered)}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    resume, _ = asyncio.run(
        job_match_service.generate_tailored_content_phase_b(
            JOB, PROFILE, structured_context=STRUCTURED, include_cover_letter=False
        )
    )
    assert calls == ["phase_b", "phase_b_quality_retry_1"]
    retry = prompts["phase_b_quality_retry_1"]
    assert '"Mentor engineers through design reviews"' in retry
    # The retry revises the best draft so far instead of starting over.
    assert "## Your previous draft" in retry and "Modeled ledger tables" in retry.split("## Your previous draft")[1]
    check = resume["match_check"]
    assert check["requirement_match"] == 100 and check["target"] == 98
    assert check["fact_lines"][:2] == ["5+ years with Python and FastAPI", "Bachelor's degree in Computer Science"]


def test_posting_boilerplate_is_neither_a_skill_nor_a_requirement():
    job = JOB.replace("- AWS\n", "- AWS\n- Join us today, your ambITious journey starts here.\n")
    assert "AmbITious" not in [s.term for s in build_job_first_plan(job_skill_terms(job), PROFILE, job).skills]
    context = (
        "Key requirements:\n- Kubernetes and Docker in production\n- What you can expect\n"
        "- Insight is an equal opportunity employer, and all qualified applicants will receive consideration.\n"
        "- Prior consulting or professional services delivery experience"
    )
    tasks, facts = posting_requirements(context, job)
    assert tasks == ["Kubernetes and Docker in production"]
    assert facts == ["Prior consulting or professional services delivery experience"]


def test_soft_skills_count_through_the_verbs_that_show_them():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    context = "Key requirements:\n- Strong communication skills and a knack for explaining complex ideas with clarity"
    resume["work_experience"][0]["bullets"].append(
        "Explained complex ledger design decisions clearly in reviews with finance and engineering leads."
    )
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=context, job_text=JOB))
    assert match["uncovered_lines"] == []


def test_soft_skill_lines_count_when_a_bullet_uses_their_words():
    plan = _plan()
    resume = finalize_job_first_resume(_good_resume(), plan, PROFILE, JOB)
    context = "Key requirements:\n- Strong troubleshooting, communication, and presentation skills."
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=context, job_text=JOB))
    assert match["uncovered_lines"] == ["Strong troubleshooting, communication, and presentation skills."]
    resume["work_experience"][0]["bullets"].append(
        "Led troubleshooting of ledger incidents and presented findings, communicating fixes to finance leads."
    )
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=context, job_text=JOB))
    assert match["uncovered_lines"] == []


def test_phase_b_job_first_rewrites_until_the_rules_hold(monkeypatch):
    calls: list[str] = []
    prompts: dict[str, str] = {}
    bad = _good_resume()
    bad["work_experience"][1]["bullets"] = ["Wrote PHP modules for patient scheduling used by 120 clinics."]

    async def fake_call(*, observe_name, user_content, system_prompt, **_kwargs):
        calls.append(observe_name)
        prompts[observe_name] = user_content
        if "cover" in observe_name:
            return {"cover_letter": {"body": "Dear team"}}
        return {"tailored_resume": copy.deepcopy(bad if observe_name == "phase_b" else _good_resume())}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    resume, letter = asyncio.run(job_match_service.generate_tailored_content_phase_b(JOB, PROFILE))

    assert calls == ["phase_b", "phase_b_quality_retry_1", "phase_b_cover_letter"]
    assert "Career facts" in prompts["phase_b"] and "Target stack" in prompts["phase_b"]
    assert "Wrote PHP modules" not in prompts["phase_b"].split("## Job Description")[0].split("Domain clues")[0]
    assert "QUALITY RETRY" in prompts["phase_b_quality_retry_1"]
    # The cover letter is written from the final tailored resume, not the original profile.
    assert "FastAPI" in prompts["phase_b_cover_letter"]
    assert "Wrote PHP modules" not in prompts["phase_b_cover_letter"]
    assert letter == {"body": "Dear team"}
    check = resume["match_check"]
    assert check["strategy"] == "job_first" and check["skill_coverage"] == 1.0 and check["open_issues"] == []


def test_phase_b_evidence_strategy_keeps_the_old_path(monkeypatch):
    calls: list[str] = []

    async def fake_call(*, observe_name, **_kwargs):
        calls.append(observe_name)
        return {"tailored_resume": None}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    asyncio.run(
        job_match_service.generate_tailored_content_phase_b(
            JOB, PROFILE, include_cover_letter=False, strategy="evidence"
        )
    )
    assert calls[0] == "phase_b"
    assert not any(c.startswith("phase_b_quality_retry_") for c in calls)
