from app.services.job_match_service import (
    quality_retry_instructions,
    tailored_resume_quality_issues,
)
from app.utils.resume_evidence import (
    build_role_evidence_block,
    build_source_facts_block,
    cap_skills_section,
    copied_job_phrases,
    enforce_role_evidence,
    expand_acronyms_once,
    is_mentioned,
    parse_profile_roles,
    parse_profile_skills,
    split_skill_items,
    summary_opening_title,
    summary_unattributed_terms,
    summary_unheld_title,
    unattributed_role_terms,
)
from app.utils.resume_skill_taxonomy import fill_thin_skill_rows, fold_small_skill_rows, rehome_misplaced_skills

PROFILE = """## Summary
Backend engineer.

## Technical Skills
- **Languages**: Python, C#/.NET, TypeScript
- **Cloud**: AWS(Lambda, S3), Kubernetes, Terraform

## Work Experience
**Acme Corp** | Senior Software Engineer | Jul 2022 - Present
- Led migration of billing services to AWS Lambda, cutting infra cost by 60%.
- Built Python APIs serving 2M users.
- Mentored four engineers on API design and code reviews.
Technologies: Python, AWS, Lambda

**Globex** | Software Engineer | Jan 2019 - Jun 2022
- Contributed to a C# order service for large fleets of devices.
Technologies: C#, .NET

## Education
BS Computer Science
"""


def _resume(**overrides):
    resume = {
        "profile_summary": "Senior software engineer with 7 years building Python backend services on AWS, "
        "including a Lambda migration that cut infrastructure cost by 60%.",
        "technical_skills": [{"category": "Languages", "skills": "Python, C#, .NET, Rust"}],
        "work_experience": [
            {
                "company_name": "ACME",
                "job_title": "Staff Engineer",
                "period_start": None,
                "period_end": None,
                "used_skills": "Python, Kubernetes, Lambda",
                "bullets": ["Led the migration of billing to **AWS Lambda**, cutting cost by **60%**."],
            },
            {
                "company_name": "Globex",
                "job_title": "Software Engineer",
                "used_skills": "C#, .NET",
                "bullets": ["Contributed to a C# order service for large device fleets."],
            },
        ],
    }
    resume.update(overrides)
    return resume


def test_parse_roles_and_skills():
    roles = parse_profile_roles(PROFILE)
    assert [(r.company, r.title, r.period_start, r.period_end) for r in roles] == [
        ("Acme Corp", "Senior Software Engineer", "Jul 2022", ""),
        ("Globex", "Software Engineer", "Jan 2019", "Jun 2022"),
    ]
    assert parse_profile_skills(PROFILE) == [
        "Python", "C#", ".NET", "TypeScript", "AWS", "Lambda", "S3", "Kubernetes", "Terraform",
    ]


def test_split_skill_items_keeps_concepts_together():
    assert split_skill_items("CI/CD, xUnit/NUnit, Python(FastAPI)") == ["CI/CD", "xUnit", "NUnit", "Python", "FastAPI"]


def test_aliases_and_word_boundaries():
    assert is_mentioned("Kubernetes", "deployed on EKS")
    assert is_mentioned("PostgreSQL", "tuned Postgres queries")
    assert not is_mentioned("Java", "JavaScript services")
    assert not is_mentioned("Go", "Google Cloud")


def test_enforce_role_evidence_restores_facts_and_filters_skills():
    out = enforce_role_evidence(_resume(), PROFILE)
    first = out["work_experience"][0]
    assert first["company_name"] == "Acme Corp"
    assert first["job_title"] == "Senior Software Engineer"
    assert (first["period_start"], first["period_end"]) == ("Jul 2022", None)
    assert first["used_skills"] == "Python, Lambda"
    assert out["technical_skills"] == [{"category": "Languages", "skills": "Python, C#, .NET"}]


def test_unattributed_terms_flag_borrowed_technology():
    resume = _resume()
    resume["work_experience"][1]["bullets"].append("Deployed the order service on Kubernetes with Terraform.")
    assert unattributed_role_terms(resume, PROFILE) == {1: ["Kubernetes", "Terraform"]}
    assert unattributed_role_terms(_resume(), PROFILE) == {}


def test_summary_unattributed_terms():
    assert summary_unattributed_terms(_resume(), PROFILE) == []
    resume = _resume(profile_summary="Engineer running Kubernetes clusters and Python services at scale for years.")
    assert summary_unattributed_terms(resume, PROFILE) == ["Kubernetes"]


def test_summary_opening_title():
    assert summary_opening_title("Senior **Software Engineer** with 8 years of experience. More.") == (
        "Senior Software Engineer"
    )
    assert summary_opening_title("Software Development Engineer in Test, building QA systems.") == (
        "Software Development Engineer in Test"
    )
    assert summary_opening_title("Senior Software Engineer targeting Staff roles.") == "Senior Software Engineer"
    assert summary_opening_title("Built Python services for 8 years.") == ""


def test_summary_unheld_title_allows_engineering_families_only():
    def opening(text):
        return summary_unheld_title(_resume(profile_summary=text), PROFILE)

    assert opening("Senior Software Engineer with 7 years building services.") == ""
    assert opening("Senior Machine Learning Engineer with 7 years of production ML.") == ""
    assert opening("Senior Full-Stack Engineer with 7 years.") == ""
    assert opening("Senior data-focused software engineer with 7 years.") == ""
    assert opening("Senior Software Development Engineer with 7 years.") == ""
    assert opening("Senior Software Development Engineer in Test with 7 years.") == (
        "Senior Software Development Engineer in Test"
    )
    assert opening("Engineering Manager with 7 years leading teams.") == "Engineering Manager"
    assert opening("Staff AI Engineer with 7 years.") == "Staff AI Engineer"
    assert opening("Senior AI Engineer with 7 years.") == ""


def test_role_evidence_block_lists_skills_without_a_role():
    block = build_role_evidence_block(PROFILE, job_terms=["Lambda", "GraphQL"])
    assert "- [0] Acme Corp | Senior Software Engineer | Jul 2022 - Present: Python, AWS, Lambda" in block
    assert "- [1] Globex | Software Engineer | Jan 2019 - Jun 2022: C#, .NET" in block
    assert "Skills list only" in block and "Kubernetes" in block and "GraphQL" not in block


def test_source_facts_block():
    facts = build_source_facts_block(PROFILE)
    assert "60%" in facts and "2M users" in facts and "large fleets" in facts
    assert facts.splitlines()[-1] == "- [Acme Corp] Mentored four engineers on API design and code reviews."


def test_copied_job_phrases():
    jd = "You will design build and maintain scalable backend services for our payments platform."
    resume = _resume(profile_summary="I design build and maintain scalable backend services for our payments team.")
    assert copied_job_phrases(resume, jd) == ["design build and maintain scalable backend services for our payments"]
    assert copied_job_phrases(_resume(), jd) == []


def test_rehome_misplaced_skills_only_into_existing_categories():
    out = rehome_misplaced_skills(
        [
            {"category": "Languages", "skills": "Python, Node.js, .NET, Bash"},
            {"category": "Databases", "skills": "PostgreSQL, DynamoDB, Azure AI Search, Cosmos DB"},
            {"category": "Backend", "skills": "FastAPI"},
            {"category": "Cloud", "skills": "AWS"},
        ]
    )
    assert out == [
        {"category": "Languages", "skills": "Python, Bash"},
        {"category": "Databases", "skills": "PostgreSQL, DynamoDB, Cosmos DB"},
        {"category": "Backend", "skills": "FastAPI, Node.js, .NET"},
        {"category": "Cloud", "skills": "AWS, Azure AI Search"},
    ]
    assert rehome_misplaced_skills([{"category": "Languages", "skills": "Python, Node.js"}]) == [
        {"category": "Languages", "skills": "Python, Node.js"}
    ]
    # "sql" is a whole word, not the start of "SQLAlchemy".
    assert rehome_misplaced_skills(
        [{"category": "Languages", "skills": "Python, SQL"}, {"category": "Backend", "skills": "SQLAlchemy"}]
    ) == [{"category": "Languages", "skills": "Python, SQL"}, {"category": "Backend", "skills": "SQLAlchemy"}]


def test_fold_small_skill_rows_moves_strays_into_their_category():
    rows = [
        {"category": "Cloud", "skills": "AWS, Azure, GCP"},
        {"category": "Tools", "skills": "Amazon S3"},
        {"category": "Security", "skills": "SOC 2"},
    ]
    assert fold_small_skill_rows(rows) == [
        {"category": "Cloud", "skills": "AWS, Azure, GCP, Amazon S3"},
        {"category": "Security", "skills": "SOC 2"},
    ]


def test_fill_thin_skill_rows_tops_up_from_the_matching_category():
    rows = [{"category": "Cloud", "skills": "AWS, Amazon S3"}, {"category": "Languages", "skills": "Python"}]
    out = fill_thin_skill_rows(rows, ["Amazon S3", "Docker", "Amazon SQS", "AWS Lambda", "Azure"], 4)
    assert out == [
        {"category": "Cloud", "skills": "AWS, Amazon S3, Amazon SQS, AWS Lambda"},
        {"category": "Languages", "skills": "Python"},
    ]


def test_expand_acronyms_once_skips_product_names():
    resume = _resume(profile_summary="Engineer shipping **AWS** SageMaker and AWS-native services.")
    resume["work_experience"][0]["bullets"] = ["Moved billing to AWS, cutting cost by 60%.", "Ran more on AWS."]
    out = expand_acronyms_once(resume, ["AWS", "Python"])
    assert out["profile_summary"] == "Engineer shipping **AWS** SageMaker and AWS-native services."
    assert out["work_experience"][0]["bullets"] == [
        "Moved billing to Amazon Web Services (AWS), cutting cost by 60%.",
        "Ran more on AWS.",
    ]
    again = expand_acronyms_once(out, ["AWS"])
    assert again["work_experience"][0]["bullets"][1] == "Ran more on AWS."
    bold = expand_acronyms_once(_resume(profile_summary="Built **LLM** pipelines."), ["LLM"])
    assert bold["profile_summary"] == "Built **Large Language Model (LLM)** pipelines."


def test_cap_skills_section_trims_largest_category_and_keeps_job_terms():
    skills = [
        {"category": "Languages", "skills": "Python, Go"},
        {"category": "Databases", "skills": "PostgreSQL, MySQL, MongoDB, Redis, Snowflake"},
    ]
    out = cap_skills_section(skills, "We use Snowflake and Python.", limit=4)
    assert out == [
        {"category": "Languages", "skills": "Python, Go"},
        {"category": "Databases", "skills": "PostgreSQL, Snowflake"},
    ]
    assert cap_skills_section(skills, "", limit=30) == skills


def test_quality_issues_block_borrowed_tech_and_long_summary():
    resume = enforce_role_evidence(_resume(), PROFILE)
    checks = {"profile_text": PROFILE, "job_text": "Python AWS Lambda", "claim_terms": ["Kubernetes"]}
    assert tailored_resume_quality_issues(resume, **checks) == []

    resume["work_experience"][1]["bullets"].append("Ran the service on Kubernetes.")
    resume["profile_summary"] = " ".join(["word"] * 95)
    issues = tailored_resume_quality_issues(resume, **checks)
    assert "work_experience[1]_unattributed_technology" in issues
    assert "profile_summary_too_long" in issues

    note = quality_retry_instructions(resume, issues, **checks)
    assert "Globex: the profile never ties Kubernetes to this role" in note
    assert "\u2014" not in note


def test_bullet_counts_are_no_longer_minimums():
    resume = enforce_role_evidence(_resume(), PROFILE)
    issues = tailored_resume_quality_issues(resume, profile_text=PROFILE)
    assert not any("bullets" in i for i in issues)
    resume["work_experience"][1]["bullets"] = []
    assert "work_experience[1]_no_bullets" in tailored_resume_quality_issues(resume, profile_text=PROFILE)
    resume["work_experience"][1]["bullets"] = ["Did a thing with C# for the order service."] * 30
    assert "too_many_bullets" in tailored_resume_quality_issues(resume, profile_text=PROFILE)
