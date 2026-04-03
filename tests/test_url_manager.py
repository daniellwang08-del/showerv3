import pytest
from app.services.url_manager import URLManager


class TestURLValidation:
    def test_valid_https_url(self):
        is_valid, error = URLManager.validate_url("https://example.com/jobs/123")
        assert is_valid is True
        assert error is None

    def test_valid_http_url(self):
        is_valid, error = URLManager.validate_url("http://example.com/jobs/123")
        assert is_valid is True
        assert error is None

    def test_invalid_scheme(self):
        is_valid, error = URLManager.validate_url("ftp://example.com/jobs")
        assert is_valid is False
        assert "scheme" in error.lower()

    def test_missing_domain(self):
        is_valid, error = URLManager.validate_url("https:///jobs/123")
        assert is_valid is False


class TestDomainExtraction:
    def test_simple_domain(self):
        domain = URLManager.extract_domain("https://example.com/jobs/123")
        assert domain == "example.com"

    def test_subdomain(self):
        domain = URLManager.extract_domain("https://careers.example.com/jobs/123")
        assert domain == "careers.example.com"

    def test_www_removed(self):
        domain = URLManager.extract_domain("https://www.example.com/jobs/123")
        assert domain == "example.com"


class TestJobBoardDetection:
    def test_greenhouse_detection(self):
        url = "https://boards.greenhouse.io/company/jobs/12345"
        board, job_id = URLManager.detect_job_board(url)
        assert board == "greenhouse.io"
        assert job_id == "12345"

    def test_lever_detection(self):
        url = "https://jobs.lever.co/company/abc123-def456"
        board, job_id = URLManager.detect_job_board(url)
        assert board == "lever.co"
        assert job_id == "abc123-def456"

    def test_unknown_board(self):
        url = "https://example.com/careers/job/123"
        board, job_id = URLManager.detect_job_board(url)
        assert board is None

    def test_ashby_detection(self):
        base = "https://jobs.ashbyhq.com/astera/53c455a3-8e24-4908-a77d-b61532756af9"
        application = "https://jobs.ashbyhq.com/astera/53c455a3-8e24-4908-a77d-b61532756af9/application"
        board, job_id = URLManager.detect_job_board(base)
        assert board == "ashbyhq.com"
        assert job_id == "53c455a3-8e24-4908-a77d-b61532756af9"

        board2, job_id2 = URLManager.detect_job_board(application)
        assert board2 == "ashbyhq.com"
        assert job_id2 == "53c455a3-8e24-4908-a77d-b61532756af9"


class TestJobURLDetection:
    def test_job_url_patterns(self):
        assert URLManager.is_job_url("https://example.com/jobs/123") is True
        assert URLManager.is_job_url("https://example.com/careers/position/456") is True
        assert URLManager.is_job_url("https://example.com/apply/789") is True

    def test_non_job_url(self):
        assert URLManager.is_job_url("https://example.com/about") is False
        assert URLManager.is_job_url("https://example.com/contact") is False
