"""Tests for source document structured normalization."""

from app.services.profile_source_document_service import _normalize_structured


def test_normalize_structured_projects():
    data = {
        "company_name": "Acme Inc",
        "projects": [
            {
                "name": "Platform",
                "summary": "Core platform work",
                "technologies": ["Python", "AWS"],
                "responsibilities": ["Led backend team"],
                "metrics": ["99.9% uptime"],
                "outcomes": ["Reduced cost"],
            },
            {"name": "", "summary": "", "responsibilities": []},
        ],
    }
    structured = _normalize_structured(data)
    assert structured.company_name == "Acme Inc"
    assert len(structured.projects) == 1
    assert structured.projects[0].name == "Platform"
    assert "Python" in structured.projects[0].technologies
