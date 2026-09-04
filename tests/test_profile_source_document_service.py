"""Tests for source document structured normalization and Markdown extraction."""

import pytest

from app.services.profile_source_document_service import (
    UNSUPPORTED_SOURCE_TYPE_MSG,
    _normalize_structured,
    detect_source_document_kind,
    extract_document_text,
    markdown_to_plain_text,
)
from app.services.resume_parse_service import detect_resume_kind


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


MD_BODY = """# Acme Platform

Company: Acme Inc

## Payments API
- Built FastAPI services
- Reduced p95 latency 40%
"""


def test_detect_markdown_by_md_and_markdown_extension():
    raw = MD_BODY.encode("utf-8")
    assert detect_source_document_kind(raw, "projects.md") == "markdown"
    assert detect_source_document_kind(raw, r"C:\docs\Acme.MARKDOWN") == "markdown"
    assert detect_source_document_kind(raw, "folder/writeup.md") == "markdown"
    assert detect_source_document_kind(raw, "blob", content_type="text/markdown") == "markdown"


def test_detect_prefers_pdf_magic_over_md_extension():
    assert detect_source_document_kind(b"%PDF-1.4 fake", "projects.md") == "pdf"


def test_detect_rejects_txt_and_non_pdf_named_pdf():
    with pytest.raises(ValueError, match="Unsupported file type"):
        detect_source_document_kind(b"hello", "notes.txt")
    with pytest.raises(ValueError, match="Unsupported file type"):
        detect_source_document_kind(b"hello", "notes.txt", content_type="text/markdown")
    with pytest.raises(ValueError, match="does not look like a valid PDF"):
        detect_source_document_kind(b"not-a-pdf", "projects.pdf")


def test_resume_import_still_rejects_markdown():
    with pytest.raises(ValueError, match="PDF or DOCX"):
        detect_resume_kind(MD_BODY.encode("utf-8"), "resume.md")


def test_markdown_to_plain_text_utf8_bom_and_newlines():
    raw = b"\xef\xbb\xbf# Title\r\n\rline two"
    assert markdown_to_plain_text(raw) == "# Title\n\nline two"


def test_markdown_to_plain_text_utf16():
    raw = "# Heading\n- bullet".encode("utf-16")
    assert "# Heading" in markdown_to_plain_text(raw)
    assert "bullet" in markdown_to_plain_text(raw)


def test_markdown_to_plain_text_rejects_binary():
    with pytest.raises(ValueError, match="binary"):
        markdown_to_plain_text(b"PK\x03\x04\x00\x00not-markdown")


def test_extract_document_text_markdown():
    text, kind, warnings = extract_document_text(
        raw=MD_BODY.encode("utf-8"),
        filename="acme-projects.md",
    )
    assert kind == "markdown"
    assert "Payments API" in text
    assert "FastAPI" in text
    assert warnings == []


def test_extract_document_text_empty_markdown():
    with pytest.raises(ValueError, match="No text found in Markdown"):
        extract_document_text(raw=b"   \n  ", filename="empty.md")


def test_extract_document_text_unsupported():
    with pytest.raises(ValueError, match="Markdown"):
        extract_document_text(raw=b"hello", filename="notes.txt")
    assert "PDF, DOCX, or Markdown" in UNSUPPORTED_SOURCE_TYPE_MSG
