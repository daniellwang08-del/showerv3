import re

from app.models.resume_design_schemas import ContentWork
from app.services.resume_design_service import _with_profile_project
from app.utils.profile_converter import user_profile_to_openai_text
from app.services.job_match_service import (
    build_must_cover_requirements,
    quality_retry_instructions,
    tailored_resume_quality_issues,
)
from app.services.required_skills import (
    CORE,
    MENTIONED,
    PREFERRED,
    REQUIRED,
    ensure_required_skills,
    filter_technical_skills_to_evidence,
    job_skill_terms,
    missing_from_experience,
    plan_required_skills,
    required_skills_block,
    requirement_lines,
)
from app.utils.resume_evidence import (
    enforce_role_evidence,
    evidence_by_company,
    parse_profile_roles,
    role_project,
    unattributed_role_terms,
)

STRUCTURED = """Title: Staff Software Engineer (L4) Data Platform
Company: Twilio
Location: Remote, British Columbia, Canada
Workplace Type: Remote"""

JOB = """Who we are
At Twilio, we're shaping the future of communications, all from the comfort of our homes.

About the job
This position is needed to build the data platform that powers analytics across Twilio.

Responsibilities
- Design and build scalable batch and streaming pipelines on our Data Lakehouse.
- Own data quality and data modeling for core datasets.

Qualifications
- 8+ years of experience with distributed systems such as Hadoop, Spark, and Kafka.
- Strong programming skills in Python, Java or Scala.
- Experience with AWS and data warehousing.
- Knowledge of table formats (Hudi, Iceberg, or Delta).

- Contributions to OSS projects and a track record of mentoring.
- Familiarity with Terraform is a plus.
- Department: Engineering
- Must have: Docker

Desired
- Experience with Airflow.

Benefits
- Generous time off and Kubernetes training stipends.
"""

PROFILE = """## Summary
Data engineer.

## Technical Skills
- **Languages**: Python, Java, SQL
- **Data Engineering**: Apache Spark, Databricks, Data Quality
- **Cloud**: AWS, GCP

## Work Experience
**Tableau** | Senior Data Engineer | Jan 2021 - Present
Project: Unified Metrics Lakehouse
Project description: Built the lakehouse that serves product analytics for 40k enterprise customers.
- Built PySpark jobs on Databricks processing 3 TB a day for distributed systems at scale.
- Added data quality checks that cut bad rows by 80%.
Technologies: PySpark, Databricks, Python

**Under Armour** | Data Engineer | Jun 2017 - Dec 2020
Project: Connected Fitness ETL
Project description: Ingestion of workout data from fitness apps into the analytics warehouse.
- Wrote Java services that loaded app events into the warehouse.
Technologies: Java, SQL
"""


def _plan():
    return plan_required_skills(job_skill_terms(JOB, STRUCTURED, company="Twilio"), PROFILE)


def _by_term(skills):
    return {s.term.lower(): s for s in skills}


def test_job_skill_terms_reads_requirements_not_boilerplate():
    skills = _by_term(job_skill_terms(JOB, STRUCTURED, company="Twilio"))
    for term in ("hadoop", "spark", "kafka", "python", "java", "scala", "aws", "hudi", "iceberg"):
        assert skills[term].importance == REQUIRED, term
    assert skills["airflow"].importance == PREFERRED
    assert skills["terraform"].importance == PREFERRED
    assert skills["docker"].importance == REQUIRED
    assert skills["data lakehouse"].importance == CORE
    assert "twilio" not in skills
    for noise in ("title", "company", "location", "remote", "staff", "comfort", "homes", "future", "mentoring", "engineering"):
        assert noise not in skills, noise
    assert skills["kubernetes"].importance == MENTIONED


def test_plan_splits_held_and_missing_skills():
    plan = _plan()
    held = _by_term(s for s in plan.supported if not s.added)
    assert set(held) >= {"spark", "python", "java", "aws", "data quality", "distributed systems"}
    assert held["spark"].roles == ["Tableau"]
    assert held["java"].roles == ["Under Armour"]
    assert held["aws"].roles == []

    # Honesty: nothing the profile lacks is invented onto the resume.
    assert plan.added == []
    missing = {t.lower() for t in plan.missing}
    assert {"hadoop", "kafka", "scala", "hudi", "iceberg", "docker", "airflow", "terraform"} <= missing
    for generic in ("mentoring", "oss", "kubernetes"):
        assert generic not in missing or generic == "kubernetes"


def test_required_skills_block_lists_roles_and_gaps():
    block = required_skills_block(_plan())
    assert "- Spark [required]: Tableau" in block
    assert "- AWS [required]: skills list or summary only (technical_skills)" in block
    assert "Amazon Web Services (AWS)" in block
    assert "Add to the resume" not in block
    assert "Not in the profile" in block and "Kafka" in block and "Airflow" in block
    assert "\u2014" not in block


def test_must_cover_uses_requirement_lines():
    lines = requirement_lines(JOB, STRUCTURED)
    assert lines[0].startswith("8+ years of experience with distributed systems")
    assert not any("comfort" in line or "time off" in line or "Department" in line for line in lines)
    assert "Must have: Docker" in lines
    must_cover = build_must_cover_requirements(STRUCTURED, JOB)
    assert "- Strong programming skills in Python, Java or Scala." in must_cover
    assert "Generous time off" not in must_cover and "Title:" not in must_cover


def _tailored():
    return {
        "profile_summary": "Senior data engineer building lakehouse pipelines on Databricks for product analytics.",
        "technical_skills": [
            {"category": "Languages", "skills": "Python, SQL"},
            {"category": "Data Engineering", "skills": "Databricks"},
        ],
        "work_experience": [
            {
                "company_name": "Tableau",
                "job_title": "Senior Data Engineer",
                "project_name": None,
                "project_description": "",
                "used_skills": "Databricks, Python",
                "bullets": ["Built batch jobs on Databricks processing 3 TB a day."],
            },
            {
                "company_name": "Under Armour",
                "job_title": "Data Engineer",
                "project_description": "",
                "used_skills": "SQL",
                "bullets": ["Loaded app events into the warehouse."],
            },
        ],
    }


def test_ensure_required_skills_adds_held_skills_only():
    resume = ensure_required_skills(_tailored(), _plan(), PROFILE)
    rows = {r["category"]: r["skills"] for r in resume["technical_skills"]}
    assert "Java" in rows["Languages"]
    assert "Spark" in rows["Data Engineering"].split(", ")
    assert "Data Quality" in rows["Data Engineering"]
    assert "AWS" in rows["Cloud"]
    blob = ", ".join(rows.values())
    for invented in ("Hadoop", "Kafka", "Iceberg", "Delta Lake", "Airflow", "Scala", "Docker"):
        assert invented not in blob, invented
    tableau, ua = resume["work_experience"]
    assert "Spark" in tableau["used_skills"]
    assert "Kafka" not in tableau["used_skills"]
    assert "Java" in ua["used_skills"]
    assert "AWS" not in tableau["used_skills"]
    assert "_required_skills_added" not in resume

    tailored = _tailored()
    tailored["technical_skills"].append(
        {"category": "Cloud", "skills": "Amazon Web Services, AWS, GCP, distributed systems"}
    )
    rows = {r["category"]: r["skills"] for r in ensure_required_skills(tailored, _plan(), PROFILE)["technical_skills"]}
    assert rows["Cloud"].startswith("AWS, GCP, Distributed Systems")
    assert "Amazon Web Services" not in rows["Cloud"]


def test_filter_drops_jd_only_and_soft_domain_skills():
    plan = _plan()
    resume = ensure_required_skills(_tailored(), plan, PROFILE)
    resume["technical_skills"].append(
        {"category": "Quality", "skills": "Fintech, SaaS, NestJS, Airflow, Customer Success"}
    )
    resume["technical_skills"][0]["skills"] += ", Weaviate"
    out = filter_technical_skills_to_evidence(resume, plan, PROFILE)
    blob = ", ".join(r["skills"] for r in out["technical_skills"])
    for junk in ("Fintech", "SaaS", "NestJS", "Airflow", "Customer Success", "Weaviate"):
        assert junk not in blob, junk
    assert "Python" in blob and "Spark" in blob


def test_filter_keeps_profile_skill_qualifiers_and_specific_names():
    profile = """## Technical Skills
- **DevOps**: Terraform basics, Docker, CI/CD
- **Analytics**: Looker Studio, Tableau
- **Cloud**: Kubernetes

## Work Experience
**Acme** | Engineer | Jan 2021 - Present
- Built dashboards.
Technologies: Looker Studio, Docker
"""
    resume = {
        "technical_skills": [
            {"category": "DevOps", "skills": "Terraform, Docker, CI, CD, CI/CD"},
            {"category": "Analytics", "skills": "Looker, Tableau"},
            {"category": "Cloud", "skills": "GKE, EKS, Kubernetes"},
            {"category": "Other", "skills": "FedRAMP, architecture, SDK"},
        ],
        "work_experience": [],
    }
    out = filter_technical_skills_to_evidence(resume, None, profile)
    blob = ", ".join(r["skills"] for r in out["technical_skills"])
    assert "Terraform basics" in blob
    assert "Looker Studio" in blob
    assert re.search(r"\bLooker\b", blob.replace("Looker Studio", "")) is None
    assert "CI/CD" in blob
    assert "FedRAMP" not in blob and "architecture" not in blob and "SDK" not in blob
    # Prefer the profile's kubernetes spelling over a JD-only GKE upgrade.
    assert "Kubernetes" in blob
    assert "GKE" not in blob


def test_missing_from_experience_only_tracks_held_role_skills():
    plan = _plan()
    resume = _tailored()
    missing = {s.term for s in missing_from_experience(resume, plan)}
    assert {"Spark", "Java"} <= missing
    assert "Kafka" not in missing and "Airflow" not in missing
    assert "AWS" not in missing
    issues = tailored_resume_quality_issues(resume, required_skills=plan)
    assert "required_skills_missing_from_experience" in issues
    note = quality_retry_instructions(resume, issues, required_skills=plan)
    assert "Spark (Tableau)" in note and "Java (Under Armour)" in note
    assert "Kafka" not in note

    resume["work_experience"][0]["bullets"] += [
        "Ran **PySpark** and Python jobs over distributed systems with data quality checks.",
    ]
    resume["work_experience"][1]["bullets"].append("Wrote **Java** loaders.")
    assert [s.term for s in missing_from_experience(resume, plan)] == []
    assert "required_skills_missing_from_experience" not in tailored_resume_quality_issues(
        resume, required_skills=plan
    )


def test_added_skill_is_allowed_only_in_its_assigned_role():
    # When a skill is intentionally carried via evidence addendum, it stays in that role only.
    plan = _plan()
    from app.services.required_skills import RequiredSkill

    plan.supported.append(
        RequiredSkill(term="Kafka", importance=REQUIRED, roles=["Tableau"], injectable=True, category="data", added=True)
    )
    evidence = plan.evidence_addendum()
    resume = _tailored()
    resume["work_experience"][0]["bullets"].append("Streamed events through **Kafka** into the lakehouse.")
    resume["work_experience"][0]["used_skills"] = "Databricks, Kafka"
    resume["work_experience"][1]["bullets"].append("Published app events to **Kafka**.")
    resume["work_experience"][1]["used_skills"] = "SQL, Kafka"
    assert unattributed_role_terms(resume, PROFILE, evidence, plan.posting_terms) == {1: ["Kafka"]}
    out = enforce_role_evidence(resume, PROFILE, evidence)
    assert out["work_experience"][0]["used_skills"] == "Databricks, Kafka"
    assert out["work_experience"][1]["used_skills"] == "SQL"
    assert evidence_by_company("## Tableau\nTechnologies: Looker\n\n" + evidence)["tableau"].count("Technologies") == 2


def test_enforce_role_evidence_restores_project_fields():
    roles = parse_profile_roles(PROFILE)
    assert role_project(roles[0]) == (
        "Unified Metrics Lakehouse",
        "Built the lakehouse that serves product analytics for 40k enterprise customers.",
    )
    resume = _tailored()
    resume["work_experience"][1]["project_description"] = "Reworded ingestion of fitness app workouts."
    out = enforce_role_evidence(resume, PROFILE)
    tableau, ua = out["work_experience"]
    assert tableau["project_name"] == "Unified Metrics Lakehouse"
    assert tableau["project_description"].startswith("Built the lakehouse")
    assert ua["project_name"] == "Connected Fitness ETL"
    assert ua["project_description"] == "Reworded ingestion of fitness app workouts."


def _profile(**work):
    row = {
        "company_name": "Tableau",
        "job_title": "Senior Data Engineer",
        "period_start": "2021-01",
        "project_title": "Unified Metrics Lakehouse",
        "contributions": ["Built PySpark jobs."],
        **work,
    }
    return {"work_experience": [row]}


def test_profile_text_labels_the_project_description():
    text = user_profile_to_openai_text(_profile(project_intro="Lakehouse for\nproduct analytics."))
    assert "Project: Unified Metrics Lakehouse\nProject description: Lakehouse for product analytics.\n- Built PySpark jobs." in text

    text = user_profile_to_openai_text(_profile(description="Lakehouse written as the role description."))
    assert "Project description: Lakehouse written as the role description." in text

    text = user_profile_to_openai_text(_profile(contributions=[], description="Free-form role description."))
    assert "Project description:" not in text and "Free-form role description." in text

    text = user_profile_to_openai_text(
        _profile(contributions=[], description="Worked on the metrics platform.\n\nBuilt Spark jobs.\n\nCut cost 30%.")
    )
    assert "Project description: Worked on the metrics platform.\n- Built Spark jobs.\n- Cut cost 30%." in text

    text = user_profile_to_openai_text(
        _profile(contributions=[], description="Metrics platform for\nanalysts.\n- Built Spark jobs.\n- Cut cost 30%.")
    )
    assert "Project description: Metrics platform for analysts.\n- Built Spark jobs.\n- Cut cost 30%." in text


def test_a_bulleted_description_beside_contributions_is_not_the_project_brief():
    # The description repeats the contributions as bullets: no brief, and nothing listed twice.
    text = user_profile_to_openai_text(
        _profile(
            contributions=["Built PySpark jobs for the lakehouse.", "Cut storage cost 30% with Iceberg."],
            description="\u2022 Built PySpark jobs for the lakehouse.\n\u2022 Cut storage cost 30% with Iceberg.",
        )
    )
    assert "Project description:" not in text
    assert text.count("Built PySpark jobs for the lakehouse.") == 1

    # A lead line above the bullets is the brief; bullets the contributions lack are kept.
    text = user_profile_to_openai_text(
        _profile(
            contributions=["Built PySpark jobs for the lakehouse."],
            description="Lakehouse for analysts.\n- Built PySpark jobs for the lakehouse.\n- Added dbt models.",
        )
    )
    assert "Project description: Lakehouse for analysts.\n- Built PySpark jobs for the lakehouse.\n- Added dbt models." in text

    # A paragraph restating a contribution is not a project brief either.
    text = user_profile_to_openai_text(
        _profile(
            contributions=["Built PySpark jobs that load product analytics into the lakehouse every hour."],
            description="Built PySpark jobs that load product analytics into the lakehouse every hour.",
        )
    )
    assert "Project description:" not in text


def test_render_keeps_profile_project_when_tailored_left_it_out():
    profile_rows = [
        ContentWork(
            company_name="Tableau Software",
            project_title="Unified Metrics Lakehouse",
            project_intro="Lakehouse for product analytics.",
            contributions=["Built PySpark jobs."],
        ),
        ContentWork(company_name="Under Armour", description="Ingestion into the warehouse.", contributions=["x"]),
    ]
    out = _with_profile_project(ContentWork(company_name="Tableau", job_title="SDE"), profile_rows)
    assert (out.project_title, out.project_intro) == ("Unified Metrics Lakehouse", "Lakehouse for product analytics.")
    kept = _with_profile_project(
        ContentWork(company_name="Tableau", project_title="Metrics", project_intro="Tailored."), profile_rows
    )
    assert (kept.project_title, kept.project_intro) == ("Metrics", "Tailored.")
    ua = _with_profile_project(ContentWork(company_name="Under Armour"), profile_rows)
    assert ua.project_intro == "Ingestion into the warehouse."
    assert _with_profile_project(ContentWork(company_name="Nike"), profile_rows).project_intro == ""
    legacy = [ContentWork(company_name="Salesforce", description="Worked on Einstein.\n\nBuilt routing.")]
    assert _with_profile_project(ContentWork(company_name="Salesforce"), legacy).project_intro == "Worked on Einstein."
