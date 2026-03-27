"""
Extract structured profile fields from PDF (vision) or DOCX (text) using OpenAI.
"""

from __future__ import annotations

import base64
import json
import re
from io import BytesIO
from typing import Any

from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client
from app.models.profile_schemas import (
    ResumeCertBlock,
    ResumeEducationBlock,
    ResumeExtractedDraft,
    ResumeParseResponse,
    ResumeSkillBlock,
    ResumeWorkBlock,
)

logger = get_logger(__name__)

MAX_RESUME_BYTES = 6 * 1024 * 1024
MAX_PDF_PAGES = 10
PDF_RENDER_ZOOM = 1.8
# Résumé text sent to the model (DOCX / PDF text fallback); keep within model context budget.
MAX_RESUME_TEXT_CHARS = 100_000

RESUME_JSON_INSTRUCTIONS = """
Copy profile fields from the résumé into structured JSON for a job-search application. Return ONLY valid JSON with this exact shape (use null for unknown, use [] for empty lists; omit optional keys only if you must, prefer null):

{
  "name_first": string | null,
  "name_middle": string | null,
  "name_last": string | null,
  "title": string | null,
  "email": string | null,
  "phone_country_code": string | null,
  "phone_number": string | null,
  "linkedin_url": string | null,
  "github_url": string | null,
  "profile_summary": string | null,
  "technical_skills": [ { "category": string | null, "skills": string | null } ],
  "work_experience": [ {
    "company_name": string | null,
    "job_title": string | null,
    "period_start": string | null,
    "period_end": string | null,
    "location": string | null,
    "job_type": "onsite" | "hybrid" | "remote" | null,
    "description": string | null
  } ],
  "education": [ {
    "university_name": string | null,
    "degree": string | null,
    "mark": string | null,
    "period_start": string | null,
    "period_end": string | null,
    "location": string | null,
    "description": string | null
  } ],
  "certificates": [ { "name": string | null } ],
  "extra": [ string ]
}

Accuracy rules (critical):
- Extract text as faithfully as possible to the source. Do NOT summarize, paraphrase, shorten, or "improve" wording.
- Copy employer names, job titles, degree names, school names, locations, dates, and bullets using the same wording as on the résumé (fix obvious OCR typos only if certain).
- profile_summary: copy the full Summary / Objective / Profile section verbatim (all paragraphs), preserving line breaks where helpful, up to a reasonable length for one JSON string. Do not replace it with a generic one-line synopsis.

Work experience (critical — most errors happen here):
- Emit one work_experience[] object per distinct role/employer block on the résumé (same order as the document, usually reverse chronological).
- **Boundary rule:** For each role, `description` must contain **every** line of narrative that belongs to that role **from the first line under its header through the line immediately before the next role’s header** (or before the Education / Academic / Projects / Skills section if that role is last). Nothing that visually sits under that role may be dropped.
- Put in `description` (verbatim, same order): role overview sentences before bullets; every bullet and sub-bullet; dash/asterisk lines; metric lines; “Key achievements” / “Selected projects” blocks; tech stack lines; indented continuation lines; footnotes under the role. If a line does not fit `company_name`, `job_title`, `dates`, or `location`, it still belongs in `description`.
- Do **not** stop after the first few bullets. Do **not** compress many bullets into one sentence. Do **not** merge two jobs into one entry or split one job across two entries unless the document clearly shows two roles.
- If the résumé uses tables or two-column layout, follow reading order so all lines for that job stay in that job’s `description`.

- education.description: copy honors, coursework, or notes verbatim if present.
- technical_skills: keep skill names and groupings as written (same names, same commas/phrasing). Only split into categories when the résumé clearly groups them.
- extra: optional lines copied verbatim (e.g. languages, awards) not captured elsewhere.
- period_*: use YYYY-MM when the document shows month+year; use YYYY if only year; use null if unclear—do not guess dates.
- LinkedIn/GitHub: exact URLs from the document only.
- phone_country_code: like +1, +44; phone_number: national number without country code.
- job_type: only if explicitly stated or unambiguous (remote/hybrid/onsite); else null.
- Do not invent employers, degrees, or links. If something is unreadable, use null rather than guessing.
"""


def pymupdf_available() -> bool:
    try:
        import fitz  # noqa: F401  # PyMuPDF exposes module `fitz`
        return True
    except ModuleNotFoundError:
        return False


def detect_resume_kind(raw: bytes, filename: str) -> str:
    fn = (filename or "").lower()
    if raw[:4] == b"%PDF":
        return "pdf"
    if raw[:2] == b"PK" and (fn.endswith(".docx") or "docx" in fn):
        return "docx"
    if fn.endswith(".pdf") and raw[:4] == b"%PDF":
        return "pdf"
    if fn.endswith(".docx"):
        return "docx"
    raise ValueError("Upload a PDF or DOCX file.")


def pdf_to_plain_text_pypdf(raw: bytes, max_pages: int = MAX_PDF_PAGES) -> str:
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(raw))
    parts: list[str] = []
    for i, page in enumerate(reader.pages):
        if i >= max_pages:
            break
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        if t.strip():
            parts.append(t)
    return "\n\n".join(parts)


def pdf_to_base64_pngs(raw: bytes) -> tuple[list[str], list[str]]:
    import fitz  # PyMuPDF — must be installed for this path

    warnings: list[str] = []
    doc = fitz.open(stream=raw, filetype="pdf")
    try:
        n = len(doc)
        if n > MAX_PDF_PAGES:
            warnings.append(f"Only the first {MAX_PDF_PAGES} pages were analyzed ({n} pages in file).")
        images: list[str] = []
        for i in range(min(n, MAX_PDF_PAGES)):
            page = doc[i]
            mat = fitz.Matrix(PDF_RENDER_ZOOM, PDF_RENDER_ZOOM)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img_bytes = pix.tobytes("png")
            images.append(base64.standard_b64encode(img_bytes).decode("ascii"))
        return images, warnings
    finally:
        doc.close()


def pdf_to_plain_text_fitz(raw: bytes, max_pages: int = MAX_PDF_PAGES) -> str:
    import fitz

    doc = fitz.open(stream=raw, filetype="pdf")
    try:
        parts: list[str] = []
        for i in range(min(len(doc), max_pages)):
            t = doc[i].get_text("text") or ""
            if t.strip():
                parts.append(t)
        return "\n\n".join(parts)
    finally:
        doc.close()


def pdf_to_plain_text_any(raw: bytes, max_pages: int = MAX_PDF_PAGES) -> str:
    """Extract PDF text: PyMuPDF if available, else pypdf."""
    if pymupdf_available():
        return pdf_to_plain_text_fitz(raw, max_pages=max_pages)
    return pdf_to_plain_text_pypdf(raw, max_pages=max_pages)


def _iter_docx_body_blocks(document: Any):
    """Yield Paragraph and Table nodes in real document order (body + table cells)."""
    from docx.document import Document as DocxDocument
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table, _Cell
    from docx.text.paragraph import Paragraph

    def walk(parent_elm: Any, doc_parent: Any):
        for child in parent_elm.iterchildren():
            if isinstance(child, CT_P):
                yield Paragraph(child, doc_parent)
            elif isinstance(child, CT_Tbl):
                yield Table(child, doc_parent)

    if isinstance(document, DocxDocument):
        yield from walk(document.element.body, document)
        return
    if isinstance(document, _Cell):
        yield from walk(document._tc, document)
        return
    raise TypeError("expected Document or _Cell")


def _dedupe_adjacent_preserve_order(parts: list[str]) -> list[str]:
    out: list[str] = []
    for p in parts:
        if not out or out[-1] != p:
            out.append(p)
    return out


def _docx_cell_plain(cell: Any) -> str:
    """Recursive plain text for a table cell (paragraphs + nested tables in order)."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    chunks: list[str] = []
    for block in _iter_docx_body_blocks(cell):
        if isinstance(block, Paragraph):
            t = (block.text or "").strip()
            if t:
                chunks.append(t)
        elif isinstance(block, Table):
            chunks.append(_docx_table_plain(block))
    return "\n".join(chunks)


def _docx_table_plain(table: Any) -> str:
    row_texts: list[str] = []
    for row in table.rows:
        cell_texts = [_docx_cell_plain(c).strip() for c in row.cells]
        cell_texts = _dedupe_adjacent_preserve_order([c for c in cell_texts if c])
        if cell_texts:
            row_texts.append(" | ".join(cell_texts))
    return "\n".join(row_texts)


def docx_to_plain_text(raw: bytes) -> str:
    """Flatten DOCX to linear text in document order (paragraphs and tables interleaved)."""
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(BytesIO(raw))
    parts: list[str] = []
    for block in _iter_docx_body_blocks(doc):
        if isinstance(block, Paragraph):
            t = (block.text or "").strip()
            if t:
                parts.append(t)
        elif isinstance(block, Table):
            t = _docx_table_plain(block).strip()
            if t:
                parts.append(t)
    return "\n\n".join(parts)


def _clip_resume_text(text: str, warnings: list[str]) -> str:
    t = text.strip()
    if len(t) <= MAX_RESUME_TEXT_CHARS:
        return t
    warnings.append(
        f"Résumé text was truncated to {MAX_RESUME_TEXT_CHARS} characters for parsing; "
        "content near the end of the document may be missing from extraction."
    )
    return t[:MAX_RESUME_TEXT_CHARS]


def _parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1).strip()
    return json.loads(text)


def _draft_has_content(draft: ResumeExtractedDraft) -> bool:
    if any(
        [
            draft.name_first,
            draft.name_last,
            draft.title,
            draft.email,
            draft.profile_summary,
            draft.phone_number,
            draft.linkedin_url,
        ]
    ):
        return True
    if draft.technical_skills and any((s.category or s.skills) for s in draft.technical_skills):
        return True
    if draft.work_experience and any((w.company_name or w.job_title) for w in draft.work_experience):
        return True
    if draft.education and any((e.university_name or e.degree) for e in draft.education):
        return True
    if draft.certificates and any(c.name for c in draft.certificates):
        return True
    if draft.extra and any(x.strip() for x in draft.extra):
        return True
    return False


def _normalize_draft(data: dict[str, Any]) -> ResumeExtractedDraft:
    """Coerce loosely-typed LLM output into the draft model."""
    draft = ResumeExtractedDraft.model_validate(data)

    def _clean(s: str | None) -> str | None:
        if s is None:
            return None
        t = str(s).strip()
        return t if t else None

    draft.name_first = _clean(draft.name_first)
    draft.name_middle = _clean(draft.name_middle)
    draft.name_last = _clean(draft.name_last)
    draft.title = _clean(draft.title)
    draft.email = _clean(draft.email)
    draft.phone_country_code = _clean(draft.phone_country_code)
    draft.phone_number = _clean(draft.phone_number)
    draft.linkedin_url = _clean(draft.linkedin_url)
    draft.github_url = _clean(draft.github_url)
    draft.profile_summary = _clean(draft.profile_summary)

    if not draft.phone_country_code and draft.phone_number:
        draft.phone_country_code = "+1"
    jt_allowed = {"onsite", "hybrid", "remote"}
    clean_work = []
    for w in draft.work_experience:
        cn = _clean(w.company_name)
        jt = _clean(w.job_title)
        if not cn and not jt:
            continue
        jtype = _clean(w.job_type)
        if jtype and jtype.lower() not in jt_allowed:
            jtype = None
        elif jtype:
            jtype = jtype.lower()
        clean_work.append(
            ResumeWorkBlock(
                company_name=cn,
                job_title=jt,
                period_start=_clean(w.period_start),
                period_end=_clean(w.period_end),
                location=_clean(w.location),
                job_type=jtype,
                description=_clean(w.description),
            )
        )
    draft.work_experience = clean_work

    clean_edu = []
    for e in draft.education:
        u = _clean(e.university_name)
        d = _clean(e.degree)
        if not u and not d:
            continue
        clean_edu.append(
            ResumeEducationBlock(
                university_name=u,
                degree=d,
                mark=_clean(e.mark),
                period_start=_clean(e.period_start),
                period_end=_clean(e.period_end),
                location=_clean(e.location),
                description=_clean(e.description),
            )
        )
    draft.education = clean_edu

    skills_out = []
    for s in draft.technical_skills:
        c = _clean(s.category)
        sk = _clean(s.skills)
        if c or sk:
            skills_out.append(ResumeSkillBlock(category=c, skills=sk))
    draft.technical_skills = skills_out

    certs = []
    for c in draft.certificates:
        n = _clean(c.name)
        if n:
            certs.append(ResumeCertBlock(name=n))
    draft.certificates = certs

    draft.extra = [x.strip() for x in draft.extra if x and str(x).strip()]

    return draft


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=25),
    reraise=True,
)
async def _call_openai_resume(
    *,
    user_text: str | None,
    image_base64_pngs: list[str] | None,
) -> ResumeExtractedDraft:
    client: AsyncOpenAI = get_openai_client()
    settings = get_settings()

    sys_msg = (
        "You are a precise résumé transcription assistant. Your job is to extract structured fields while preserving "
        "the original wording—no summarization, no creative rewriting. Output valid JSON only.\n"
        + RESUME_JSON_INSTRUCTIONS
    )

    if image_base64_pngs:
        parts: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "The images are résumé pages. Transcribe into the JSON schema with verbatim wording (no summarizing). "
                    "For work_experience: one object per distinct job. Each description must include **every** line of "
                    "body text that belongs to that job—all bullets, sub-bullets, intro lines, metrics—through the "
                    "line immediately before the next job header (or before Education). Do not merge jobs or drop bullets."
                ),
            }
        ]
        for b64 in image_base64_pngs:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"},
                }
            )
        user_msg: Any = {"role": "user", "content": parts}
    else:
        if not user_text or not user_text.strip():
            raise AIParsingError("No text extracted from document")
        ut = user_text.strip()
        if len(ut) > MAX_RESUME_TEXT_CHARS:
            ut = ut[:MAX_RESUME_TEXT_CHARS]
        user_msg = {
            "role": "user",
            "content": (
                "Résumé plain text is below (DOCX/PDF extraction: paragraphs and table rows follow document order).\n"
                "For work_experience, emit one entry per job. Each entry's `description` must be the **full** verbatim "
                "block for that role: from the first body line under that role's title/company through the last line "
                "before the next role (or before Education / Projects if it is the last job)—including every bullet, "
                "sub-bullet, and paragraph. Do not abbreviate.\n"
                "---\n"
                f"{ut}\n"
                "---\n"
                "Return the JSON object only."
            ),
        }

    # Verbatim extraction can yield large JSON (full bullets, summary). Prefer a high output budget.
    resume_max_out = max(settings.openai_max_tokens, 8192)
    # Many chat models cap completion below 32k; 16k is widely supported for long JSON.
    resume_max_out = min(resume_max_out, 16384)

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[{"role": "system", "content": sys_msg}, user_msg],
        temperature=0.0,
        max_tokens=resume_max_out,
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content
    if not raw:
        raise AIParsingError("Empty model response")
    try:
        data = _parse_json_object(raw)
        draft = _normalize_draft(data)
        if not _draft_has_content(draft):
            raise AIParsingError("Could not extract meaningful profile data from this file")
        return draft
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("resume_parse_json_failed", error=str(e), preview=raw[:400])
        raise AIParsingError("Failed to parse extracted profile JSON") from e


async def parse_resume_bytes(*, raw: bytes, filename: str) -> ResumeParseResponse:
    if len(raw) > MAX_RESUME_BYTES:
        raise ValueError(f"File too large (max {MAX_RESUME_BYTES // (1024 * 1024)} MB).")

    kind = detect_resume_kind(raw, filename)
    warnings: list[str] = []

    if kind == "pdf":
        if not pymupdf_available():
            logger.warning("pymupdf_not_installed_pdf_text_only")
            text = pdf_to_plain_text_pypdf(raw)
            if not text.strip():
                raise ValueError(
                    "Could not read this PDF. Install PyMuPDF for better support: pip install pymupdf"
                )
            text = _clip_resume_text(text, warnings)
            draft = await _call_openai_resume(user_text=text, image_base64_pngs=None)
            warnings.append(
                "PDF parsed as plain text (install pymupdf for page images / vision). Run: pip install pymupdf"
            )
            return ResumeParseResponse(draft=draft, source_kind="pdf", warnings=warnings)

        images, w = pdf_to_base64_pngs(raw)
        warnings.extend(w)
        if not images:
            raise ValueError("Could not render PDF pages")
        try:
            draft = await _call_openai_resume(user_text=None, image_base64_pngs=images)
        except Exception as e:
            logger.warning("resume_pdf_vision_failed_trying_text", error=str(e))
            text = pdf_to_plain_text_any(raw)
            if not text.strip():
                raise
            text = _clip_resume_text(text, warnings)
            draft = await _call_openai_resume(user_text=text, image_base64_pngs=None)
            warnings.append("PDF was parsed from extracted text (vision path failed or model has no vision).")
        return ResumeParseResponse(draft=draft, source_kind="pdf", warnings=warnings)

    text = docx_to_plain_text(raw)
    if not text.strip():
        raise ValueError("No text found in DOCX")
    text = _clip_resume_text(text, warnings)
    draft = await _call_openai_resume(user_text=text, image_base64_pngs=None)
    warnings.append("DOCX was parsed from text; use PDF for pixel-perfect layout.")
    return ResumeParseResponse(draft=draft, source_kind="docx", warnings=warnings)
