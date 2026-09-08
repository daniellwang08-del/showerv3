from app.services.job_metadata_hydrator import (
    build_metadata,
    infer_company_from_url,
    parse_labeled_metadata,
)
from app.services.extraction_merge import pick_best_text


SAMPLE = """Title: AI Product Engineer | REMOTE
Team: Engineering
Location: Remote, Worldwide
Employment Type: Full-time
Salary: 120000 - 200000 USD per-year-salary

Distru is the #1 ERP in the Cannabis Industry with $3B in annual sales.
"""


def test_parse_labeled_metadata_distru():
    meta = parse_labeled_metadata(SAMPLE)
    assert meta["title"] == "AI Product Engineer | REMOTE"
    assert meta["location"] == "Remote, Worldwide"
    assert meta["employment_type"] == "Full-time"
    assert "120000" in meta["salary_range"]


def test_infer_company_from_lever_url():
    assert infer_company_from_url(
        "https://jobs.lever.co/distru/b7bb8662-3ede-4b41-bc98-b8ca5678f8d3"
    ) == "Distru"


def test_infer_company_from_ats_path_slug():
    """Employer lives in the path, not the subdomain, on these ATS hosts."""
    assert infer_company_from_url(
        "https://ats.rippling.com/d-wave-quantum/jobs/4a07ca18"
    ) == "D Wave Quantum"
    assert infer_company_from_url(
        "https://app.dover.com/apply/Dwellci%20AI/6428f948"
    ) == "Dwellci AI"
    assert infer_company_from_url(
        "https://app.trinethire.com/companies/33617-green-river-data-group-inc/jobs/1"
    ) == "Green River Data Group Inc"
    assert infer_company_from_url(
        "https://www.careers-page.com/code2day/job/8XYX3593"
    ) == "Code2day"


def test_infer_company_strips_www_prefix():
    assert infer_company_from_url("https://www.sentinelone.com/jobs/?gh_jid=1") == "Sentinelone"
    assert infer_company_from_url("https://www.quest-defense.com/careers/x") == "Quest Defense"
    assert infer_company_from_url("https://www.amazon.jobs/en/jobs/10526942/sde") == "Amazon"


def test_infer_company_rejects_aggregator_hosts():
    """A job board's own name must never be stored as the employer."""
    for url in (
        "https://www.dice.com/job-detail/b39ab8da",
        "https://www.indeed.com/viewjob?jk=550fe2b0",
        "https://www.ziprecruiter.com/jobs/v2/abc",
        "https://www.fetchjobs.co/job-description-usg/3153186284",
    ):
        assert infer_company_from_url(url) is None


def test_build_metadata_fills_columns():
    meta = build_metadata(
        plain_text=SAMPLE,
        source_url="https://jobs.lever.co/distru/b7bb8662-3ede-4b41-bc98-b8ca5678f8d3",
        existing_company="Unknown",
    )
    assert meta["title"] == "AI Product Engineer | REMOTE"
    assert meta["company"] == "Distru"
    assert meta["location"] == "Remote, Worldwide"
    assert meta["work_mode"] == "remote"
    assert "Cannabis" in meta["description"]


SYNITI_SAMPLE = """Senior Consultant Job Details | Syniti
Skip to main content
Life at Syniti
Careers
Explore Our Roles
Your Profile
Search by Keyword
Create Alert
Senior Consultant
Apply now
Date: Aug 28, 2026
Location:
Hyderabad, IN
Remote, IN
Bangalore, IN
Company:
Syniti
ABOUT US
Syniti part of Capgemini, tackles the hardest work in data for the world's largest organizations.
THE ROLE
The Sr. Consultant is responsible for helping our clients address some of their biggest data challenges.
"""


def test_syniti_successfactors_multiline_labels():
    meta = build_metadata(
        plain_text=SYNITI_SAMPLE,
        source_url=(
            "https://careers.syniti.com/job/Hyderabad-Senior-Consultant/1414099500/"
            "?locale=en_US"
        ),
        existing_company="Unknown",
    )
    assert meta["title"] == "Senior Consultant"
    assert meta["company"] == "Syniti"
    assert "Hyderabad" in (meta["location"] or "")
    assert meta["work_mode"] == "remote"
    assert meta["posted_date"] is not None
    assert "Capgemini" in meta["description"] or "Consultant" in meta["description"]


def test_pick_best_text_preserves_structured():
    text, method, structured = pick_best_text(
        [
            ("x" * 40, "static_html", None),
            ("y" * 200, "api_vendor", {"title": "Role"}),
        ]
    )
    assert len(text) == 200
    assert method == "api_vendor"
    assert structured == {"title": "Role"}


def test_pick_best_text_two_tuple_compat():
    text, method, structured = pick_best_text([("z" * 80, "api_json_ld")])
    assert len(text) == 80
    assert method == "api_json_ld"
    assert structured is None


# Greenhouse embed STATIC_HTML blobs — no Title:/Company: labels.
# Hydrate must NOT hardcode chrome regex; MiniLM fill runs in encode_job.
_GH_UPBOUND = (
    "Job Application for Senior Software Engineer [REMOTE] at Upbound - Job Posting"
    "Senior Software Engineer [REMOTE]San Francisco, California, United States"
    "Upbound is redefining how modern infrastructure is built for the Agentic AI Era."
)


def test_build_metadata_greenhouse_embed_uses_url_not_chrome_regex():
    meta = build_metadata(
        plain_text=_GH_UPBOUND,
        source_url=(
            "https://job-boards.greenhouse.io/embed/job_app"
            "?for=upboundext&token=5695708004&utm_source=jobright"
        ),
        existing_company="Unknown",
        existing_title=None,
    )
    # No labeled/structured title → left for MiniLM encode path.
    assert meta["title"] is None
    # Board slug from URL is a structured signal (not page-text search).
    assert meta["company"] == "Upboundext"
    assert meta["work_mode"] == "remote"


def test_build_metadata_structured_ats_beats_blob():
    meta = build_metadata(
        plain_text=_GH_UPBOUND,
        structured_data={
            "title": "Senior Software Engineer",
            "company": "Upbound",
            "workplace": "remote",
        },
        existing_company="Unknown",
    )
    assert meta["title"] == "Senior Software Engineer"
    assert meta["company"] == "Upbound"
    assert meta["work_mode"] == "remote"
