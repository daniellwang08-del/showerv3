"""Original résumé mode: cover letter only, imported file sent as is, fills use the right résumé."""

from __future__ import annotations

import asyncio
import io
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

from app.api import assistant_routes
from app.models.database import ResumeBuildResult
from app.services import job_match_service, original_resume_service
from app.services.job_pipeline_mode import (
    DOCUMENTS_READY_SQL,
    documents_ready_clause,
    has_tailored_resume,
)


def _run(coro):
    return asyncio.run(coro)


# ── readiness helpers ────────────────────────────────────────────────────────


def test_has_tailored_resume_ignores_autofill_cache():
    assert has_tailored_resume({"work_experience": [{"company_name": "Acme"}]})
    assert has_tailored_resume({"profile_summary": "Engineer"})
    assert has_tailored_resume({"technical_skills": ["Go"]})
    assert not has_tailored_resume({"autofill_locations": {"acme": "Austin, TX"}})
    assert not has_tailored_resume({})
    assert not has_tailored_resume(None)
    assert not has_tailored_resume("not a dict")


def test_documents_ready_accepts_cover_letter_only_builds():
    sql = str(
        documents_ready_clause(ResumeBuildResult).compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )
    assert "resume_docx_status = 'completed'" in sql
    assert "resume_docx_status = 'skipped'" in sql
    assert "cover_letter_docx_status = 'completed'" in sql
    assert "rb.resume_docx_status = 'skipped'" in DOCUMENTS_READY_SQL
    assert "rb.cover_letter_docx_status = 'completed'" in DOCUMENTS_READY_SQL


# ── Phase B ──────────────────────────────────────────────────────────────────

JOB = "Senior Backend Engineer at Acme. Build payment APIs in Go and Postgres."
PROFILE = "## Work Experience\nStripe, Senior Engineer, 2021-present. Built payment rails in Go."


def _fake_llm(monkeypatch, cover_replies):
    calls: list[str] = []
    replies = list(cover_replies)

    async def fake_call(**kwargs):
        calls.append(kwargs["observe_name"])
        if kwargs["observe_name"].startswith("phase_b_cover_letter"):
            return {"cover_letter": replies.pop(0) if replies else None}
        return {"tailored_resume": {"profile_summary": "Tailored", "work_experience": []}}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    return calls


def test_phase_b_original_mode_writes_only_the_cover_letter(monkeypatch):
    calls = _fake_llm(monkeypatch, [{"body": "Dear Acme team, I build payment rails."}])
    resume, cover = _run(
        job_match_service.generate_tailored_content_phase_b(JOB, PROFILE, include_resume=False)
    )
    assert resume is None
    assert cover == {"body": "Dear Acme team, I build payment rails."}
    assert calls == ["phase_b_cover_letter"]


def test_phase_b_original_mode_retries_an_empty_cover_letter(monkeypatch):
    calls = _fake_llm(monkeypatch, [{"body": ""}, {"body": "Second try letter."}])
    resume, cover = _run(
        job_match_service.generate_tailored_content_phase_b(JOB, PROFILE, include_resume=False)
    )
    assert resume is None
    assert cover == {"body": "Second try letter."}
    assert calls == ["phase_b_cover_letter", "phase_b_cover_letter_retry"]


def test_phase_b_original_mode_without_cover_letter_does_nothing(monkeypatch):
    calls = _fake_llm(monkeypatch, [])
    result = _run(
        job_match_service.generate_tailored_content_phase_b(
            JOB, PROFILE, include_resume=False, include_cover_letter=False
        )
    )
    assert result == (None, None)
    assert calls == []


# ── fill context ─────────────────────────────────────────────────────────────


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeSession:
    """Answers the build row query, then any scalar (original résumé text) query."""

    def __init__(self, build, original_text):
        self.build = build
        self.original_text = original_text
        self.scalar_calls = 0

    async def execute(self, _stmt):
        return _Result(self.build)

    async def scalar(self, _stmt):
        self.scalar_calls += 1
        return self.original_text


ORIGINAL_TEXT = "Jane Doe\nStaff Engineer, Stripe\nLed the ledger migration."
TAILORED = {
    "profile_summary": "Payments engineer tuned for Acme.",
    "work_experience": [{"company_name": "Stripe", "description": "Built Acme-relevant payment rails."}],
}
USER_WE = [
    {
        "company_name": "Stripe",
        "job_title": "Staff Engineer",
        "period_start": "2021-08",
        "period_end": None,
        "description": "Led the ledger migration.",
        "contributions": [],
    }
]


def _user(mode):
    return SimpleNamespace(id="u1", application_resume_source=mode, work_experience=USER_WE)


def _build(tailored, cover_body="Dear Acme, here is why I fit."):
    return SimpleNamespace(
        tailored_resume_data=tailored,
        cover_letter_data={"body": cover_body} if cover_body else None,
    )


def test_fill_context_original_mode_uses_imported_resume_and_cover_letter():
    session = _FakeSession(_build(None), ORIGINAL_TEXT)
    text = _run(assistant_routes._application_documents_text(session, _user("original"), "j1"))
    assert "## Original Resume (the file uploaded with this application)" in text
    assert "Led the ledger migration." in text
    assert "## Cover Letter For This Job" in text
    assert "Dear Acme, here is why I fit." in text
    assert "Tailored Resume" not in text


def test_fill_context_original_mode_ignores_leftover_tailored_resume():
    session = _FakeSession(_build(TAILORED), ORIGINAL_TEXT)
    text = _run(assistant_routes._application_documents_text(session, _user("original"), "j1"))
    assert "Led the ledger migration." in text
    assert "Payments engineer tuned for Acme." not in text


def test_fill_context_tailored_mode_uses_tailored_resume_and_cover_letter():
    session = _FakeSession(_build(TAILORED), ORIGINAL_TEXT)
    text = _run(assistant_routes._application_documents_text(session, _user("tailored"), "j1"))
    assert text.startswith("## Tailored Resume For This Job")
    assert "Payments engineer tuned for Acme." in text
    assert "Built Acme-relevant payment rails." in text
    assert "Original Resume" not in text
    assert "Dear Acme, here is why I fit." in text
    assert session.scalar_calls == 0


def test_fill_context_tailored_mode_falls_back_to_original_before_a_build():
    # Only the autofill location cache is stored, which is not a tailored résumé.
    session = _FakeSession(_build({"autofill_locations": {"stripe": "SF"}}, None), ORIGINAL_TEXT)
    text = _run(assistant_routes._application_documents_text(session, _user("tailored"), "j1"))
    assert "## Original Resume" in text
    assert "Cover Letter" not in text


def test_fill_context_empty_without_documents():
    session = _FakeSession(None, None)
    assert _run(assistant_routes._application_documents_text(session, _user("original"), "j1")) == ""


def test_session_docs_report_original_mode():
    row = SimpleNamespace(
        resume_pdf_status="skipped",
        resume_docx_status="skipped",
        cover_letter_pdf_status="completed",
        cover_letter_docx_status="completed",
        content_generation_status="completed",
        error_message=None,
        content_generation_error=None,
    )
    docs = assistant_routes._docs_from_build(row, resume_source="original", original_filename="Jane.pdf")
    assert docs.resume_pdf is False and docs.resume_docx is False
    assert docs.cover_pdf is True and docs.cover_docx is True
    assert docs.resume_source == "original"
    assert docs.original_filename == "Jane.pdf"


# ── stored original file ─────────────────────────────────────────────────────


def _docx_bytes(text: str) -> bytes:
    docx = pytest.importorskip("docx")
    doc = docx.Document()
    for line in text.splitlines():
        doc.add_paragraph(line)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def test_clean_filename_keeps_the_stem_and_fixes_the_extension():
    clean = original_resume_service._clean_filename
    assert clean("C:\\Users\\me\\Jane Doe CV.PDF", "pdf") == "Jane Doe CV.pdf"
    assert clean('bad"name\x01.docx', "docx") == "badname.docx"
    assert clean("", "pdf") == "Resume.pdf"


def test_extract_text_from_docx():
    raw = _docx_bytes("Jane Doe\nStaff Engineer at Stripe")
    text = original_resume_service.extract_resume_text(raw, "docx")
    assert "Jane Doe" in text and "Staff Engineer at Stripe" in text


def test_extract_text_survives_a_broken_file():
    assert original_resume_service.extract_resume_text(b"not a real file", "docx") == ""


class _StoreSession:
    def __init__(self, row):
        self.row = row
        self.committed = False

    async def execute(self, _stmt):
        row = self.row

        class _R:
            def scalar_one_or_none(self_inner):
                return row

        return _R()

    async def get(self, _model, _key):
        return self.row

    async def commit(self):
        self.committed = True


def _patch_store(monkeypatch, row):
    session = _StoreSession(row)

    @asynccontextmanager
    async def fake_get_session():
        yield session

    monkeypatch.setattr(original_resume_service, "get_session", fake_get_session)
    return session


def _row(kind, file_bytes, pdf_bytes=None, filename=None):
    return SimpleNamespace(
        kind=kind,
        file_bytes=file_bytes,
        pdf_bytes=pdf_bytes,
        filename=filename or f"Jane Doe.{kind}",
    )


def test_pdf_upload_is_served_byte_for_byte(monkeypatch):
    raw = b"%PDF-1.7 original bytes"
    _patch_store(monkeypatch, _row("pdf", raw, pdf_bytes=raw))
    got = _run(original_resume_service.get_original_resume_file("u1", "resume_pdf"))
    assert got.content == raw
    assert got.filename == "Jane Doe.pdf"
    assert got.media_type == "application/pdf"
    assert _run(original_resume_service.get_original_resume_file("u1", "resume_docx")) is None


def test_docx_upload_is_served_as_is_and_converted_once_for_pdf(monkeypatch):
    raw = b"PK docx bytes"
    session = _patch_store(monkeypatch, _row("docx", raw))
    got = _run(original_resume_service.get_original_resume_file("u1", "resume_docx"))
    assert got.content == raw
    assert got.media_type.endswith("wordprocessingml.document")

    converted: list[bytes] = []

    def fake_convert(data: bytes) -> bytes:
        converted.append(data)
        return b"%PDF-converted"

    monkeypatch.setattr(original_resume_service, "_docx_to_pdf_bytes", fake_convert)
    pdf = _run(original_resume_service.get_original_resume_file("u1", "resume_pdf"))
    assert pdf.content == b"%PDF-converted"
    assert pdf.filename == "Jane Doe.pdf"
    assert converted == [raw]
    assert session.row.pdf_bytes == b"%PDF-converted" and session.committed

    again = _run(original_resume_service.get_original_resume_file("u1", "resume_pdf"))
    assert again.content == b"%PDF-converted"
    assert converted == [raw]


def test_docx_pdf_conversion_failure_returns_none(monkeypatch):
    _patch_store(monkeypatch, _row("docx", b"PK docx"))

    def boom(_data: bytes) -> bytes:
        raise RuntimeError("converter missing")

    monkeypatch.setattr(original_resume_service, "_docx_to_pdf_bytes", boom)
    assert _run(original_resume_service.get_original_resume_file("u1", "resume_pdf")) is None


def test_no_stored_file_returns_none(monkeypatch):
    _patch_store(monkeypatch, None)
    assert _run(original_resume_service.get_original_resume_file("u1", "resume_pdf")) is None
