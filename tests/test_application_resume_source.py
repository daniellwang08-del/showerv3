from app.api.assistant_routes import _tailored_resume_text
from app.services.job_pipeline_mode import normalize_application_resume_source


def test_normalize_application_resume_source_defaults_to_tailored():
    assert normalize_application_resume_source("original") == "original"
    assert normalize_application_resume_source("tailored") == "tailored"
    assert normalize_application_resume_source(None) == "tailored"
    assert normalize_application_resume_source("") == "tailored"
    assert normalize_application_resume_source("something-else") == "tailored"


PROFILE = [
    {
        "company_name": "Stripe, Inc.",
        "job_title": "Senior Engineer",
        "period_start": "2021-08",
        "period_end": None,
        "location": "Remote",
        "description": "Built payment rails.",
        "contributions": [],
    }
]


def test_tailored_text_keeps_profile_facts_and_uses_tailored_wording():
    tailored = {
        "profile_summary": "**Payments engineer** focused on reliability.",
        "technical_skills": [{"category": "Backend", "skills": "Go, Kafka"}, "go", "Postgres"],
        "work_experience": [
            {
                "company_name": "Stripe",
                "job_title": "Staff Payments Wizard",
                "period_start": "2019-01",
                "description": "Led the ledger migration to Kafka.",
            }
        ],
    }
    text = _tailored_resume_text(tailored, PROFILE)
    assert text.startswith("## Tailored Resume For This Job")
    assert "Payments engineer focused on reliability." in text
    assert "**Payments" not in text
    assert "Go, Kafka, Postgres" in text
    assert "Led the ledger migration to Kafka." in text
    # Employer, title, and dates come from the saved profile, not the rewrite.
    assert "Senior Engineer" in text
    assert "Staff Payments Wizard" not in text
    assert "08/2021" in text
    assert "\u2014" not in text


def test_tailored_text_empty_when_nothing_tailored():
    assert _tailored_resume_text({}, PROFILE) == ""
    assert _tailored_resume_text(None, PROFILE) == ""
