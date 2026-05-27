"""Tests for cover letter template validation."""

from __future__ import annotations

import tempfile
from pathlib import Path

from docx import Document

from app.services.cover_letter_template_service import (
    REQUIRED_BODY_TAG,
    build_cover_letter_tag_map,
    validate_cover_letter_template_docx,
)


def _write_docx(path: Path, paragraphs: list[str]) -> None:
    doc = Document()
    for text in paragraphs:
        doc.add_paragraph(text)
    doc.save(str(path))


def test_validate_requires_cover_letter_body_tag():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cl.docx"
        _write_docx(path, ["Dear Hiring Manager,", "{{FULL_NAME}}"])
        errors, _warnings, detected = validate_cover_letter_template_docx(path)
        assert any(REQUIRED_BODY_TAG in e for e in errors)
        assert "{{FULL_NAME}}" in detected


def test_validate_passes_with_body_tag():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cl.docx"
        _write_docx(path, ["{{DATE}}", "Dear Hiring Manager,", REQUIRED_BODY_TAG])
        errors, warnings, detected = validate_cover_letter_template_docx(path)
        assert not errors
        assert REQUIRED_BODY_TAG in detected
        assert isinstance(warnings, list)


def test_build_cover_letter_tag_map_includes_profile_and_job():
    context = {
        "profile": {"full_name": "Jane Doe", "email": "jane@example.com", "title": "Engineer"},
        "job": {"company": "Acme Corp", "title": "Staff Engineer", "location": "Remote"},
    }
    tags = build_cover_letter_tag_map(context)
    assert tags["{{FULL_NAME}}"] == "Jane Doe"
    assert tags["{{JOB_COMPANY}}"] == "Acme Corp"
    assert tags["{{profile.full_name}}"] == "Jane Doe"
    assert tags["{{job.title}}"] == "Staff Engineer"
    assert tags["{{DATE}}"]
