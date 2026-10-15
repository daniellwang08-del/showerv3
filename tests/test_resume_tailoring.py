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
- **Languages**: Java, PHP, Python
- **Backend**: FastAPI, Kafka
- **Databases**: MySQL, PostgreSQL, Redis
- **Cloud**: AWS, Docker, Kubernetes
- **Tools**: Jenkins, SVN, Terraform, Prometheus

## Work Experience
**Acme Payments** | Senior Software Engineer | Jan 2021 - Present
Remote, Full-time
Project: Merchant Ledger
Project description: Ledger platform that reconciles card payments for 4,000 merchants.
- Shipped Python/FastAPI ledger services on Kubernetes and Docker; cut reconciliation time by 40%.
- Used PostgreSQL, Redis, Kafka and AWS for settlement pipelines.
- Kept PHP/MySQL admin tools for finance.
- Owned Terraform modules, Jenkins delivery and Prometheus alerting for ledger services.
Technologies: Python, FastAPI, Java, PHP, MySQL, PostgreSQL, Redis, Kafka, AWS, Docker, Kubernetes, Jenkins, Terraform, Prometheus

**Globex Health** | Software Engineer | Mar 2018 - Dec 2020
- Delivered PHP scheduling features used across 120 clinics.
- Moved clinic reporting off SVN onto Jenkins-managed jobs.
Technologies: PHP, MySQL, SVN, Jenkins

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
            {"category": "Languages", "skills": "Python, Java, PHP"},
            {"category": "Backend", "skills": "FastAPI, Kafka"},
            {"category": "Databases", "skills": "PostgreSQL, Redis, MySQL"},
            {"category": "Cloud", "skills": "AWS, Docker, Kubernetes"},
            {"category": "DevOps", "skills": "Jenkins, Terraform, Prometheus, SVN"},
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
                    "Defined the testing standard with pytest contract suites and Jenkins gates that every "
                    "ledger service now ships through.",
                    "Provisioned cloud infrastructure with Terraform modules so new ledger services reach "
                    "production through reviewed, repeatable changes.",
                    "Led observability for the ledger with Prometheus metrics that page on reconciliation drift.",
                    "Coached four engineers into owning ledger services, pairing on incident follow-ups and "
                    "rollout plans.",
                    "Maintained **PHP** admin tools with **MySQL** reports for the finance team.",
                ],
            },
            {
                "company_name": "Globex Health",
                "job_title": "Software Engineer",
                "period_start": "Mar 2018",
                "project_description": "Clinic scheduling platform for 120 clinics, built with PHP modules and "
                "MySQL reporting for the front desk.",
                "used_skills": "PHP, MySQL, Jenkins, SVN",
                "bullets": [
                    "Designed the **PHP** scheduling platform that kept 120 clinics booking without downtime during peak seasons.",
                    "Modeled appointment data in **MySQL** and shipped reporting the front desk relied on for daily capacity planning.",
                    "Replaced fragile **SVN** report scripts with **Jenkins**-gated pipelines so clinic schedule updates shipped safely.",
                    "Hardened clinic data access with role checks so only treating staff could open patient schedules.",
                    "Mentored two engineers through their first production on-call rotation for the scheduling stack.",
                    "Partnered with clinicians to turn booking rules into validation the front desk could trust.",
                ],
            },
            {
                "company_name": "Initech",
                "job_title": "Junior Developer",
                "project_description": "Internal billing tools for the finance desk, built with PHP pages for invoice "
                "corrections and reporting.",
                "bullets": [
                    "Built internal **PHP** pages for billing corrections used by the finance desk.",
                    "Wrote unit tests for invoice calculations, learning the team's branching and release process "
                    "along the way.",
                    "Fixed reporting defects in billing exports and documented each fix for the finance support "
                    "desk.",
                    "Built small admin pages for invoice corrections, gradually taking ownership of the billing "
                    "admin module.",
                    "Documented the billing admin module so new engineers could fix invoice defects safely.",
                ],
            },
        ],
    }


def test_strategy_defaults_to_evidence():
    assert normalize_strategy(None) == "evidence"
    assert normalize_strategy("evidence") == "evidence"
    assert normalize_strategy("job_first") == "job_first"
    assert normalize_strategy("anything") == "evidence"


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
    assert "Kafka" in {s.term for s in plan.secondary}
    # LangChain is posting-only: never invented onto the plan.
    assert "LangChain" not in {s.term for s in plan.skills}
    assert "LangChain" in plan.missing
    acme, globex, initech = plan.roles
    assert "Python" in acme.stack and "Kubernetes" in acme.stack
    assert "Python" not in globex.stack  # Globex never used Python
    assert "Kubernetes" in initech.too_new and "FastAPI" in initech.too_new
    assert "Python" not in initech.stack
    python = next(s for s in plan.skills if s.term == "Python")
    assert python.roles == ["Acme Payments"]
    assert not any(s.added for s in plan.skills)
    assert {"Java", "PHP", "MySQL", "Jenkins"} <= set(acme.own_stack) | set(plan.breadth)
    assert "SVN" in globex.own_stack


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
    assert "not this one's): Ledger platform that reconciles card payments for 4,000 merchants." in facts
    assert "cut reconciliation time by 40%" in facts
    # A role without a project description gets domain clues, labelled as context only, without its stack.
    clues = next(line for line in facts.splitlines() if "Domain clues" in line)
    assert "Delivered scheduling features used across 120 clinics" in clues and "PHP" not in clues
    assert "Tenure: 2 years 9 months, starting 0 years into the career. Bullets: 5-6." in facts
    assert "early career: learning the craft" in facts and "senior: owns the design" in facts
    assert "a senior engineer" in facts
    stack = target_stack_block(plan)
    assert "Never invent these posting skills" in stack and "LangChain" in stack
    assert "Career breadth" in stack and "[0] Acme Payments used:" in stack
    assert "Java" in stack or "PHP" in stack


def test_finalize_restores_facts_and_leads_with_the_posting_stack():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    acme = resume["work_experience"][0]
    assert acme["company_name"] == "Acme Payments"
    assert acme["job_title"] == "Senior Software Engineer"
    assert acme["period_start"] == "Jan 2021"
    used = [u.strip() for u in acme["used_skills"].split(",")]
    assert used[0] == "Python" and {"FastAPI", "Kubernetes", "PostgreSQL"} <= set(used)
    # used_skills lists what the role's bullets name: breadth they show stays, soft skills go.
    assert {"Terraform", "Prometheus", "PHP"} <= set(used)
    assert "Communication" not in used and "SVN" not in used
    skills_text = ", ".join(r["skills"] for r in resume["technical_skills"])
    assert "Terraform" in skills_text
    # Profile never names MongoDB; finalize must not keep invented skills.
    assert "MongoDB" not in skills_text and "LangChain" not in skills_text
    assert len(resume["technical_skills"]) >= 4
    for term in plan.terms:
        if next(s for s in plan.skills if s.term == term).injectable:
            assert term in skills_text
    assert resume["technical_skills"][0]["skills"].split(", ")[0] == "Python"


def test_a_tailored_draft_meets_every_rule():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    problems = {
        k: v
        for k, v in tailoring_problems(resume, plan, PROFILE).items()
        if k != "technical_skills_too_thin"  # honesty filters prefer truth over padded rows
    }
    assert problems == {}
    assert experience_skill_coverage(resume, plan) == 1.0


def test_checks_catch_eras_invented_numbers_reuse_and_thin_roles():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    bad = copy.deepcopy(resume)
    globex = bad["work_experience"][1]
    globex["project_description"] = "Clinic scheduling platform."
    globex["bullets"] = [
        "Delivered PHP scheduling features used across 120 clinics with SVN.",
        "Moved clinic reporting off SVN onto Jenkins-managed jobs, lifting uptime to 99.9%.",
        "Built a **LangChain** triage bot on **Python**.",
    ]
    problems = tailoring_problems(bad, plan, PROFILE)
    assert "LangChain" in problems["work_experience[1]_anachronistic_technology"]
    assert "99.9%" in problems["work_experience[1]_invented_metric"]
    assert "work_experience[1]_reuses_original_wording" in problems
    assert "3 bullets; that tenure carries 5-6" in problems["work_experience[1]_too_few_bullets_for_tenure"]

    missing = copy.deepcopy(resume)
    for entry in missing["work_experience"][:2]:
        entry["bullets"] = [
            b.replace("Python", "Java").replace("FastAPI", "Spring").replace("**Python**", "**Java**")
            .replace("**FastAPI**", "**Spring**")
            for b in entry["bullets"]
        ]
        entry["used_skills"] = (
            str(entry.get("used_skills") or "")
            .replace("Python", "Java")
            .replace("FastAPI", "Spring")
        )
        entry["project_description"] = (
            str(entry.get("project_description") or "")
            .replace("Python", "Java")
            .replace("FastAPI", "Spring")
        )
    missing_problems = tailoring_problems(missing, plan, PROFILE)
    assert "primary_skills_missing_from_recent_roles" in missing_problems
    assert "FastAPI" in missing_problems["primary_skills_missing_from_recent_roles"]
    assert "Python" in missing_problems["primary_skills_missing_from_recent_roles"]

    over = copy.deepcopy(resume)
    over["profile_summary"] = "Staff Backend Engineer with 9 years building Python platforms on AWS for payments."
    assert "profile_summary_level_above_held" in tailoring_problems(over, plan, PROFILE)


def test_project_description_must_introduce_the_tailored_bullets():
    plan = _plan()
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, JOB)
    stale = copy.deepcopy(resume)
    # The original resume's description and stack, though the bullets now run on the posting's stack.
    stale["work_experience"][0]["project_description"] = (
        "Ledger platform that reconciles card payments for 4,000 merchants, built with Java, PHP and MySQL."
    )
    problems = tailoring_problems(stale, plan, PROFILE)
    issue = problems["work_experience[0]_project_description"]
    assert issue.startswith("Acme Payments:")
    assert "Java, which no bullet of this role uses" in issue
    assert "names none of the posting's technologies this role's bullets use" in issue
    assert "repeats the original resume's wording" in issue

    empty = copy.deepcopy(resume)
    empty["work_experience"][1]["project_description"] = ""
    assert "project_description is empty" in tailoring_problems(empty, plan, PROFILE)[
        "work_experience[1]_project_description"
    ]

    listed = copy.deepcopy(resume)
    listed["work_experience"][2]["project_description"] = "\u2022 Built **Python** billing jobs \u2022 Wrote tests"
    assert "not a list of contributions" in tailoring_problems(listed, plan, PROFILE)[
        "work_experience[2]_project_description"
    ]


def test_product_context_drops_the_original_stack_only():
    from app.services.resume_tailoring import _product_context
    from app.utils.resume_evidence import parse_profile_roles

    profile = (
        "## Work Experience\n**SAP** | Engineer | Jan 2022 - Present\n"
        "- Architected AI business platforms using Go, Python, TypeScript, React, and Azure OpenAI, governing "
        "automation that reduced repetitive operations by 45%\nTechnologies: Go, Python, Azure OpenAI\n"
    )
    role = parse_profile_roles(profile)[0]
    text = role.text.splitlines()[1][2:]
    out = _product_context(text, role)
    assert out == (
        "Architected AI business platforms, governing automation that reduced repetitive operations by 45%"
    )


def test_phase_b_repairs_descriptions_the_rewrites_left_stale(monkeypatch):
    calls: list[str] = []
    stale = _good_resume()
    stale["work_experience"][0]["project_description"] = (
        "Ledger platform that reconciles card payments for 4,000 merchants, built with Java, PHP and MySQL."
    )
    seen: dict[str, str] = {}

    async def fake_call(*, observe_name, user_content, **_kwargs):
        calls.append(observe_name)
        if observe_name == "phase_b_project_descriptions":
            seen["repair"] = user_content
            return {
                "project_descriptions": [
                    {
                        "index": 0,
                        "project_description": "Card payment ledger for merchants, where reconciliation runs as "
                        "Python and FastAPI services on Kubernetes with PostgreSQL and Kafka settlement events.",
                    }
                ]
            }
        return {"tailored_resume": copy.deepcopy(stale)}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    resume, _ = asyncio.run(
        job_match_service.generate_tailored_content_phase_b(
            JOB,
            PROFILE,
            structured_context=STRUCTURED,
            include_cover_letter=False,
            strategy="job_first",
        )
    )
    assert calls[-1] == "phase_b_project_descriptions" and calls.count("phase_b_project_descriptions") == 1
    # The rewrite sees the product without the original stack, plus the final bullets.
    assert "Ledger platform that reconciles card payments for 4,000 merchants" in seen["repair"]
    assert "Java, PHP" not in seen["repair"].split("## Roles to fix")[1].split('"bullets"')[0]
    assert "Designed the Python and FastAPI reconciliation services" in seen["repair"]
    assert resume["work_experience"][0]["project_description"].startswith("Card payment ledger")
    assert not any(i.endswith("_project_description") for i in resume["match_check"]["open_issues"])


def test_repairs_that_name_other_technologies_are_rejected():
    from app.services.resume_tailoring import apply_description_repairs

    resume = finalize_tailored_resume(_good_resume(), _plan(), PROFILE, JOB)
    before = resume["work_experience"][1]["project_description"]
    taken = apply_description_repairs(
        resume,
        PROFILE,
        _plan().terms,
        [{"index": 1, "project_description": "Clinic scheduling built with Angular, Spring Boot and Oracle."}],
    )
    assert taken == [] and resume["work_experience"][1]["project_description"] == before


def test_tailoring_contract_rewrites_the_project_description():
    from app.prompts.job_match_phase_b_prompt import (
        PHASE_B_PROJECT_DESCRIPTION_PLACEHOLDER,
        PHASE_B_RESUME_SYSTEM_PROMPT,
    )
    from app.prompts.resume_tailoring_prompt import TAILORING_SYSTEM_PROMPT

    assert PHASE_B_PROJECT_DESCRIPTION_PLACEHOLDER in PHASE_B_RESUME_SYSTEM_PROMPT
    assert PHASE_B_PROJECT_DESCRIPTION_PLACEHOLDER not in TAILORING_SYSTEM_PROMPT
    assert "introducing this role's bullets" in TAILORING_SYSTEM_PROMPT
    for prompt in (PHASE_B_RESUME_SYSTEM_PROMPT, TAILORING_SYSTEM_PROMPT):
        assert "keeps the role's profile" not in prompt and "kept as 1-2 sentences" not in prompt


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
    assert "Python" not in older and "KYC" not in older
    resume = finalize_tailored_resume(_good_resume(), plan, PROFILE, job)
    # Domain acronyms are vocabulary for bullets, not rows of the skills section.
    assert not any("KYC" in r["skills"] for r in resume["technical_skills"])
    resume["work_experience"][2]["bullets"][0] = (
        "Implemented **PHP** billing pages with KYC checks for invoice corrections."
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
    # Only the posting's stack, no Globex-native tools (PHP/MySQL/SVN/Jenkins).
    narrow["work_experience"][1]["bullets"] = [
        "Designed **Python** booking APIs deployed as **Docker** containers on **AWS**.",
        "Cached clinic calendars in **Redis** so booking pages stayed responsive.",
        "Moved reminder delivery onto **Python** workers on **AWS**.",
        "Built release pipelines for **Docker** images on every merge.",
        "Hardened clinic data access with role checks for treating staff.",
        "Partnered with clinicians on booking validation rules.",
    ]
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
    assert "FastAPI" in text and "Delivered PHP scheduling features" not in text


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
    # Coaching/mentoring evidence in the draft may already cover the mentor line.
    assert match["rate"] >= 83

    resume["work_experience"][1]["bullets"].append(
        "Mentored engineers through design reviews of the clinic scheduling services."
    )
    match = asyncio.run(requirement_match(resume, skills=plan.placeable, structured_context=STRUCTURED, job_text=JOB))
    assert match["rate"] == 100 and match["uncovered_lines"] == []


def test_phase_b_match_retry_is_advisory_not_forced_to_perfect(monkeypatch):
    """Above the advisory target, uncovered soft lines do not burn another rewrite."""
    calls: list[str] = []

    async def fake_call(*, observe_name, user_content, **_kwargs):
        calls.append(observe_name)
        return {"tailored_resume": copy.deepcopy(_good_resume())}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    resume, _ = asyncio.run(
        job_match_service.generate_tailored_content_phase_b(
            JOB,
            PROFILE,
            structured_context=STRUCTURED,
            include_cover_letter=False,
            strategy="job_first",
        )
    )
    # Good draft at ~83% with only a soft uncovered mentor line: no forced retry.
    assert calls == ["phase_b"]
    check = resume["match_check"]
    assert check["requirement_match"] == 83 and check["target"] == 75
    assert check["uncovered_lines"] == ["Mentor engineers through design reviews"]


def test_phase_b_one_advisory_retry_when_match_is_below_target(monkeypatch):
    calls: list[str] = []
    prompts: dict[str, str] = {}
    thin = _good_resume()
    # Strip most posting stack from bullets so requirement match falls below the advisory target.
    for entry in thin["work_experience"]:
        entry["bullets"] = [
            "Maintained internal admin tools for finance partners during the release cycle.",
            "Documented handoffs for on-call engineers covering weekend incidents.",
            "Improved code review notes so new hires could onboard to the product area.",
            "Supported release checklists with product managers before each deploy window.",
            "Closed defects reported by customer support during month-end reconciliation.",
        ][: len(entry["bullets"])]
        entry["used_skills"] = "Java, PHP, MySQL"
        entry["project_description"] = "Internal tools for the product team."

    covered = _good_resume()
    covered["work_experience"][1]["bullets"].append(
        "Mentored engineers through design reviews of **FastAPI** scheduling services."
    )

    async def fake_call(*, observe_name, user_content, **_kwargs):
        calls.append(observe_name)
        prompts[observe_name] = user_content
        return {"tailored_resume": copy.deepcopy(thin if observe_name == "phase_b" else covered)}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    resume, _ = asyncio.run(
        job_match_service.generate_tailored_content_phase_b(
            JOB,
            PROFILE,
            structured_context=STRUCTURED,
            include_cover_letter=False,
            strategy="job_first",
        )
    )
    assert "phase_b" in calls and "phase_b_quality_retry_1" in calls
    retry = prompts["phase_b_quality_retry_1"]
    assert "advisory target 75" in retry or "QUALITY RETRY" in retry
    assert "## Your previous draft" in retry
    check = resume["match_check"]
    assert check["target"] == 75
    assert check["requirement_match"] == 100
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
    assert {"python", "fastapi"} <= terms
    assert not {"typescript", "azure"} & terms
    assert {"TypeScript", "Azure"} <= set(plan.missing) or {"typescript", "azure"} <= {m.lower() for m in plan.missing}
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
    resume, letter = asyncio.run(
        job_match_service.generate_tailored_content_phase_b(JOB, PROFILE, strategy="job_first")
    )

    assert calls == ["phase_b", "phase_b_quality_retry_1", "phase_b_cover_letter"]
    assert "Career facts" in prompts["phase_b"] and "Target stack" in prompts["phase_b"]
    assert "Project evidence" in prompts["phase_b"]
    assert "Wrote PHP modules" not in prompts["phase_b"].split("## Job Description")[0].split("Domain clues")[0]
    assert "QUALITY RETRY" in prompts["phase_b_quality_retry_1"]
    # Cover letter is grounded on the original profile, not the tailored rewrite.
    assert "Wrote PHP modules" in prompts["phase_b_cover_letter"]
    assert "Do not invent stack history" in prompts["phase_b_cover_letter"]
    assert letter == {"body": "Dear team"}
    check = resume["match_check"]
    assert check["strategy"] == "job_first" and check["skill_coverage"] == 1.0 and check["open_issues"] == []
    assert check["target"] == 75


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
