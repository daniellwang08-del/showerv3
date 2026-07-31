"""fail_content_generation must not leave file statuses stuck on pending."""

from types import SimpleNamespace

from app.storage.repository import ResumeBuildRepository


def test_clear_unbuilt_file_statuses_skips_pending_and_processing():
    row = SimpleNamespace(
        resume_docx_status="pending",
        resume_pdf_status="processing",
        cover_letter_docx_status="completed",
        cover_letter_pdf_status="failed",
    )
    ResumeBuildRepository._clear_unbuilt_file_statuses(row, status="skipped")
    assert row.resume_docx_status == "skipped"
    assert row.resume_pdf_status == "skipped"
    assert row.cover_letter_docx_status == "completed"
    assert row.cover_letter_pdf_status == "failed"
