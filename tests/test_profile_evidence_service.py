"""Tests for profile evidence formatting and document matching."""

from types import SimpleNamespace

from app.models.database import ProfileSourceDocument
from app.services.profile_evidence_service import (
    format_evidence_pack,
    match_documents_to_companies,
    profile_company_names,
    structured_doc_to_text,
)


def _doc(
    *,
    company_name: str | None,
    filename: str = "projects.docx",
    structured: dict | None = None,
    text: str | None = None,
) -> ProfileSourceDocument:
    return ProfileSourceDocument(
        id="doc-1",
        user_id="user-1",
        filename=filename,
        source_kind="docx",
        company_name=company_name,
        extracted_text=text,
        structured_data=structured,
        char_count=len(text or ""),
        project_count=len((structured or {}).get("projects") or []),
        parse_status="completed",
    )


def test_profile_company_names_from_user():
    user = SimpleNamespace(
        work_experience=[
            {"company_name": "Acme Corp", "job_title": "Engineer"},
            {"company_name": "Beta LLC", "job_title": "Lead"},
        ]
    )
    assert profile_company_names(user) == ["Acme Corp", "Beta LLC"]


def test_match_documents_to_companies():
    docs = [
        _doc(company_name="Acme Corporation", structured={"company_name": "Acme Corporation", "projects": []}),
        _doc(company_name="Unknown Co", structured={"company_name": "Unknown Co", "projects": []}),
    ]
    mapping = match_documents_to_companies(docs, ["Acme Corp", "Beta LLC"])
    assert len(mapping["Acme Corp"]) == 1
    assert mapping["Beta LLC"] == []


def test_structured_doc_to_text():
    doc = _doc(
        company_name="Acme",
        structured={
            "company_name": "Acme",
            "projects": [
                {
                    "name": "Payments",
                    "summary": "Built payment platform",
                    "technologies": ["Java", "Kafka"],
                    "metrics": ["40% latency reduction"],
                }
            ],
        },
    )
    text = structured_doc_to_text(doc)
    assert "Payments" in text
    assert "Kafka" in text
    assert "40% latency reduction" in text


def test_format_evidence_pack():
    packed = format_evidence_pack(
        [
            {
                "company_name": "Acme Corp",
                "relevant_projects": ["Payments"],
                "evidence_bullets": ["Led Kafka pipeline processing 2M events/day."],
                "technologies_to_emphasize": ["Java", "Kafka"],
            }
        ]
    )
    assert "Acme Corp" in packed
    assert "Kafka pipeline" in packed
    assert "Java" in packed


def test_format_evidence_pack_empty():
    assert format_evidence_pack([]) == "No project source evidence available."
