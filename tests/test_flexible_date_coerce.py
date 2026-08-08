"""Tests for flexible date coercion (résumé import certificate dates)."""

from app.services.resume_parse_service import _normalize_draft
from app.utils.flexible_date import coerce_flexible_date, parse_flexible_date


def test_coerce_month_year_resume_wording():
    assert coerce_flexible_date("Aug 2023") == "2023-08"
    assert coerce_flexible_date("Nov 2021") == "2021-11"
    assert coerce_flexible_date("August 2023") == "2023-08"
    assert coerce_flexible_date("November 2021") == "2021-11"


def test_coerce_issued_expired_line_prefers_issue_date():
    # Matches the Databricks cert line from the failing résumé.
    assert (
        coerce_flexible_date("Issued Aug 2023 Expired Aug 2025") == "2023-08"
    )
    assert coerce_flexible_date("Issued Nov 2021") == "2021-11"


def test_coerce_canonical_passthrough():
    assert coerce_flexible_date("2023-08") == "2023-08"
    assert coerce_flexible_date("2021") == "2021"
    assert coerce_flexible_date("2023-08-15") == "2023-08-15"


def test_coerce_numeric_and_empty():
    assert coerce_flexible_date("08/2023") == "2023-08"
    assert coerce_flexible_date("2023-08") == "2023-08"
    assert coerce_flexible_date("") is None
    assert coerce_flexible_date(None) is None
    assert coerce_flexible_date("Present") is None
    assert coerce_flexible_date("not a date") is None


def test_coerced_values_pass_parse_flexible_date():
    for raw in ("Aug 2023", "Issued Nov 2021", "Issued Aug 2023 Expired Aug 2025"):
        out = coerce_flexible_date(raw)
        assert out is not None
        assert parse_flexible_date(out) is not None


def test_normalize_draft_coerces_certificate_issued_at():
    draft = _normalize_draft(
        {
            "certificates": [
                {
                    "name": "Generative AI Fundamentals",
                    "issued_at": "Aug 2023",
                    "url": None,
                },
                {
                    "name": "Google Project Management",
                    "issued_at": "Issued Nov 2021",
                    "url": None,
                },
                {
                    "name": "Other",
                    "issued_at": "Issued Aug 2023 Expired Aug 2025",
                    "url": None,
                },
            ]
        }
    )
    assert draft.certificates[0].issued_at == "2023-08"
    assert draft.certificates[1].issued_at == "2021-11"
    assert draft.certificates[2].issued_at == "2023-08"
    for c in draft.certificates:
        assert parse_flexible_date(c.issued_at) is not None
