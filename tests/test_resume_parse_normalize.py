"""Resume draft normalization helpers."""

from app.models.profile_schemas import ResumeExtractedDraft, ResumeSkillBlock
from app.services.resume_parse_service import (
    _coerce_technical_skills,
    _fill_missing_contact_from_text,
    _fill_missing_skills_from_text,
    _infer_job_type,
    _normalize_linkedin_url,
    _normalize_phone_fields,
    _parse_skills_section_from_text,
)


def test_normalize_us_phone_from_combined_string():
    cc, num = _normalize_phone_fields(None, "(610) 234-7936")
    assert cc == "+1"
    assert num == "(610) 234-7936"


def test_normalize_us_phone_split_across_fields():
    cc, num = _normalize_phone_fields("(610)", "234-7936")
    assert cc == "+1"
    assert num == "(610) 234-7936"


def test_normalize_us_phone_digits_only():
    cc, num = _normalize_phone_fields("+1", "6102347936")
    assert cc == "+1"
    assert num == "(610) 234-7936"


def test_infer_job_type_defaults_to_onsite_with_location():
    assert _infer_job_type("Menlo Park, CA", None, None) == "onsite"
    assert _infer_job_type("Remote", None, None) == "remote"


def test_infer_job_type_respects_explicit_value():
    assert _infer_job_type("Sunnyvale, CA", "hybrid", None) == "hybrid"


def test_normalize_linkedin_adds_https():
    assert _normalize_linkedin_url("linkedin.com/in/guojiwei428") == "https://www.linkedin.com/in/guojiwei428"


def test_normalize_linkedin_strips_query_and_slash():
    assert (
        _normalize_linkedin_url("https://www.linkedin.com/in/jane-doe/?trk=public")
        == "https://www.linkedin.com/in/jane-doe"
    )


def test_fill_missing_linkedin_from_header_text():
    header = """Jane Doe
jane@example.com
LinkedIn
"""
    # Simulate hyperlink extraction having prepended the real URL
    text = "Document links:\nhttps://www.linkedin.com/in/jane-doe-123\n\n" + header
    draft = ResumeExtractedDraft(name_first="Jane", name_last="Doe", email="jane@example.com")
    notes = _fill_missing_contact_from_text(draft, text)
    assert draft.linkedin_url == "https://www.linkedin.com/in/jane-doe-123"
    assert any("LinkedIn URL was recovered" in n for n in notes)


def test_fill_missing_phone_from_jiwei_header_text():
    header = """Jiwei Guo
Senior Software Engineer
jiwei.c.guo@gmail.com

(610) 234-7936

Sunnyvale, CA

linkedin.com/in/guojiwei428
"""
    draft = ResumeExtractedDraft(
        name_first="Jiwei",
        name_last="Guo",
        email="jiwei.c.guo@gmail.com",
        linkedin_url="https://linkedin.com/in/guojiwei428",
    )
    notes = _fill_missing_contact_from_text(draft, header)
    assert draft.phone_number == "(610) 234-7936"
    assert draft.phone_country_code == "+1"
    assert any("Phone number" in n for n in notes)


JIWEI_SKILLS_SNIPPET = """SKILLS
Languages
Python, Java, C#, Golang, C++, JS/TS, SQL
AI & Data
LLMs (OpenAI, Anthropic, Gemini, Llama), Tesseract OCR, NLTK, Scikit-learn, Numpy, Pandas
Databases
PostgreSQL, MySQL, Microsoft SQL Server, DynamoDB, MongoDB, Redis
Frameworks
Spring Boot, Django, FastAPI, Node.js, ASP.NET Core, Gin, React, Redux
Cloud & DevOps
AWS, GCP, Microsoft Azure, Docker, Kubernetes, Terraform, Jenkins, Helm, Prometheus, Grafana
Testing
Jest, Mocha, Cypress, JUnit, PyTest, Mockito
"""


def test_parse_skills_section_from_jiwei_resume():
    blocks = _parse_skills_section_from_text(JIWEI_SKILLS_SNIPPET)
    assert len(blocks) == 6
    assert blocks[0].category == "Languages"
    assert "Python" in blocks[0].skills
    assert blocks[3].category == "Frameworks"
    assert "FastAPI" in blocks[3].skills


def test_coerce_technical_skills_drops_technologies_used_without_category():
    raw = [
        ResumeSkillBlock(
            category=None,
            skills="Technologies Used: Python, C#, C++, FastAPI, ASP.NET Core",
        )
    ]
    assert _coerce_technical_skills(raw) == []


def test_fill_missing_skills_replaces_sparse_llm_output():
    draft = ResumeExtractedDraft(
        technical_skills=[
            ResumeSkillBlock(
                category=None,
                skills="Technologies Used: Python, C#, C++, FastAPI",
            )
        ]
    )
    notes = _fill_missing_skills_from_text(draft, JIWEI_SKILLS_SNIPPET)
    assert len(draft.technical_skills) == 6
    assert draft.technical_skills[0].category == "Languages"
    assert any("Technical skills were recovered" in n for n in notes)

