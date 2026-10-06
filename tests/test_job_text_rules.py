"""Rule-based salary, employment-type and work-mode phrase parsing on raw JD text."""

import pytest

from app.services.job_metadata_hydrator import build_metadata
from app.services.job_text_rules import (
    classify_work_mode_phrases,
    infer_employment_type,
    infer_salary_from_text,
    normalize_employment_type,
)
from app.services.work_mode_classifier import classify_work_mode_rules


@pytest.mark.parametrize(
    "text, expected",
    [
        ("The base salary range for this role is $153,000\u2014$376,000 USD.", "$153,000 - $376,000 USD"),
        ("Salary Range: $165,000 - $225,000", "$165,000 - $225,000"),
        ("Compensation: $220,000\u2013$260,000 OTE", "$220,000 - $260,000 OTE"),
        ("The pay range is $150-180K depending on level.", "$150K - $180K"),
        ("Pay: $45 - $60/hr", "$45 - $60 per hour"),
        ("Salary: USD 120,000 to 150,000 per year", "120,000 - 150,000 USD"),
        ("Annual base between \u20ac60.000 and \u20ac75.000", "\u20ac60.000 - \u20ac75.000"),
        ("Compensation: A$123,250 - $166,750", "A$123,250 - $166,750"),
        ("__Compensation for these roles generally begins at $60,000 per year.", "From $60,000"),
        ("Salary: up to $200k", "Up to $200K"),
    ],
)
def test_salary_ranges_from_text(text, expected):
    assert infer_salary_from_text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "We recently raised a $100M Series C, valuing the company at $2B.",
        "Cresta has raised more than $270 million from leading investors.",
        "One-time $200 remote work stipend and a $1,500 learning budget.",
        "Up to $1,500 per quarter 401K match to a maximum of $6,000 per calendar year.",
        "Transactions of $1M+ ARR with C-level buyers.",
        "A $400-billion industry with no dominant player.",
        "Sign-on bonus of $5,000 - $10,000 for eligible hires.",
    ],
)
def test_salary_ignores_non_pay_money(text):
    assert infer_salary_from_text(text) is None


def test_salary_prefers_range_near_pay_wording():
    text = (
        "We closed a $50,000-$90,000 customer deal last week. "
        "The base pay range for this role is $130,000 - $150,000 USD per year."
    )
    assert infer_salary_from_text(text) == "$130,000 - $150,000 USD"


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("FULL_TIME", "Full-time"),
        ("Fulltime", "Full-time"),
        ("Full", "Full-time"),
        ("Permanent/full-time", "Full-time"),
        ("Contractor", "Contract"),
        ("Parttime", "Part-time"),
        ("International Full-Time", "Full-time"),
        ("", None),
    ],
)
def test_normalize_employment_type(raw, expected):
    assert normalize_employment_type(raw) == expected


@pytest.mark.parametrize(
    "title, body, expected",
    [
        ("Social Media Manager (Contract)", "", "Contract"),
        ("Recruiter (Sales & G&A, 12 Month Contract)", "", "Contract"),
        ("Contract Manager", "This is a full-time role.", "Full-time"),
        ("Data Engineer Intern (2027)", "", "Internship"),
        ("Internal Auditor", "Full-time position.", "Full-time"),
        ("Member Support Representative", "This is a part-time position requiring approximately 29 hours.", "Part-time"),
        ("Patient Growth Specialist", "Classification: 1099 Contractor; Full-Time", "Contract"),
        ("Senior Manager, Corporate Sales - West", "benefits depending on their Fixed Term Contract and country.", None),
        ("Account Executive", "Full-time employees enjoy equity.", None),
    ],
)
def test_infer_employment_type(title, body, expected):
    assert infer_employment_type(title, body) == expected


@pytest.mark.parametrize(
    "text, expected",
    [
        ("this role follows a four day in office work model in our NYC office.", ("hybrid", True)),
        ("You will work 3 days a week in the office.", ("hybrid", True)),
        ("Expect two days per week in our London office.", ("hybrid", True)),
        ("Candidates are expected to work on a hybrid (2-3 days in-office/week) basis.", ("hybrid", True)),
        ("This is not a remote position.", ("onsite", True)),
        ("The role is based on-site in Austin.", ("onsite", True)),
        ("OtherThis role is fully remote with travel.", ("remote", True)),
        ("We are a remote-first company.", ("remote", False)),
        ("Location: Hybrid \u2013 San Francisco office", ("hybrid", False)),
        ("Join us twice a year, we meet 2 days in the office per quarter.", (None, False)),
        ("Our hybrid work model balances office and remote work.", (None, False)),
        ("This is a hybrid role - part Sales Engineering, part Product.", (None, False)),
        ("In Office Set-Up Reimbursement (In-Office Only)", (None, False)),
        ("If this role is remote, there will be in-office events. If this role is hybrid, see below.", (None, False)),
    ],
)
def test_work_mode_phrases(text, expected):
    assert classify_work_mode_phrases(text) == expected


def test_role_statement_beats_remote_location_label():
    body = "Location: Remote - US\nTo support connection, you will work 3 days a week in the office."
    assert classify_work_mode_rules(location="Remote - US", plain_text=body) == "hybrid"


def test_ats_workplace_beats_body_phrases():
    body = "You will work 3 days a week in the office."
    assert classify_work_mode_rules(workplace="remote", location="NYC", plain_text=body) == "remote"


def test_generic_hybrid_copy_does_not_beat_location():
    body = "Our hybrid work model is great. Hybrid schedule available for some teams."
    assert classify_work_mode_rules(location="Remote - US", plain_text=body) == "remote"


def test_build_metadata_fills_salary_type_and_mode_from_text():
    text = (
        "Title: Senior Data Engineer\nCompany: Acme\nLocation: Remote - US\n\n"
        "About the role\nThis is a full-time position. You will work 2 days a week in our Denver office.\n"
        "The base salary range is $140,000 - $170,000 USD."
    )
    meta = build_metadata(plain_text=text, source_url="https://boards.greenhouse.io/acme/jobs/1")
    assert meta["salary_range"] == "$140,000 - $170,000 USD"
    assert meta["employment_type"] == "Full-time"
    assert meta["work_mode"] == "hybrid"


def test_build_metadata_keeps_structured_values_and_reads_remote_yes():
    text = "Title: Designer\nCompany: Acme\nRemote: Yes\n\nAbout the role\nGreat team."
    meta = build_metadata(
        plain_text=text,
        structured_data={"employment_type": "FULL_TIME", "salary_range": "$100K - $120K"},
    )
    assert meta["employment_type"] == "Full-time"
    assert meta["salary_range"] == "$100K - $120K"
    assert meta["work_mode"] == "remote"


def test_build_metadata_drops_amountless_salary_label():
    text = "Title: Designer\nCompany: Acme\nSalary: Currency: USD\n\nAbout the role\nPay is $90,000 - $110,000 per year."
    meta = build_metadata(plain_text=text)
    assert meta["salary_range"] == "$90,000 - $110,000"
