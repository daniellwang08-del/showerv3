from app.models.profile_schemas import ResumeExtractedDraft
from app.services.resume_parse_service import (
    _coerce_resume_period,
    _fill_missing_contact_from_text,
    _infer_field_from_degree,
    _normalize_draft,
    _normalize_phone_fields,
)


def test_uk_trunk_zero_is_stripped():
    assert _normalize_phone_fields("+44", "(0)7700 900123") == ("+44", "7700900123")
    assert _normalize_phone_fields(None, "+44 (0)7700 900123") == ("+44", "7700900123")
    assert _normalize_phone_fields(None, "+44(0)7700900123") == ("+44", "7700900123")


def test_00_international_prefix():
    assert _normalize_phone_fields(None, "00 44 7700 900123") == ("+44", "7700900123")
    assert _normalize_phone_fields(None, "00447700900123") == ("+44", "7700900123")


def test_fill_recovers_00_prefix_from_header_text():
    draft = ResumeExtractedDraft()
    notes = _fill_missing_contact_from_text(
        draft,
        "Jane Doe\nLondon, UK\n00 44 7700 900123\njane@example.com\n",
    )
    assert draft.phone_country_code == "+44"
    assert draft.phone_number == "7700900123"
    assert any("Phone number" in n for n in notes)


def test_coerce_resume_period_month_names_and_present():
    assert _coerce_resume_period("Aug 2023") == "2023-08"
    assert _coerce_resume_period("September 2018") == "2018-09"
    assert _coerce_resume_period("2021") == "2021"
    assert _coerce_resume_period("Present") is None
    assert _coerce_resume_period("current") is None


def test_infer_field_from_degree_tricky_titles():
    assert _infer_field_from_degree("B.S. Computer Science") == "Computer Science"
    assert _infer_field_from_degree("MSc in Electrical Engineering") == "Electrical Engineering"
    assert _infer_field_from_degree("BA, History") == "History"
    assert _infer_field_from_degree("Bachelor of Science in Data Science") == "Data Science"
    assert _infer_field_from_degree("B.S. Computer Science", "Software Engineering") == "Software Engineering"


def test_normalize_draft_coerces_dates_and_fills_description():
    draft = _normalize_draft(
        {
            "work_experience": [
                {
                    "company_name": "Google LLC",
                    "job_title": "SWE",
                    "period_start": "Aug 2023",
                    "period_end": "Present",
                    "contributions": ["Built search ranking", "Shipped ads quality"],
                }
            ],
            "education": [
                {
                    "university_name": "MIT",
                    "degree": "B.S. Computer Science",
                    "period_start": "Sep 2018",
                    "period_end": "May 2022",
                }
            ],
        }
    )
    role = draft.work_experience[0]
    assert role.period_start == "2023-08"
    assert role.period_end is None
    assert "Built search ranking" in (role.description or "")
    assert "Shipped ads quality" in (role.description or "")
    edu = draft.education[0]
    assert edu.period_start == "2018-09"
    assert edu.period_end == "2022-05"
    assert edu.field_of_study == "Computer Science"


def test_normalize_draft_splits_description_into_contributions():
    draft = _normalize_draft(
        {
            "work_experience": [
                {
                    "company_name": "Stripe",
                    "job_title": "Engineer",
                    "description": "- Cut checkout latency 30%\n- Owned fraud rules",
                }
            ]
        }
    )
    role = draft.work_experience[0]
    assert role.contributions == ["Cut checkout latency 30%", "Owned fraud rules"]
    assert role.description
