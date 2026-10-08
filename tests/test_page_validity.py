import pytest

from app.extractors.greenhouse_board_extractor import (
    greenhouse_board_tokens_from_domain,
    greenhouse_extraction_token_candidates,
)
from app.extractors.lever_api_extractor import (
    _parse_lever_url,
    _slug_variants,
    extract_lever_refs_from_html,
)
from app.extractors.smartrecruiters_api_extractor import (
    parse_smartrecruiters_url,
    posting_to_plain_text,
)
from app.services.extraction_service import _failure_message, _is_site_unreachable_error, _primary_issue
from app.services.job_url_canonical import description_url
from app.services.posting_validity import PageIssue, classify_page, non_posting_reason
from app.services.validator import validate_extracted_text

UUID = "8d2f6831-a210-46e4-a3e0-a7bb23d645fb"

JD = (
    "Senior Data Engineer\nRemote, United States\n"
    "About the role\nWe are hiring a senior data engineer to build our lakehouse platform "
    "and own ingestion pipelines end to end across batch and streaming workloads.\n"
    "Responsibilities\n- Design and operate Spark and Kafka pipelines for analytics teams.\n"
    "- Partner with analytics engineering on dbt models and data contracts.\n"
    "- Improve reliability, observability and cost of the data platform over time.\n"
    "Requirements\n- 5+ years of data engineering experience in production systems.\n"
    "- Strong Python and SQL, plus hands-on AWS experience with Glue and S3.\n"
    "- Experience with Airflow or a similar orchestrator in a team setting.\n"
    "Benefits\nHealth, dental, 401k, flexible PTO and a home office stipend for everyone.\n"
)


# Wording copied from production pages that had been stored as job descriptions.
@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("Just a moment... Performing security verification. This website uses a security service.", "blocked"),
        ("You have been blocked\nAccess is temporarily restricted. We detected unusual activity.", "blocked"),
        ("Human Verification\nPlease solve a puzzle to continue.", "blocked"),
        ("hCaptcha\nPlease try again.\nVerify\nAfrikaans Albanian Amharic", "blocked"),
        ("example.com is parked free, courtesy of GoDaddy. Content is blocked.", "blocked"),
        ("We're sorry. Something went wrong. Please refresh the page.", "error_page"),
        ("Failed to load environment", "error_page"),
        ("Job not found\nThe job you requested was not found.", "not_found"),
        ("Search\nThe page you are looking for doesn't exist.\nSearch for Jobs", "not_found"),
        ("Careers\nWe are not currently accepting applications for this position.", "closed"),
        ("Sorry, the job you are trying to apply for has been filled. Explore similar jobs.", "closed"),
        ("Software Engineer\nThis posting is no longer available. View other open jobs.", "closed"),
        ("Sr Software Engineer\nAPPLICATIONS CLOSED\nThis role is no longer accepting applications.", "closed"),
        ("Application form\nThis form is no longer accepting responses.", "closed"),
        ("Sign In | Indeed Accounts\nCreate an account or sign in", "login_wall"),
        ("Login to your account\nEmail\nPassword\nForgot password?", "login_wall"),
        ("{{position.name}} {{company.name}} {{position.department}} {{position.location}}", "unrendered"),
        ("Software Engineer Remote View Job Description Share This Job Loading...", "unrendered"),
        ("Acme Jobs\nThanks for checking out our job openings. See something that interests you?", "careers_index"),
        ("Acme Jobs\nOpen Positions (8)\nEngineering\nBackend Engineer\nFrontend Engineer", "careers_index"),
        (
            "Flex - Senior Engineer\nSubmit your application\nResume/CV\nFull name\nEmail\nPhone\n"
            "Current location\nCurrent company\nLinkedIn URL",
            "apply_form",
        ),
        ("Senior AI Engineer", "too_thin"),
    ],
)
def test_classify_page_flags_non_postings(text, reason):
    issue = classify_page(text)
    assert issue is not None and issue.reason == reason


def test_real_posting_survives_chrome_noise():
    page = (
        "Acme Careers\nSign in\nOpen Positions\nSearch Jobs\n" + JD
        + "\nSomething went wrong? Contact support.\nAccess denied for some regions."
    )
    assert classify_page(page) is None
    assert validate_extracted_text(page).is_valid


def test_fused_headings_still_count_as_a_description():
    fused = (
        "GTM Engineer - Careers Page Thanks for visiting our Career Page. Please review our open positions. "
        "About The RoleWe're looking for a GTM Engineer to join our Revenue Operations team. " * 3
        + "Key ResponsibilitiesBuild GTM automation and workflows across the stack. " * 4
        + "Resume First name Email Phone"
    )
    assert classify_page(fused) is None


def test_closed_banner_beats_the_old_description_below_it():
    page = "Senior Data Engineer\nThis position has been filled.\n" + JD
    assert classify_page(page).reason == "closed"


def test_phenom_filled_template_is_weak():
    template = "We're sorry... the job you are trying to apply for has been filled.\n"
    assert classify_page(template + JD) is None
    issue = classify_page(template + "Maybe you would like to consider the Categories below")
    assert issue.reason == "closed" and issue.weak


def test_phenom_embedded_record():
    import json

    from app.extractors.embedded_job_data_extractor import parse_embedded_job

    ddo = {"jobDetail": {"status": 200, "data": {"job": {
        "title": "Senior Java Developer",
        "companyName": "Conduent",
        "multi_location": ["Remote US, United States"],
        "type": "Full time",
        "category": "Information Technology",
        "postedDate": "2026-10-05T00:00:27.000+0000",
        "description": "<p>Build PBM services.</p><ul><li>Java 17</li><li>Spring Boot</li></ul>" * 10,
    }}}}
    html = (
        "<html><body><h2>the job you are trying to apply for has been filled.</h2>"
        f"<script>phApp.ddo = {json.dumps(ddo)}; phApp.experimentData = {{}};</script></body></html>"
    )
    source, fields, description = parse_embedded_job(html)
    assert source == "phenom"
    assert fields["title"] == "Senior Java Developer"
    assert "company" not in fields
    assert fields["location"] == "Remote US, United States"
    assert fields["workplace"] == "remote"
    assert fields["posted_date"] == "2026-10-05"
    assert "Spring Boot" in description and "filled" not in description


def test_terse_structured_vendor_text_is_kept():
    text = (
        "Title: Vibe Coder\nDescription: Join Adaptify SEO as a Vibe Coder. Get excited about code, "
        "love learning new things, and dive deep into AI-powered products. Remote position.\n"
        "Company: Adaptify SEO\nLocation Type: TELECOMMUTE"
    )
    assert classify_page(text) is None


def test_non_posting_reason_matches_classifier():
    assert non_posting_reason(JD) is None
    assert non_posting_reason("Just a moment... Performing security verification") == "blocked"
    assert non_posting_reason("") is None


def test_validator_reports_issue():
    result = validate_extracted_text("We're sorry. Something went wrong. Please refresh the page.")
    assert not result.is_valid
    assert result.issue.reason == "error_page"


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (f"https://jobs.lever.co/Flex/{UUID}/apply?jr_id=1", f"https://jobs.lever.co/Flex/{UUID}?jr_id=1"),
        (
            f"https://jobs.ashbyhq.com/acme/{UUID}/application",
            f"https://jobs.ashbyhq.com/acme/{UUID}",
        ),
        (
            "https://pae.wd1.myworkdayjobs.com/amentum_careers/job/US-Remote/Software-Engineer-II_R0171825/apply/applyManually",
            "https://pae.wd1.myworkdayjobs.com/amentum_careers/job/US-Remote/Software-Engineer-II_R0171825",
        ),
        (
            f"https://jobs.smartrecruiters.com/oneclick-ui/company/Mirantis/publication/{UUID}?dcr_ci=Mirantis",
            f"https://jobs.smartrecruiters.com/Mirantis/{UUID}",
        ),
        (
            f"https://nexusmods.careers.hibob.com/jobs/{UUID}/apply",
            f"https://nexusmods.careers.hibob.com/jobs/{UUID}",
        ),
        (
            "https://builtin.com/apply/job/staff-machine-learning-engineer/11480863",
            "https://builtin.com/job/staff-machine-learning-engineer/11480863",
        ),
        (
            "https://careers-acme.icims.com/jobs/6847/senior-software-engineer/login?mobile=false&width=1200",
            "https://careers-acme.icims.com/jobs/6847/senior-software-engineer/job?width=1200&in_iframe=1",
        ),
        (
            "https://careers-acme.icims.com/jobs/3801/full-stack-developer/job",
            "https://careers-acme.icims.com/jobs/3801/full-stack-developer/job?in_iframe=1",
        ),
        (
            "https://applicants.bairesdev.com/job/3/301997/apply?utm_source=x",
            "https://applicants.bairesdev.com/job/3/301997?utm_source=x",
        ),
        # Unchanged: posting pages, and hosts whose apply path is the posting.
        (f"https://jobs.lever.co/Flex/{UUID}", f"https://jobs.lever.co/Flex/{UUID}"),
        (
            "https://gracehill.applytojob.com/apply/BaT4qL9q2T/GTM-Engineer",
            "https://gracehill.applytojob.com/apply/BaT4qL9q2T/GTM-Engineer",
        ),
        ("https://www.akurey.com/careers/apply?pId=307", "https://www.akurey.com/careers/apply?pId=307"),
        ("", ""),
    ],
)
def test_description_url(url, expected):
    assert description_url(url) == expected


def test_lever_keeps_slug_case_and_region():
    assert _parse_lever_url(f"https://jobs.lever.co/Flex/{UUID}/apply") == ("Flex", UUID, False)
    assert _parse_lever_url(f"https://jobs.eu.lever.co/olx/{UUID}") == ("olx", UUID, True)
    assert _slug_variants("Flex") == ["Flex", "flex"]
    assert _slug_variants("olx") == ["olx"]
    html = f'<iframe src="https://jobs.eu.lever.co/Acme/{UUID}"></iframe>'
    assert extract_lever_refs_from_html(html) == [("Acme", UUID, True)]


def test_smartrecruiters_url_parsing():
    assert parse_smartrecruiters_url(
        f"https://jobs.smartrecruiters.com/oneclick-ui/company/EVB/publication/{UUID}"
    ) == ("EVB", UUID)
    assert parse_smartrecruiters_url(
        "https://jobs.smartrecruiters.com/NielsenIQ/744000082139745-senior-engineer"
    ) == ("NielsenIQ", "744000082139745")
    assert parse_smartrecruiters_url(f"https://jobs.smartrecruiters.com/Mirantis/{UUID}") == ("Mirantis", UUID)
    assert parse_smartrecruiters_url("https://jobs.smartrecruiters.com/Mirantis") is None
    assert parse_smartrecruiters_url("https://example.com/Mirantis/123456789") is None


def test_smartrecruiters_posting_text():
    text = posting_to_plain_text({
        "name": "Senior Python Engineer",
        "company": {"name": "Mirantis"},
        "location": {"city": "Austin", "country": "us", "remote": True},
        "typeOfEmployment": {"label": "Full-time"},
        "jobAd": {"sections": {
            "jobDescription": {"title": "Job Description", "text": "<p>Build <b>Kubernetes</b> tooling.</p>"},
            "qualifications": {"title": "Qualifications", "text": "<ul><li>5+ years Python</li></ul>"},
        }},
    })
    assert text.startswith("Title: Senior Python Engineer\nCompany: Mirantis\nLocation: Austin, us")
    assert "Workplace Type: remote" in text
    assert "Job Description:\nBuild Kubernetes tooling." in text
    assert "Qualifications:\n5+ years Python" in text


def test_greenhouse_domain_token_guess():
    assert greenhouse_board_tokens_from_domain("https://voxel51.com/jd?4740290005&gh_jid=4740290005") == ["voxel51"]
    assert greenhouse_board_tokens_from_domain("https://careers.acme-labs.io/job?gh_jid=1") == ["acme-labs", "acmelabs"]
    assert greenhouse_board_tokens_from_domain("https://voxel51.com/jobs/123") == []
    html = '<script src="https://boards.greenhouse.io/embed/job_board/js?for=voxel"></script>'
    assert greenhouse_extraction_token_candidates(
        "https://www.voxel51.com/jd?gh_jid=1", html
    ) == ["voxel", "voxel51"]


PHENOM_CHROME = (
    "Full Stack Engineer III in Phoenix, Arizona | Information Technology at Republic Services\n"
    "Skip to main content\nAll Careers\nCorporate\nOperations\nBenefits\nVeterans\nEvents\n"
    "View All Jobs\nSaved jobs(0)\n5353 East City North Drive, Phoenix, AZ 85054\nfollow us\n"
    "Copyright 2026 Republic Services, Inc.\nCareers\nTerms of Use\n"
    "This website uses cookies, pixels and similar tracking technologies through which we and "
    "certain third parties may collect information about you to enhance your experience.\n"
) * 2


def test_navigation_only_page_is_too_thin():
    issue = classify_page(PHENOM_CHROME)
    assert issue is not None and issue.reason == "too_thin"


def test_breezy_template_tokens_are_dropped():
    from app.services.job_content_cleaner import plain_text_from_document_html

    text = plain_text_from_document_html(
        "<html><body><h1>Web Engineer</h1><p>%LABEL_POSITION_TYPE_FULL_TIME% Brazil</p></body></html>"
    )
    assert "%" not in text and "Brazil" in text


@pytest.mark.asyncio
async def test_closed_notice_beats_a_chrome_only_render(monkeypatch):
    import contextlib

    import app.services.extraction_service as es
    from app.extractors.base import ExtractionResult
    from app.models.schemas import ExtractionMethod

    class Repo:
        def __init__(self, *_a):
            pass

        def __getattr__(self, _name):
            async def noop(*_a, **_k):
                return None
            return noop

    @contextlib.asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(es, "get_session", session)
    monkeypatch.setattr(es, "JobExtractionRepository", Repo)

    service = es.ExtractionService()
    filled = "<html><body><p>Sorry, the job you are trying to apply for has been filled.</p></body></html>"

    async def fetch(_url):
        return filled, 200, {}

    async def can_extract(_url, _html=None):
        return True

    async def browser(_url, _html=None):
        return ExtractionResult(
            success=True, method=ExtractionMethod.BROWSER_RENDER, raw_content=PHENOM_CHROME,
        )

    async def no_fallback(*_a):
        return None

    async def failed(_job_id, error):
        return {"status": "failed", "error": error}

    async def cached(*_a, **_k):
        return {"status": "extracted"}

    monkeypatch.setattr(service, "_cache_and_mark_extracted", cached)
    monkeypatch.setattr(service.http_service, "fetch", fetch)
    monkeypatch.setattr(service.browser_extractor, "can_extract", can_extract)
    monkeypatch.setattr(service.browser_extractor, "extract", browser)
    monkeypatch.setattr(service, "_try_scraped_description_fallback", no_fallback)
    monkeypatch.setattr(service, "_mark_failed", failed)

    result = await service.process_job("x", "https://jobs.example.com/us/en/job/R1/Full-Stack-Engineer")
    assert result["status"] == "failed"
    assert result["error"].startswith("Posting closed:")


def test_gone_signal_precedence():
    from app.services.extraction_service import _gone_overrides

    closed = PageIssue("closed", "has been filled")
    browser = [(JD, "browser_render", None)]
    vendor = [(JD, "api_vendor", None)]
    assert _gone_overrides(JD, browser, closed, None)
    assert not _gone_overrides(JD, browser, PageIssue("closed", "x", weak=True), None)
    assert not _gone_overrides(JD, vendor, closed, None)
    assert not _gone_overrides(JD, browser, None, "lever_api")
    assert _gone_overrides(PHENOM_CHROME, [(PHENOM_CHROME, "browser_render", None)], None, "lever_api")
    assert not _gone_overrides(JD, browser, PageIssue("blocked", "x"), None)


def test_failure_messages_and_priority():
    blocked = PageIssue("blocked", "Just a moment...")
    closed = PageIssue("closed", "has been filled")
    assert _primary_issue([blocked, closed]) is closed
    assert _primary_issue([]) is None

    closed_msg = _failure_message(closed, None, None)
    assert closed_msg.startswith("Posting closed: the posting has been closed or filled")
    assert _failure_message(None, "lever_api", "HTTP error 404") == (
        "Posting removed: Lever no longer publishes this posting"
    )
    blocked_msg = _failure_message(blocked, None, None)
    assert blocked_msg.startswith("Blocked by bot protection")
    assert _is_site_unreachable_error(blocked_msg)
    assert _failure_message(PageIssue("apply_form", "resume"), None, None).startswith("Not a job description:")
    assert _failure_message(None, None, "timeout") == "All extraction methods failed: timeout"
