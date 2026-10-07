"""Regressions from a JobDiva posting stored as ``Engineer - Senior`` at ``Www1``."""

from app.extractors.api_detector import APIDetectorExtractor
from app.services.job_content_cleaner import plain_text_from_document_html
from app.services.job_metadata_hydrator import infer_company_from_url
from app.services.metadata_vector_extractor import _whole_line_for

JOBDIVA_HTML = """<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "description": "<div>
<h1>Full Stack Generative AI Engineer - Senior</h1>
<p>Our client is seeking an engineer.</p></div>",
  "hiringOrganization": {"@type": "Organization", "name": "JSR Tech Consulting"},
  "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress", "addressCountry": "US", "addressLocality": ""}},
  "employmentType": ["CONTRACTOR"],
  "title": "Full Stack Generative AI Engineer - Senior"
}
</script></head><body><div id="root"></div></body></html>"""


def test_json_ld_with_raw_newlines_in_strings_is_parsed():
    ext = APIDetectorExtractor()
    data = ext._find_json_ld(JOBDIVA_HTML)
    assert data is not None
    fields = ext._structured_fields(data)
    assert fields["title"] == "Full Stack Generative AI Engineer - Senior"
    assert fields["company"] == "JSR Tech Consulting"
    assert fields["location"] == "US"


def test_cleaner_keeps_text_that_follows_a_removed_icon():
    html = (
        "<html><body><div class='chips'>"
        "<span><svg><path d='M0'/></svg>Remote</span>"
        "<span><svg><path d='M0'/></svg>Contract</span>"
        "</div><p>Body <button>Apply</button> after button.</p></body></html>"
    )
    text = plain_text_from_document_html(html)
    assert "Remote" in text
    assert "Contract" in text
    assert "after button." in text
    assert "Apply" not in text


def test_json_ld_location_line_drops_the_address_part_label():
    from app.services.job_location_parse import infer_location_from_text

    text = "Company: JSR Tech Consulting\nLocation:\nCountry: US\nTitle: Engineer\n"
    assert infer_location_from_text(text) == "US"


def test_numbered_www_prefix_and_jobdiva_host_are_not_employers():
    assert infer_company_from_url("https://www1.jobdiva.com/portal/?a=x&jobid=1") is None
    assert infer_company_from_url("https://www2.acme.com/careers/123") == "Acme"
    assert infer_company_from_url("https://www.acme.com/careers/123") == "Acme"


def test_window_pick_upgrades_to_the_full_title_line():
    text = (
        "Candidate Portal\n"
        "Full Stack Generative AI Engineer - Senior#26-00199\n"
        "Job Description\n"
        "Full Stack Generative AI Engineer - Senior\n"
        "Our client is seeking a Senior Full Stack Generative AI Engineer to join the team.\n"
    )
    scores = [
        (0.4421, 0.7082, 0.2661, 0, "Engineer - Senior"),
        (0.3953, 0.5812, 0.1859, 1, "Senior Full Stack"),
        (0.3197, 0.4812, 0.1615, 2, "Full Stack Generative AI Engineer - Senior"),
        (0.2425, 0.4037, 0.1612, 3, "Full Stack Generative AI Engineer - Senior#26-00199"),
    ]
    picked = _whole_line_for("Engineer - Senior", text, scores)
    assert picked is not None and picked[3] == "Full Stack Generative AI Engineer - Senior"


def test_whole_line_upgrade_skips_sentences_and_exact_lines():
    text = "Senior Engineer\nWe need a Senior Engineer who ships.\n"
    scores = [
        (0.40, 0.60, 0.20, 0, "Senior Engineer"),
        (0.30, 0.50, 0.20, 1, "We need a Senior Engineer who ships."),
    ]
    assert _whole_line_for("Senior Engineer", text, scores) is None
    sentence_only = "Apply now\nWe need a Senior Engineer who ships.\n"
    assert _whole_line_for("Senior Engineer", sentence_only, scores) is None
