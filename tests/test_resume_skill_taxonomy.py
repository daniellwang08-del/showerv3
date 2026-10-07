from app.utils.resume_keyword_emphasis import (
    apply_keyword_emphasis_to_resume,
    emphasize_keywords_in_text,
)
from app.utils.resume_skill_taxonomy import (
    cap_bold_spans,
    normalize_skill_categories,
    normalize_skill_category,
    normalize_skill_list,
    normalize_tailored_formatting,
)
from app.utils.resume_text_format import parse_inline_markup


def test_category_names_drop_filler_and_join_noise():
    assert normalize_skill_category("Frontend & Libraries") == "Frontend"
    assert normalize_skill_category("Backend & APIs") == "Backend"
    assert normalize_skill_category("Database & Storage") == "Databases"
    assert normalize_skill_category("Cloud Platforms") == "Cloud"
    assert normalize_skill_category("DevOps & CI/CD") == "DevOps"
    assert normalize_skill_category("Programming Languages") == "Languages"
    assert normalize_skill_category("Front-End") == "Frontend"
    assert normalize_skill_category("**Backend**:") == "Backend"


def test_category_names_keep_meaningful_terms():
    assert normalize_skill_category("Build Tools") == "Build Tools"
    assert normalize_skill_category("CI/CD") == "CI/CD"
    assert normalize_skill_category("Infrastructure as Code") == "Infrastructure as Code"
    assert normalize_skill_category("Machine Learning") == "Machine Learning"


def test_skill_list_is_plain_and_spaced():
    assert normalize_skill_list("React,TypeScript,**Node.js**") == "React, TypeScript, Node.js"
    assert normalize_skill_list("AWS; GCP | Azure \u00b7 aws") == "AWS, GCP, Azure"


def test_compound_category_is_split_by_lexicon():
    out = normalize_skill_categories(
        [{"category": "Cloud & DevOps", "skills": "AWS, Docker, Kubernetes, GCP, Terraform"}]
    )
    assert out == [
        {"category": "Cloud", "skills": "AWS, GCP"},
        {"category": "DevOps", "skills": "Docker, Kubernetes, Terraform"},
    ]


def test_categories_merge_and_items_appear_once():
    out = normalize_skill_categories(
        [
            {"category": "Frontend & Libraries", "skills": "React, Redux"},
            {"category": "Front End", "skills": "Vue, React"},
            {"category": "Skills", "skills": "Git, Jira"},
        ]
    )
    assert out == [
        {"category": "Frontend", "skills": "React, Redux, Vue"},
        {"category": "Tools", "skills": "Git, Jira"},
    ]


def test_cap_bold_spans_unwraps_extras():
    text = "Built **Kafka** with **Go**, **Redis** and **AWS** on **EKS**"
    assert cap_bold_spans(text, 3) == "Built **Kafka** with **Go**, **Redis** and AWS on EKS"
    assert cap_bold_spans("dangling **bold", 3) == "dangling bold"


def test_word_fragment_bold_renders_plain():
    segs = parse_inline_markup("**Design**ed with **engineer**s on **AWS**, cutting **40%**")
    assert [(s.text, s.bold) for s in segs] == [
        ("Designed with engineers on ", False),
        ("AWS", True),
        (", cutting ", False),
        ("40%", True),
    ]


def test_skill_qualifiers_survive_normalization():
    out = normalize_skill_categories(
        [
            {"category": "Testing", "skills": "Cypress, Playwright (basic), REST Assured"},
            {"category": "Languages", "skills": "Java, TypeScript (basic)"},
        ]
    )
    flat = ", ".join(r["skills"] for r in out)
    assert "Playwright (basic)" in flat
    assert "TypeScript (basic)" in flat


def test_cap_bold_spans_drops_low_value_words():
    text = "Owned **key** **data** flows on **Kafka**, cutting latency **40%**"
    assert cap_bold_spans(text, 3) == "Owned key data flows on **Kafka**, cutting latency **40%**"


def test_emphasis_skips_common_words_and_lowercase_collisions():
    out = emphasize_keywords_in_text(
        "Helped the team go live with Go services and key data",
        ["Go", "key", "data"],
        max_spans=3,
    )
    assert out == "Helped the team go live with **Go** services and key data"


def test_emphasis_respects_budget_and_first_occurrence():
    out = emphasize_keywords_in_text(
        "Used Kafka and Kafka Streams with Python, Go, Redis and Docker",
        ["Kafka", "Python", "Redis", "Docker"],
        max_spans=2,
    )
    assert out.count("**") // 2 == 2


def test_emphasis_never_touches_skill_lists():
    resume = {
        "profile_summary": "Engineer with Python.",
        "technical_skills": [{"category": "Languages", "skills": "Python, Go"}],
        "work_experience": [{"bullets": ["Built Python services"], "used_skills": "Python, Go"}],
    }
    out = apply_keyword_emphasis_to_resume(resume, ["Python"])
    assert out["technical_skills"][0]["skills"] == "Python, Go"
    assert out["work_experience"][0]["used_skills"] == "Python, Go"
    assert out["work_experience"][0]["bullets"] == ["Built Python services"]
    assert out["profile_summary"] == "Engineer with **Python**."


def test_emphasis_never_bolds_name_fragments():
    out = emphasize_keywords_in_text(
        "Machine learning engineer at BrightLane Market using Python",
        ["Machine", "Market", "Python"],
        max_spans=4,
    )
    assert out == "Machine learning engineer at BrightLane Market using **Python**"
    assert cap_bold_spans("Grew **BrightLane** **Market** sales", 3) == "Grew **BrightLane Market** sales"


def test_normalize_tailored_formatting_end_to_end():
    resume = {
        "profile_summary": "x",
        "technical_skills": [{"category": "Backend & APIs", "skills": "**Node.js**,**Express**"}],
        "work_experience": [
            {
                "used_skills": "React,TypeScript,JavaScript",
                "bullets": ["**React**, **Vue**, **Go** and **Rust**"],
            }
        ],
    }
    out = normalize_tailored_formatting(resume)
    assert out["technical_skills"] == [{"category": "Backend", "skills": "Node.js, Express"}]
    assert out["work_experience"][0]["used_skills"] == "React, TypeScript, JavaScript"
    assert out["work_experience"][0]["bullets"] == ["**React**, **Vue**, Go and Rust"]
