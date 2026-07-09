"""Tests for LinkedIn job URL detection."""

from app.services.linkedin_job_filter import is_linkedin_job_url, linkedin_job_block_reason


def test_detects_linkedin_job_view_url():
    assert is_linkedin_job_url("https://www.linkedin.com/jobs/view/1234567890")
    assert is_linkedin_job_url("https://linkedin.com/jobs/collections/recommended/")


def test_ignores_linkedin_profile_urls():
    assert not is_linkedin_job_url("https://www.linkedin.com/in/jane-doe")
    assert not is_linkedin_job_url("https://linkedin.com/in/jane-doe/")


def test_ignores_non_linkedin_urls():
    assert not is_linkedin_job_url("https://boards.greenhouse.io/acme/jobs/123")
    assert not is_linkedin_job_url(None)
    assert not is_linkedin_job_url("")


def test_block_reason_only_for_job_postings():
    assert linkedin_job_block_reason("https://www.linkedin.com/jobs/view/1")
    assert linkedin_job_block_reason("https://www.linkedin.com/in/me") is None
