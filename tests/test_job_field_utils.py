import pytest

from app.services.job_field_utils import (
    clean_optional_job_field,
    infer_title_from_description,
    parse_job_title,
    repair_stored_job_title,
    resolve_job_display_title,
)


class TestCleanOptionalJobField:
    def test_none_value(self):
        assert clean_optional_job_field(None) is None

    def test_string_none_is_placeholder(self):
        assert clean_optional_job_field("None") is None
        assert clean_optional_job_field(" none ") is None

    def test_valid_title_preserved(self):
        assert clean_optional_job_field("Senior Android Engineer, Growth") == (
            "Senior Android Engineer, Growth"
        )


class TestParseJobTitle:
    def test_null_title_does_not_become_literal_none(self):
        assert parse_job_title(None) == "Unknown Position"

    def test_missing_title_defaults(self):
        assert parse_job_title("") == "Unknown Position"

    def test_string_none_defaults(self):
        assert parse_job_title("None") == "Unknown Position"

    def test_valid_title(self):
        assert parse_job_title("Backend Engineer") == "Backend Engineer"


class TestInferTitleFromDescription:
    def test_first_line_used_when_reasonable(self):
        description = "Staff Software Engineer\n\nBuild platform services."
        assert infer_title_from_description(description) == "Staff Software Engineer"

    def test_skips_section_headers(self):
        description = "Job Description\n\nWe are hiring."
        assert infer_title_from_description(description) is None


class TestResolveJobDisplayTitle:
    def test_prefers_job_title(self):
        assert resolve_job_display_title(
            job_title="Platform Engineer",
            extraction_title="Other Title",
        ) == "Platform Engineer"

    def test_ignores_literal_none_in_job_title(self):
        assert resolve_job_display_title(
            job_title="None",
            extraction_title="Data Engineer",
        ) == "Data Engineer"

    def test_falls_back_to_description(self):
        assert resolve_job_display_title(
            job_title="None",
            description="Machine Learning Engineer\n\nAbout the role",
        ) == "Machine Learning Engineer"


class TestRepairStoredJobTitle:
    def test_replaces_literal_none_with_inferred_title(self):
        assert repair_stored_job_title(
            current_title="None",
            description="Principal Product Manager\n\nLead product strategy.",
        ) == "Principal Product Manager"

    def test_keeps_valid_title(self):
        assert repair_stored_job_title(
            current_title="Staff Engineer",
            description="Other line",
        ) == "Staff Engineer"


class TestReportedBugEvidence:
    def test_old_parser_produced_literal_none_string(self):
        parsed = {"title": None, "description": "Senior Backend Engineer\n\nBuild APIs."}
        old_title = str(parsed.get("title", "")).strip() or "Unknown Position"
        assert old_title == "None"

    def test_new_parser_never_produces_literal_none(self):
        parsed = {"title": None, "description": "Senior Backend Engineer\n\nBuild APIs."}
        assert parse_job_title(parsed.get("title")) == "Unknown Position"
        assert parse_job_title(parsed.get("title")) != "None"

    def test_low_match_api_resolution_matches_ui_expectation(self):
        parsed = {"title": None, "description": "Senior Backend Engineer\n\nBuild APIs."}
        corrupted_db_title = str(parsed.get("title", "")).strip() or "Unknown Position"
        resolved = resolve_job_display_title(
            job_title=corrupted_db_title,
            extraction_title=corrupted_db_title,
            description=parsed["description"],
        )
        assert resolved == "Senior Backend Engineer"
        assert resolved != "None"

    def test_frontend_filter_rejects_none_string(self):
        raw_title = "None"
        title = (
            raw_title
            if raw_title and not __import__("re").match(r"^(none|null|unknown position)$", raw_title.strip(), __import__("re").I)
            else None
        )
        assert title is None
