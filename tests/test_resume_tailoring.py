import asyncio
import copy
import re

import numpy as np
import pytest

from app.services import encoding_service, job_match_service
from app.services.resume_tailoring import (
    build_tailoring_plan,
    career_facts_block,
    experience_skill_coverage,
    finalize_tailored_resume,
    tailoring_problems,
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
    return build_tailoring_plan(job_skill_terms(JOB), PROFILE)


def _good_resume() -> dict:
    return {
        "profile_summary": "Senior Software Engineer with 11 years building payment, healthcare and billing "
        "platforms, from first production features to the ledger systems finance teams rely on. Owns service "
        "architecture and its tradeoffs, mentors engineers and works closely with product and finance partners. "
        "Known for turning fragile batch processes into dependable services, including cutting reconciliation "
        "time by 40%.",
        "technical_skills": [
            {"category": "Languages", "skills": "Python, SQL, Java, PHP, Bash, TypeScript"},
            {"category": "Backend", "skills": "FastAPI, Kafka, LangChain, Celery, Pydantic, Django"},
            {"category": "Databases", "skills": "PostgreSQL, Redis, MySQL, DynamoDB, Elasticsearch, MongoDB, SQLAlchemy"},
            {"category": "Cloud", "skills": "AWS, Amazon S3, AWS Lambda, Amazon EC2, Amazon SQS, CloudWatch"},
            {"category": "DevOps", "skills": "Docker, Kubernetes, Jenkins, GitHub Actions, Terraform, Prometheus, Grafana"},
        ],
        "work_experience": [
            {
                "company_name": "Acme Payments Inc",
                "job_title": "Backend Lead",
                "period_start": "2021",
                "project_name": "Merchant Ledger",
                "project_description": "Ledger platform reconciling card payments, built as Python services on AWS.",
                "used_skills": "PHP, Python, SVN, Communication",
                "bullets": [
                    "Designed the **Python** and **FastAPI** reconciliation services for Merchant Ledger on "
                    "**Kubernetes** with **Docker** images, cutting reconciliation time by 40%.",
                    "Modeled ledger tables in **PostgreSQL** with **Redis** caching so merchant balance lookups "
                    "stayed fast during settlement peaks.",
                    "Streamed settlement events through **Kafka** into the ledger on **AWS**, replacing nightly "
                    "batch imports with near real-time posting.",
                    "Added a **LangChain** assistant that answers merchant dispute questions from ledger history "
                    "for the support team.",
                    "Defined the testing standard with pytest contract suites and GitHub Actions gates that every "
                    "ledger service now ships through.",
                    "Provisioned cloud infrastructure with Terraform modules so new ledger services reach "
                    "production through reviewed, repeatable changes.",
                    "Led observability for the ledger with Prometheus metrics and Grafana dashboards that page on "
                    "reconciliation drift.",
                    "Coached four engineers into owning ledger services, pairing on incident follow-ups and "
                    "rollout plans.",
                ],
            },
            {
                "company_name": "Globex Health",
                "job_title": "Software Engineer",
                "period_start": "Mar 2018",
                "project_description": "",
                "used_skills": "Python, Celery, Jenkins",
                "bullets": [
                    "Designed **Python** **FastAPI** scheduling APIs for 120 clinics, deployed as **Docker** "
                    "containers on **Kubernetes**.",
                    "Stored appointments in **PostgreSQL** and cached clinic calendars in **Redis** on **AWS** to "
                    "keep booking pages responsive.",
                    "Moved reminder delivery onto Celery workers, retrying failed notifications so patients kept "
                    "receiving appointment updates.",
                    "Built Jenkins pipelines running pytest suites on every merge, which became the release gate "
                    "for the scheduling platform.",
                    "Led the migration of clinic data into the new schema, planning cutovers with operations so "
                    "clinics kept booking throughout.",
                ],
            },
            {
                "company_name": "Initech",
                "job_title": "Junior Developer",
                "bullets": [
                    "Implemented **Python** billing jobs that loaded invoices into **PostgreSQL**, refining them "
                    "with feedback from senior developers.",
                    "Wrote unit tests for invoice calculations, learning the team's branching and release process "
                    "along the way.",
                    "Fixed reporting defects in billing exports and documented each fix for the finance support "
                    "desk.",
                    "Built small admin pages for invoice corrections, gradually taking ownership of the billing "
                    "admin module.",
                    "Automated invoice archiving to **AWS** storage, replacing a manual monthly export.",
                ],
            },
        ],
    }


def test_strategy_defaults_to_rebuild():
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
    # The candidate's own stack stays as career breadth, per role and overall.
    assert {"Java", "PHP", "MySQL", "Jenkins"} <= set(acme.own_stack)
    assert "SVN" in globex.own_stack and {"MySQL", "SVN"} <= set(plan.breadth)


def test_plan_reads_tenure_and_career_stage():
    acme, globex, initech = _plan().roles
    assert initech.months == 33 and initech.tenure == "2 years 9 months"
    assert initech.stage == "early" and initech.career_year == 0
    assert initech.bullet_range == (5, 6)
    assert globex.months == 34 and globex.stage == "senior"  # started almost six years into the career
    assert acme.stage == "senior" and acme.bullet_range == (7, 9)


def test_prompt_blocks_carry_facts_not_contributions():
    plan = _plan()
    facts = career_facts_block(plan)
    assert "[0] Acme Payments | Senior Software Engineer | Jan 2021 - Present | Remote, Full-time" in facts
    assert "Product / domain: Ledger platform" in facts
    assert "cut reconciliation time by 40%" in facts
    # A role without a project description gets domain clues, labelled as context only.
    assert "Domain clues" in facts and "patient scheduling" in facts
    assert "Tenure: 2 years 9 months, starting 0 years into the career. Bullets: 5-6." in facts
    assert "early career: learning the craft" in facts and "senior: owns the design" in facts
    assert "a senior engineer" in facts
    stack = target_stack_block(plan)
    assert "Never name" not in stack
    assert "Career breadth" in stack and "[0] Acme Payments used: Java, Jenkins, PHP, MySQL" in stack
    assert "[1] Globex Health ended before these existed" in stack and "LangChain" in stack


def test_finalize_restores_facts_and_leads_with_the_posting_stack():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    acme = resume["work_experience"][0]
    assert acme["company_name"] == "Acme Payments"
    assert acme["job_title"] == "Senior Software Engineer"
    assert acme["period_start"] == "Jan 2021"
    used = [u.strip() for u in acme["used_skills"].split(",")]
    assert used[0] == "Python" and {"FastAPI", "Kubernetes", "PostgreSQL"} <= set(used)
    # used_skills lists what the role's bullets name: breadth they show stays, the rest and soft skills go.
    assert {"Terraform", "Prometheus"} <= set(used)
    assert not {"PHP", "SVN", "Communication"} & set(used)
    skills_text = ", ".join(r["skills"] for r in resume["technical_skills"])
    assert "Terraform" in skills_text and "MongoDB" in skills_text
    assert len(resume["technical_skills"]) >= 5
    for term in plan.terms:
        if next(s for s in plan.skills if s.term == term).injectable:
            assert term in skills_text
    assert resume["technical_skills"][0]["skills"].split(", ")[0] == "Python"


def test_a_tailored_draft_meets_every_rule():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    assert tailoring_problems(resume, plan, PROFILE) == {}
    assert experience_skill_coverage(resume, plan) == 1.0


def test_checks_catch_eras_invented_numbers_reuse_and_thin_roles():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    bad = copy.deepcopy(resume)
    globex = bad["work_experience"][1]
    globex["bullets"] = [
        "Wrote PHP modules for patient scheduling used by 120 clinics with SVN.",
        "Migrated nightly reports from SVN scripts to Jenkins jobs, lifting uptime to 99.9%.",
        "Built a **LangChain** triage bot on **Python**.",
    ]
    problems = tailoring_problems(bad, plan, PROFILE)
    assert "work_experience[1]_missing_primary_skills" in problems
    assert "FastAPI" in problems["work_experience[1]_missing_primary_skills"]
    assert "LangChain" in problems["work_experience[1]_anachronistic_technology"]
    assert "99.9%" in problems["work_experience[1]_invented_metric"]
    assert "work_experience[1]_reuses_original_wording" in problems
    assert "3 bullets; that tenure carries 5-6" in problems["work_experience[1]_too_few_bullets_for_tenure"]

    over = copy.deepcopy(resume)
    over["profile_summary"] = "Staff Backend Engineer with 9 years building Python platforms on AWS for payments."
    assert "profile_summary_level_above_held" in tailoring_problems(over, plan, PROFILE)


def test_checks_keep_each_role_at_its_career_stage():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    junior = copy.deepcopy(resume)
    junior["work_experience"][2]["bullets"][0] = (
        "Architected the **Python** billing platform on **PostgreSQL** and mentored the team on its design."
    )
    assert "work_experience[2]_scope_above_stage" in tailoring_problems(junior, plan, PROFILE)

    flat = copy.deepcopy(resume)
    flat["work_experience"][1]["bullets"] = [
        "Wrote **Python** **FastAPI** endpoints for clinic scheduling running as **Docker** containers on "
        "**Kubernetes**.",
        "Added **PostgreSQL** queries and **Redis** caching on **AWS** for booking pages.",
        "Fixed Celery reminder tasks that dropped notifications.",
        "Updated Jenkins jobs to run pytest on each merge.",
        "Changed the clinic data schema for new appointment types.",
    ]
    assert "work_experience[1]_scope_below_stage" in tailoring_problems(flat, plan, PROFILE)

    stuffed = copy.deepcopy(resume)
    stuffed["work_experience"][0]["bullets"][0] = (
        "Deployed Python, FastAPI, Kafka, Docker, Kubernetes, PostgreSQL, Redis and AWS services for ledger "
        "reconciliation."
    )
    assert "work_experience[0]_keyword_stuffing" in tailoring_problems(stuffed, plan, PROFILE)


def test_older_roles_keep_their_own_domain():
    job = JOB.replace("- AWS\n", "- AWS\n- KYC and AML controls\n")
    plan = build_tailoring_plan(job_skill_terms(job), PROFILE, job)
    older = next(line for line in target_stack_block(plan).splitlines() if line.startswith("- [2] Initech ("))
    assert "Python" in older and "KYC" not in older
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, job)
    # Domain acronyms are vocabulary for bullets, not rows of the skills section.
    assert not any("KYC" in r["skills"] for r in resume["technical_skills"])
    resume["work_experience"][2]["bullets"][0] = (
        "Implemented **Python** billing jobs with KYC checks that loaded invoices into **PostgreSQL**."
    )
    problems = tailoring_problems(resume, plan, PROFILE)
    assert "work_experience[2]_posting_domain_in_older_role" in problems and "KYC" in problems[
        "work_experience[2]_posting_domain_in_older_role"
    ]


def test_states_and_percentiles_are_not_skills():
    job = (
        "Requirements:\n- Python services with P90 and P99 latency targets\n- Office in Nashville, TN\n"
        "- Work closely with Product, Design, and Backend engineers\n"
    )
    terms = {s.term for s in job_skill_terms(job)}
    assert "Python" in terms and not {"P90", "P99", "TN"} & terms
    assert not any("," in t for t in terms)


def test_checks_want_career_breadth_a_human_summary_and_a_full_skills_section():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    narrow = copy.deepcopy(resume)
    narrow["work_experience"][1]["bullets"][2] = "Moved reminder delivery onto **Python** workers on **AWS**."
    narrow["work_experience"][1]["bullets"][3] = "Built release pipelines for **Docker** images on every merge."
    problems = tailoring_problems(narrow, plan, PROFILE)
    assert "work_experience[1]_no_career_breadth" in problems

    listy = copy.deepcopy(resume)
    listy["profile_summary"] = (
        "Senior Software Engineer with 11 years of experience in Python, FastAPI, Kubernetes, Docker, PostgreSQL "
        "and Redis, building services on AWS."
    )
    assert "profile_summary_lists_technologies" in tailoring_problems(listy, plan, PROFILE)

    thin = copy.deepcopy(resume)
    thin["technical_skills"] = [{"category": "Backend", "skills": "Python, FastAPI"}]
    assert "technical_skills_too_thin" in tailoring_problems(thin, plan, PROFILE)


def test_tailored_profile_text_keeps_header_and_education():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
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
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
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
    assert "AmbITious" not in [s.term for s in build_tailoring_plan(job_skill_terms(job), PROFILE, job).skills]
    context = (
        "Key requirements:\n- Kubernetes and Docker in production\n- What you can expect\n"
        "- Insight is an equal opportunity employer, and all qualified applicants will receive consideration.\n"
        "- Prior consulting or professional services delivery experience"
    )
    tasks, facts = posting_requirements(context, job)
    assert tasks == ["Kubernetes and Docker in production"]
    assert facts == ["Prior consulting or professional services delivery experience"]


RECRUITER_EMAIL = """100% REMOTE (6 month C/C-H) Python/AI Engineer Opportunity!
Dear Nathaniel,

I'm currently working with a fortune 500 client who is looking for a Python/AI Engineer who is well versed with Python, FastAPI, React.js, TypeScript, microservices, Azure, and AI.

This opportunity offers a variety of benefits including remote flexibility, stability, room for internal growth, collaborative culture, etc.

I had a chance to review your LinkedIn profile and thought that your background lined up well with this role but then again I wanted to have a phone conversation to make sure.

Although you may not be actively looking I was still hoping to gain a better understanding for what type of opportunities would be considered an improvement over your current work situation so that I can be an accurate resource for you now and in the near future.
"""


def test_a_recruiter_email_yields_its_stack_not_the_outreach():
    plan = build_tailoring_plan(job_skill_terms(RECRUITER_EMAIL), PROFILE, RECRUITER_EMAIL)
    terms = {s.term.lower() for s in plan.skills}
    assert {"python", "fastapi", "typescript", "azure"} <= terms
    assert "linkedin" not in terms
    tasks, facts = posting_requirements("Title: Python/AI Engineer", RECRUITER_EMAIL)
    assert any("well versed with Python, FastAPI" in t for t in tasks)
    assert not any("LinkedIn" in t or "actively looking" in t for t in tasks)
    assert any("benefits" in f for f in facts)


def test_soft_skills_count_through_the_verbs_that_show_them():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    context = "Key requirements:\n- Strong communication skills and a knack for explaining complex ideas with clarity"
    resume["work_experience"][0]["bullets"].append(
        "Explained complex ledger design decisions clearly in reviews with finance and engineering leads."
    )
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=context, job_text=JOB))
    assert match["uncovered_lines"] == []


def test_soft_skill_lines_count_when_a_bullet_uses_their_words():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    context = "Key requirements:\n- Strong troubleshooting, communication, and presentation skills."
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=context, job_text=JOB))
    assert match["uncovered_lines"] == ["Strong troubleshooting, communication, and presentation skills."]
    resume["work_experience"][0]["bullets"].append(
        "Led troubleshooting of ledger incidents and presented findings, communicating fixes to finance leads."
    )
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=context, job_text=JOB))
    assert match["uncovered_lines"] == []


def test_phase_b_rewrites_until_the_rules_hold(monkeypatch):
    calls: list[str] = []
    prompts: dict[str, str] = {}
    bad = _good_resume()
    bad["work_experience"][1]["bullets"] = ["Wrote PHP modules for patient scheduling used by 120 clinics."]
    bad["profile_summary"] = "Senior Software Engineer skilled in Python, FastAPI, Kubernetes, Docker and AWS."

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
