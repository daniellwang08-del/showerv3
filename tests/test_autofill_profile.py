from app.api.assistant_routes import (
    _address_for_autofill,
    _build_education,
    _build_work_experience,
    _to_mmyyyy,
)
from app.services.resume_context_builder import _merge_tailored_work_experience
from app.utils.company_name import companies_match


def test_company_aliases_match():
    assert companies_match("Google LLC", "Google")
    assert companies_match("Meta Platforms, Inc.", "Meta Platforms")
    assert companies_match("IBM Corporation", "IBM")
    assert not companies_match("Google", "Meta")
    assert not companies_match("A", "Acme")


def test_to_mmyyyy_tricky_dates():
    assert _to_mmyyyy("Aug 2023") == "08/2023"
    assert _to_mmyyyy("2023-08") == "08/2023"
    assert _to_mmyyyy("2021") == "01/2021"
    assert _to_mmyyyy("Present") == ""
    assert _to_mmyyyy("not-a-date") == ""


def test_original_fill_uses_contributions_when_description_empty():
    profile = [
        {
            "company_name": "Stripe",
            "job_title": "Engineer",
            "period_start": "2021-08",
            "period_end": None,
            "location": "Remote",
            "description": "",
            "contributions": ["Cut checkout latency 30%", "Owned fraud rules"],
            "project_intro": "Payments platform",
        }
    ]
    rows = _build_work_experience(profile, None, "original")
    assert len(rows) == 1
    assert rows[0]["company"] == "Stripe"
    assert rows[0]["startMMYYYY"] == "08/2021"
    assert rows[0]["current"] is True
    assert "Cut checkout latency 30%" in rows[0]["description"]
    assert "Payments platform" in rows[0]["description"]


def test_tailored_keeps_profile_facts_and_uses_tailored_narrative():
    profile = [
        {
            "company_name": "Google",
            "job_title": "Software Engineer",
            "period_start": "2022-01",
            "period_end": "2023-06",
            "location": "London, UK",
            "contributions": ["Old bullet"],
        },
        {
            "company_name": "Google",
            "job_title": "Senior Software Engineer",
            "period_start": "2023-07",
            "period_end": None,
            "location": "London, UK",
            "contributions": ["Lead old bullet"],
        },
    ]
    tailored = [
        {
            "company_name": "Google LLC",
            "job_title": "Staff SWE (rewritten)",
            "period_start": "1999-01",
            "location": "Mountain View, CA",
            "project_description": "Search ads quality",
            "bullets": ["Shipped **ranking** model"],
        },
        {
            "company_name": "Google LLC",
            "job_title": "Software Engineer",
            "bullets": ["Built query parser"],
        },
    ]
    rows = _build_work_experience(profile, tailored, "tailored")
    assert [r["title"] for r in rows] == ["Software Engineer", "Senior Software Engineer"]
    assert [r["company"] for r in rows] == ["Google", "Google"]
    assert rows[0]["startMMYYYY"] == "01/2022"
    assert rows[0]["endMMYYYY"] == "06/2023"
    assert rows[0]["location"] == "London, UK"
    assert "Built query parser" in rows[0]["description"]
    assert "ranking" in rows[1]["description"]
    assert "**" not in rows[1]["description"]
    assert "Staff SWE" not in rows[1]["title"]
    assert "Mountain View" not in rows[0]["location"]


def test_tailored_falls_back_to_profile_when_bullets_missing():
    profile = [
        {
            "company_name": "Acme",
            "job_title": "Analyst",
            "period_start": "2020",
            "contributions": ["Owned weekly forecast"],
            "description": "",
        }
    ]
    tailored = [{"company_name": "Acme Inc", "job_title": "Analyst", "bullets": []}]
    rows = _build_work_experience(profile, tailored, "tailored")
    assert "Owned weekly forecast" in rows[0]["description"]
    assert rows[0]["startMMYYYY"] == "01/2020"


def test_address_does_not_invent_usa():
    london = _address_for_autofill({"city": "London", "country": "United Kingdom"})
    assert london["country"] == "United Kingdom"
    bare_city = _address_for_autofill({"city": "Berlin"})
    assert bare_city["country"] == ""
    us = _address_for_autofill({"city": "Boston", "state": "MA", "postal_code": "02115"})
    assert us["country"] == "United States of America"


def test_resume_context_merge_matches_company_alias():
    profile = [
        {
            "company_name": "Google",
            "job_title": "SWE",
            "contributions": ["old"],
            "period": "2022 - 2023",
            "location": "London",
        }
    ]
    tailored = [
        {
            "company_name": "Google LLC",
            "job_title": "SWE",
            "bullets": ["Shipped **ranking**"],
            "project_description": "Search quality",
        }
    ]
    merged = _merge_tailored_work_experience(profile, tailored)
    assert merged[0]["company_name"] == "Google LLC"
    assert merged[0]["location"] == "London"
    assert merged[0]["bullets"] == ["Shipped **ranking**"]
    assert merged[0]["project_description"] == "Search quality"


def test_education_field_of_study_from_degree_not_default():
    rows = _build_education(
        [{"university_name": "Oxford", "degree": "BA, History", "period_start": "2014", "period_end": "2017"}],
        default_gpa="",
        default_field_of_study="Computer Engineering",
    )
    assert rows[0]["fieldOfStudy"] == "History"
    assert rows[0]["startMMYYYY"] == "01/2014"
    assert rows[0]["endMMYYYY"] == "01/2017"
