"""
Extract structured profile fields from PDF (vision) or DOCX (text) using OpenAI.
"""

from __future__ import annotations

import base64
import json
import re
from io import BytesIO
from typing import Any


from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.llm_client import chat_completion_with_empty_retry, get_llm_client_for_user
from app.models.profile_schemas import (
    ResumeCertBlock,
    ResumeEducationBlock,
    ResumeExtractedDraft,
    ResumeParseResponse,
    ResumeSkillBlock,
    ResumeWorkBlock,
)
from app.utils.flexible_date import coerce_flexible_date
from app.utils.profile_errors import format_profile_unexpected_error

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
    "project_title": string | null,
    "project_intro": string | null,
    "contributions": [ string ],
    "used_skills": string | null,
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
  "certificates": [ { "name": string | null, "issued_at": string | null, "url": string | null } ],
  "extra": [ string ]
}

Accuracy rules (critical):
- Extract text as faithfully as possible to the source. Do NOT summarize, paraphrase, shorten, or "improve" wording.
- Copy employer names, job titles, degree names, school names, locations, dates, and bullets using the same wording as on the résumé (fix obvious OCR typos only if certain).
- profile_summary: copy the full Summary / Objective / Profile section verbatim (all paragraphs), preserving line breaks where helpful, up to a reasonable length for one JSON string. Do not replace it with a generic one-line synopsis.

Work experience (critical - most errors happen here):
- Emit one work_experience[] object per distinct role/employer block on the résumé (same order as the document, usually reverse chronological).
- **Boundary rule:** For each role, `description` must contain **every** line of narrative that belongs to that role **from the first line under its header through the line immediately before the next role’s header** (or before the Education / Academic / Projects / Skills section if that role is last). Nothing that visually sits under that role may be dropped.
- Put in `description` (verbatim, same order): role overview sentences before bullets; every bullet and sub-bullet; dash/asterisk lines; metric lines; “Key achievements” / “Selected projects” blocks; tech stack lines; indented continuation lines; footnotes under the role. If a line does not fit `company_name`, `job_title`, `dates`, or `location`, it still belongs in `description`.
- Do **not** stop after the first few bullets. Do **not** compress many bullets into one sentence. Do **not** merge two jobs into one entry or split one job across two entries unless the document clearly shows two roles.
- If the résumé uses tables or two-column layout, follow reading order so all lines for that job stay in that job’s `description`.

- education.description: copy honors, coursework, or notes verbatim if present.
- technical_skills: copy ONLY from the résumé's dedicated Skills / Technical Skills section at the end of the document. Each object MUST include both `category` (e.g. "Languages", "Frameworks", "Cloud & DevOps") and `skills` (comma-separated list for that category). Do NOT put per-job "Technologies Used" lines here - those belong in work_experience.description.
- extra: optional lines copied verbatim (e.g. languages, awards) not captured elsewhere.
- period_*: use YYYY-MM when the document shows month+year; use YYYY if only year; use null if unclear-do not guess dates.
- LinkedIn/GitHub: exact URLs from the document only.
- certificates: include name; issued_at when an issue date is shown; url when a credential/verification link is present.
  - issued_at MUST use the same formats as period_*: YYYY-MM (month+year) or YYYY (year only). Never emit résumé wording like "Aug 2023", "Issued Nov 2021", or "August 2023".
  - Example: "Issued Aug 2023 Expired Aug 2025" → issued_at "2023-08". Prefer the issue date, not the expiry.
  - Issuer names and credential IDs are not separate fields, put the certificate title in name; do not dump issuer/ID/date lines into extra when they belong with a certificate.
- phone_country_code: dialing code only (e.g. "+1", "+44"). phone_number: the **complete** national number without the country code.
  - For US/Canada (+1): phone_number MUST be the full 10-digit number (area code + local), e.g. "(610) 234-7936" or "6102347936". Never emit a truncated fragment such as "313-3369" or "610-234".
  - If the résumé phone is incomplete, unreadable, or you cannot recover all digits, set BOTH phone_country_code and phone_number to null, do not invent or keep partial numbers.
  - Do not put the country code inside phone_number (no leading "+1" in phone_number).
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
    import fitz  # PyMuPDF - must be installed for this path

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


def _url_already_in_text(url: str, body_lower: str) -> bool:
    """True if ``url`` (or a close variant) already appears in extracted body text."""
    bare = re.sub(r"^https?://", "", url, flags=re.IGNORECASE).rstrip("/").lower()
    no_www = re.sub(r"^www\.", "", bare)
    candidates = {bare, no_www, "www." + no_www if not bare.startswith("www.") else bare}
    return any(c and c in body_lower for c in candidates)


def _merge_text_with_document_links(body: str, urls: list[str]) -> str:
    """Prepend hyperlink targets that are not already present as visible text.

    Résumés often store LinkedIn/GitHub as clickable icons/labels whose href is
    never part of ``Paragraph.text`` / ``page.get_text``. Surfacing those URIs
    at the top of the extracted text lets both the LLM and the contact regex
    fallback recover them.
    """
    body = (body or "").strip()
    body_lower = body.lower()
    extra: list[str] = []
    seen: set[str] = set()
    for raw_url in urls:
        u = (raw_url or "").strip()
        if not u:
            continue
        lower = u.lower()
        if lower.startswith(("mailto:", "javascript:", "file:", "#")):
            continue
        if not lower.startswith(("http://", "https://")):
            if "://" in u:
                continue
            if "." not in u:
                continue
            u = "https://" + u.lstrip("/")
            lower = u.lower()
        key = lower.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        if _url_already_in_text(u, body_lower):
            continue
        extra.append(u)
    if not extra:
        return body
    block = "Document links:\n" + "\n".join(extra)
    return f"{block}\n\n{body}" if body else block


def _pdf_page_link_uris(page: Any) -> list[str]:
    """URI targets from PDF link annotations (icon/label hyperlinks)."""
    urls: list[str] = []
    try:
        links = page.get_links() or []
    except Exception:
        return urls
    for link in links:
        uri = (link or {}).get("uri")
        if uri and str(uri).strip():
            urls.append(str(uri).strip())
    return urls


def pdf_to_plain_text_fitz(raw: bytes, max_pages: int = MAX_PDF_PAGES) -> str:
    import fitz

    doc = fitz.open(stream=raw, filetype="pdf")
    try:
        parts: list[str] = []
        urls: list[str] = []
        for i in range(min(len(doc), max_pages)):
            page = doc[i]
            t = page.get_text("text") or ""
            if t.strip():
                parts.append(t)
            urls.extend(_pdf_page_link_uris(page))
        return _merge_text_with_document_links("\n\n".join(parts), urls)
    finally:
        doc.close()


def pdf_to_plain_text_any(raw: bytes, max_pages: int = MAX_PDF_PAGES) -> str:
    """Extract PDF text: PyMuPDF if available, else pypdf."""
    if pymupdf_available():
        return pdf_to_plain_text_fitz(raw, max_pages=max_pages)
    return pdf_to_plain_text_pypdf(raw, max_pages=max_pages)


def _docx_paragraph_hyperlink_targets(paragraph: Any) -> list[str]:
    """External hyperlink hrefs from a paragraph (not display text).

    Covers both ``w:hyperlink`` relationships and legacy ``HYPERLINK \"url\"``
    field instructions (common in some Word exports).
    """
    from docx.oxml.ns import qn

    urls: list[str] = []
    try:
        part = paragraph.part
    except Exception:
        part = None
    for el in paragraph._element.iter():
        if el.tag == qn("w:hyperlink"):
            r_id = el.get(qn("r:id"))
            if not r_id or part is None:
                continue
            try:
                rel = part.rels[r_id]
                target = getattr(rel, "target_ref", None) or getattr(rel, "_target", None)
                if target:
                    urls.append(str(target).strip())
            except Exception:
                continue
            continue
        # Field code: HYPERLINK "https://..."
        if el.tag == qn("w:instrText") and el.text:
            m = re.search(r'HYPERLINK\s+"([^"]+)"', el.text, re.IGNORECASE)
            if m:
                urls.append(m.group(1).strip())
    return urls


def _docx_story_plain(container: Any) -> tuple[str, list[str]]:
    """Plain text + hyperlink targets for a header, footer, or similar story."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    chunks: list[str] = []
    urls: list[str] = []
    try:
        blocks = list(_iter_docx_body_blocks(container))
    except TypeError:
        # Header/Footer expose .paragraphs / .tables but not Document-style body walk
        # for every python-docx version; fall back to paragraphs + tables.
        blocks = []
        for p in getattr(container, "paragraphs", None) or []:
            blocks.append(p)
        for t in getattr(container, "tables", None) or []:
            blocks.append(t)
    for block in blocks:
        if isinstance(block, Paragraph):
            t = (block.text or "").strip()
            if t:
                chunks.append(t)
            urls.extend(_docx_paragraph_hyperlink_targets(block))
        elif isinstance(block, Table):
            nested_text, nested_urls = _docx_table_plain(block)
            if nested_text:
                chunks.append(nested_text)
            urls.extend(nested_urls)
    return "\n".join(chunks), urls


def _docx_header_footer_plain(doc: Any) -> tuple[str, list[str]]:
    """Contact rows often live in the page header (icon LinkedIn), not the body."""
    chunks: list[str] = []
    urls: list[str] = []
    seen_parts: set[int] = set()
    attrs = (
        "header",
        "footer",
        "first_page_header",
        "first_page_footer",
        "even_page_header",
        "even_page_footer",
    )
    for section in getattr(doc, "sections", None) or []:
        for attr in attrs:
            try:
                story = getattr(section, attr, None)
            except Exception:
                continue
            if story is None:
                continue
            try:
                part_id = id(story.part)
            except Exception:
                part_id = id(story)
            if part_id in seen_parts:
                continue
            seen_parts.add(part_id)
            text, story_urls = _docx_story_plain(story)
            if text.strip():
                chunks.append(text.strip())
            urls.extend(story_urls)
            # Also collect any external hyperlink relationships on this part
            # (covers picture/shape clicks that aren't w:hyperlink in a paragraph).
            try:
                for rel in story.part.rels.values():
                    reltype = getattr(rel, "reltype", "") or ""
                    if "hyperlink" in reltype and getattr(rel, "is_external", False):
                        target = getattr(rel, "target_ref", None) or getattr(rel, "_target", None)
                        if target:
                            urls.append(str(target).strip())
            except Exception:
                pass
    return "\n\n".join(chunks), urls


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
    # Header / Footer stories expose the same CT_P / CT_Tbl children.
    elm = getattr(document, "_element", None)
    if elm is not None:
        yield from walk(elm, document)
        return
    raise TypeError("expected Document, _Cell, Header, or Footer")


def _dedupe_adjacent_preserve_order(parts: list[str]) -> list[str]:
    out: list[str] = []
    for p in parts:
        if not out or out[-1] != p:
            out.append(p)
    return out


def _docx_cell_plain(cell: Any) -> tuple[str, list[str]]:
    """Recursive plain text + hyperlink targets for a table cell."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    chunks: list[str] = []
    urls: list[str] = []
    for block in _iter_docx_body_blocks(cell):
        if isinstance(block, Paragraph):
            t = (block.text or "").strip()
            if t:
                chunks.append(t)
            urls.extend(_docx_paragraph_hyperlink_targets(block))
        elif isinstance(block, Table):
            nested_text, nested_urls = _docx_table_plain(block)
            if nested_text:
                chunks.append(nested_text)
            urls.extend(nested_urls)
    return "\n".join(chunks), urls


def _docx_table_plain(table: Any) -> tuple[str, list[str]]:
    row_texts: list[str] = []
    urls: list[str] = []
    for row in table.rows:
        cell_payloads = [_docx_cell_plain(c) for c in row.cells]
        cell_texts = [t.strip() for t, _ in cell_payloads]
        for _, cell_urls in cell_payloads:
            urls.extend(cell_urls)
        cell_texts = _dedupe_adjacent_preserve_order([c for c in cell_texts if c])
        if cell_texts:
            row_texts.append(" | ".join(cell_texts))
    return "\n".join(row_texts), urls


def docx_to_plain_text(raw: bytes) -> str:
    """Flatten DOCX to linear text in document order (paragraphs and tables interleaved).

    Also surfaces external hyperlink targets (e.g. LinkedIn behind an icon/label)
    so contact URLs are not lost when display text is only \"LinkedIn\".
    Headers/footers are included - many résumés put the contact icon row there.
    """
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(BytesIO(raw))
    parts: list[str] = []
    urls: list[str] = []

    hf_text, hf_urls = _docx_header_footer_plain(doc)
    if hf_text.strip():
        parts.append(hf_text.strip())
    urls.extend(hf_urls)

    for block in _iter_docx_body_blocks(doc):
        if isinstance(block, Paragraph):
            t = (block.text or "").strip()
            if t:
                parts.append(t)
            urls.extend(_docx_paragraph_hyperlink_targets(block))
        elif isinstance(block, Table):
            t, table_urls = _docx_table_plain(block)
            t = t.strip()
            if t:
                parts.append(t)
            urls.extend(table_urls)

    # Safety net: any external hyperlink on the main document part.
    try:
        for rel in doc.part.rels.values():
            reltype = getattr(rel, "reltype", "") or ""
            if "hyperlink" in reltype and getattr(rel, "is_external", False):
                target = getattr(rel, "target_ref", None) or getattr(rel, "_target", None)
                if target:
                    urls.append(str(target).strip())
    except Exception:
        pass

    return _merge_text_with_document_links("\n\n".join(parts), urls)


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


_US_PHONE_RE = re.compile(
    r"(?:\+?1[\s\-.(]*)?"
    r"(\d{3})[\s\).\-]*(\d{3})[\s.\-]*(\d{4})\b"
)

# Capture the profile handle; allow optional trailing slash / query / fragment.
# Host may be www. or a regional subdomain (e.g. uk.linkedin.com).
_LINKEDIN_IN_TEXT_RE = re.compile(
    r"(?:https?://)?(?:(?:www|[a-z]{2})\.)?linkedin\.com/in/([A-Za-z0-9][\w\-]{0,98})",
    re.IGNORECASE,
)
_EMAIL_IN_TEXT_RE = re.compile(r"[\w.\-+]+@[\w.\-]+\.\w+")
_GITHUB_IN_TEXT_RE = re.compile(
    r"(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9](?:[\w\-]|\.(?!\.)){0,38})",
    re.IGNORECASE,
)


def _normalize_linkedin_url(url: str | None) -> str | None:
    """Canonicalize a LinkedIn profile URL to https://www.linkedin.com/in/<handle>."""
    if not url:
        return None
    u = str(url).strip()
    if not u:
        return None
    m = _LINKEDIN_IN_TEXT_RE.search(u)
    if m:
        handle = (m.group(1) or "").strip().strip("-")
        if handle:
            return f"https://www.linkedin.com/in/{handle}"
    if not u.lower().startswith("http"):
        u = "https://" + u.lstrip("/")
    return u


def _normalize_github_url(url: str | None) -> str | None:
    if not url:
        return None
    u = str(url).strip()
    if not u:
        return None
    m = _GITHUB_IN_TEXT_RE.search(u)
    if m:
        handle = (m.group(1) or "").strip().strip("-.").strip()
        if handle and handle.lower() not in {
            "features",
            "topics",
            "collections",
            "events",
            "sponsors",
            "settings",
        }:
            return f"https://github.com/{handle}"
    if not u.lower().startswith("http"):
        u = "https://" + u.lstrip("/")
    return u


def _phone_digit_count(value: str | None) -> int:
    if not value:
        return 0
    return len(re.sub(r"\D", "", str(value)))


def _is_us_country_code(country: str | None) -> bool:
    if not country:
        return False
    return re.sub(r"\D", "", str(country)) == "1"


def _format_us_national(digits10: str) -> str:
    return f"({digits10[:3]}) {digits10[3:6]}-{digits10[6:]}"


def _normalize_phone_fields(country: str | None, number: str | None) -> tuple[str | None, str | None]:
    """Split/format phone fields; reject incomplete numbers (never keep partials).

    US/Canada (+1) requires a full 10-digit national number. Other countries
    require 8–15 national digits. Truncated fragments like ``313-3369`` under
    ``+1`` are discarded so the profile is not seeded with invalid contact data.
    """
    combined = " ".join(x for x in (country, number) if x and str(x).strip()).strip()
    if not combined:
        return None, None

    m = _US_PHONE_RE.search(combined)
    if m:
        return "+1", _format_us_national(f"{m.group(1)}{m.group(2)}{m.group(3)}")

    digits = re.sub(r"\D", "", combined)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) == 10:
        return "+1", _format_us_national(digits)

    cc = str(country).strip() if country and str(country).strip() else None
    num = str(number).strip() if number and str(number).strip() else None
    national_digits = _phone_digit_count(num)

    # Whole number landed in the country field only.
    if not num and cc and not _is_us_country_code(cc):
        cc_digits = re.sub(r"\D", "", cc)
        if len(cc_digits) == 11 and cc_digits.startswith("1"):
            return "+1", _format_us_national(cc_digits[1:])
        if len(cc_digits) == 10:
            return "+1", _format_us_national(cc_digits)
        return None, None

    # +1 / implied US: keep only a complete 10-digit national number.
    if _is_us_country_code(cc) or cc is None:
        if national_digits == 10 and num:
            return "+1", _format_us_national(re.sub(r"\D", "", num))
        return None, None

    # Non-US country code: require a complete-looking national part.
    if num and 8 <= national_digits <= 15:
        return cc, num

    return None, None


def _fill_missing_contact_from_text(draft: ResumeExtractedDraft, text: str) -> list[str]:
    """Backfill header contact fields when the vision LLM omits icon-row details."""
    notes: list[str] = []
    if not text or not text.strip():
        return notes
    # Phone/email are almost always in the header; LinkedIn/GitHub may only appear
    # in a prepended "Document links:" block or later in the file.
    header = text[:5000]

    if not draft.phone_number:
        m = _US_PHONE_RE.search(header)
        if m:
            cc, num = _normalize_phone_fields(None, m.group(0))
            if num:
                draft.phone_country_code = cc or "+1"
                draft.phone_number = num
                notes.append("Phone number was recovered from document text (AI parser omitted it).")

    if not draft.linkedin_url:
        lm = _LINKEDIN_IN_TEXT_RE.search(text)
        if lm:
            draft.linkedin_url = _normalize_linkedin_url(lm.group(0))
            notes.append("LinkedIn URL was recovered from document text (AI parser omitted it).")

    if not draft.github_url:
        gm = _GITHUB_IN_TEXT_RE.search(text)
        if gm:
            draft.github_url = _normalize_github_url(gm.group(0))
            notes.append("GitHub URL was recovered from document text (AI parser omitted it).")

    if not draft.email:
        em = _EMAIL_IN_TEXT_RE.search(header)
        if em:
            draft.email = em.group(0).lower()

    return notes


_TECH_USED_LINE_RE = re.compile(r"^technologies\s+used\s*:", re.IGNORECASE)


def _parse_skills_section_from_text(text: str) -> list[ResumeSkillBlock]:
    """Parse a structured SKILLS section (category header + comma-separated list lines)."""
    m = re.search(r"\bSKILLS\b", text, re.IGNORECASE)
    if not m:
        return []
    section = text[m.end() :]
    stop = re.search(
        r"\n(?:CERTIFICATIONS?|AWARDS?|PROJECTS|PUBLICATIONS|REFERENCES?)\b",
        section,
        re.IGNORECASE,
    )
    if stop:
        section = section[: stop.start()]
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in section.splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        return []

    blocks: list[ResumeSkillBlock] = []
    current_cat: str | None = None
    skill_parts: list[str] = []

    def flush() -> None:
        nonlocal current_cat, skill_parts
        if current_cat and skill_parts:
            blocks.append(ResumeSkillBlock(category=current_cat, skills=", ".join(skill_parts)))
        current_cat = None
        skill_parts = []

    for line in lines:
        is_skill_line = "," in line or (current_cat is not None and len(line) > 24)
        if current_cat is None or not is_skill_line:
            flush()
            current_cat = line
        else:
            skill_parts.append(line)
    flush()
    return [b for b in blocks if b.category and b.skills]


def _coerce_technical_skills(raw_skills: list[ResumeSkillBlock]) -> list[ResumeSkillBlock]:
    """Keep only well-formed category+skills pairs; drop misplaced job tech-stack lines."""
    out: list[ResumeSkillBlock] = []
    for s in raw_skills:
        c = (s.category or "").strip() or None
        sk = (s.skills or "").strip() or None
        if not c or not sk:
            if sk and _TECH_USED_LINE_RE.match(sk):
                continue
            continue
        out.append(ResumeSkillBlock(category=c, skills=sk))
    return out


def _fill_missing_skills_from_text(draft: ResumeExtractedDraft, text: str) -> list[str]:
    """Replace sparse/invalid LLM skill rows with the document's SKILLS section."""
    notes: list[str] = []
    draft.technical_skills = _coerce_technical_skills(draft.technical_skills)
    valid = len(draft.technical_skills)
    parsed = _parse_skills_section_from_text(text or "")
    if not parsed:
        return notes
    if valid < 2:
        draft.technical_skills = parsed
        notes.append("Technical skills were recovered from the SKILLS section in document text.")
    return notes


def _infer_job_type(
    location: str | None,
    job_type: str | None,
    description: str | None = None,
) -> str | None:
    jt_allowed = {"onsite", "hybrid", "remote"}
    if job_type and job_type.lower() in jt_allowed:
        return job_type.lower()
    blob = f"{location or ''} {description or ''}".lower()
    if "hybrid" in blob:
        return "hybrid"
    if "remote" in blob:
        return "remote"
    if location and location.strip():
        return "onsite"
    return None


_RESUME_DRAFT_KEYS = {
    "name_first",
    "name_middle",
    "name_last",
    "title",
    "email",
    "phone_country_code",
    "phone_number",
    "linkedin_url",
    "github_url",
    "profile_summary",
    "technical_skills",
    "work_experience",
    "education",
    "certificates",
    "extra",
}

_WORK_KEYS = {
    "company_name",
    "job_title",
    "period_start",
    "period_end",
    "location",
    "job_type",
    "employment_type",
    "project_title",
    "project_intro",
    "contributions",
    "used_skills",
    "description",
}

_EDU_KEYS = {
    "university_name",
    "degree",
    "mark",
    "period_start",
    "period_end",
    "location",
    "description",
    "field_of_study",
}

_CERT_KEYS = {"name", "issued_at", "url"}
_SKILL_KEYS = {"category", "skills"}


def _listify(value: Any) -> list[Any]:
    """Normalize LLM list-or-object-or-scalar payloads into a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, dict):
        keys = list(value.keys())
        if keys and all(str(k).isdigit() for k in keys):
            return [value[k] for k in sorted(keys, key=lambda x: int(str(x)))]
        return [value]
    return [value]


def _keep_known(obj: Any, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(obj, dict):
        return {}
    return {k: v for k, v in obj.items() if k in allowed}


def _coerce_skill_rows(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict) and raw and not all(str(k).isdigit() for k in raw.keys()):
        rows = []
        for cat, skills in raw.items():
            if isinstance(skills, (list, tuple)):
                skill_text = ", ".join(str(s).strip() for s in skills if str(s).strip())
            else:
                skill_text = str(skills or "").strip()
            rows.append({"category": str(cat).strip() or None, "skills": skill_text or None})
        return rows
    rows: list[dict[str, Any]] = []
    for item in _listify(raw):
        if isinstance(item, str):
            text = item.strip()
            if text:
                rows.append({"category": "Skills", "skills": text})
            continue
        if isinstance(item, dict):
            rows.append(_keep_known(item, _SKILL_KEYS))
    return rows


def coerce_resume_payload(data: Any) -> dict[str, Any]:
    """Strip unknown keys and coerce LLM types so draft validation does not raise."""
    if not isinstance(data, dict):
        raise ValueError("Resume JSON must be an object")
    out: dict[str, Any] = {k: data[k] for k in _RESUME_DRAFT_KEYS if k in data}
    if "technical_skills" in out:
        out["technical_skills"] = _coerce_skill_rows(out["technical_skills"])
    if "work_experience" in out:
        out["work_experience"] = [
            _keep_known(item, _WORK_KEYS) for item in _listify(out["work_experience"]) if isinstance(item, dict)
        ]
    if "education" in out:
        out["education"] = [
            _keep_known(item, _EDU_KEYS) for item in _listify(out["education"]) if isinstance(item, dict)
        ]
    if "certificates" in out:
        out["certificates"] = [
            _keep_known(item, _CERT_KEYS) for item in _listify(out["certificates"]) if isinstance(item, dict)
        ]
    return out


def _normalize_draft(data: dict[str, Any]) -> ResumeExtractedDraft:
    """Coerce loosely-typed LLM output into the draft model."""
    from pydantic import ValidationError

    payload = coerce_resume_payload(data)
    try:
        draft = ResumeExtractedDraft.model_validate(payload)
    except ValidationError as e:
        raise ValueError(format_profile_unexpected_error(e, "Failed to parse extracted profile JSON")) from e

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
    raw_phone_cc = _clean(draft.phone_country_code)
    raw_phone_num = _clean(draft.phone_number)
    draft.phone_country_code, draft.phone_number = _normalize_phone_fields(
        raw_phone_cc,
        raw_phone_num,
    )
    draft.linkedin_url = _normalize_linkedin_url(_clean(draft.linkedin_url))
    draft.github_url = _normalize_github_url(_clean(draft.github_url))
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
        desc = _clean(w.description)
        jtype = _infer_job_type(_clean(w.location), jtype, desc)
        raw_contributions = w.contributions if isinstance(w.contributions, list) else []
        contributions = [str(c).strip() for c in raw_contributions if c is not None and str(c).strip()]
        clean_work.append(
            ResumeWorkBlock(
                company_name=cn,
                job_title=jt,
                period_start=_clean(w.period_start),
                period_end=_clean(w.period_end),
                location=_clean(w.location),
                job_type=jtype,
                project_title=_clean(w.project_title),
                project_intro=_clean(w.project_intro),
                contributions=contributions,
                used_skills=_clean(w.used_skills),
                description=desc,
            )
        )
    draft.work_experience = clean_work

    draft.technical_skills = _coerce_technical_skills(draft.technical_skills)

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

    certs = []
    for c in draft.certificates:
        n = _clean(c.name)
        if n:
            certs.append(
                ResumeCertBlock(
                    name=n,
                    # Coerce résumé wording ("Aug 2023", "Issued Nov 2021") → YYYY-MM / YYYY.
                    issued_at=coerce_flexible_date(_clean(c.issued_at)),
                    url=_clean(c.url),
                )
            )
    draft.certificates = certs

    draft.extra = [x.strip() for x in draft.extra if x and str(x).strip()]

    return draft


async def _call_openai_resume(
    *,
    user_text: str | None,
    image_base64_pngs: list[str] | None,
    user_id: str | None = None,
) -> ResumeExtractedDraft:
    client = await get_llm_client_for_user(user_id, job_type="resume_parse")
    settings = get_settings()

    sys_msg = (
        "You are a precise résumé transcription assistant. Your job is to extract structured fields while preserving "
        "the original wording-no summarization, no creative rewriting. Output valid JSON only.\n"
        + RESUME_JSON_INSTRUCTIONS
    )

    if image_base64_pngs:
        parts: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "The images are résumé pages. Transcribe into the JSON schema with verbatim wording (no summarizing). "
                    "For work_experience: one object per distinct job. Each description must include **every** line of "
                    "body text that belongs to that job-all bullets, sub-bullets, intro lines, metrics-through the "
                    "line immediately before the next job header (or before Education). Do not merge jobs or drop bullets. "
                    "For contact fields: read LinkedIn/GitHub carefully from the header icon row - copy the full "
                    "profile URL when visible (linkedin.com/in/... or github.com/...), not just the word LinkedIn/GitHub."
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
                "before the next role (or before Education / Projects if it is the last job)-including every bullet, "
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

    raw, _response = await chat_completion_with_empty_retry(
        client,
        observe="resume_parse",
        job_type="resume_parse",
        model=settings.openai_model,
        messages=[{"role": "system", "content": sys_msg}, user_msg],
        temperature=0.0,
        max_tokens=resume_max_out,
        response_format={"type": "json_object"},
    )
    try:
        data = _parse_json_object(raw)
        draft = _normalize_draft(data)
        if not _draft_has_content(draft):
            raise AIParsingError("Could not extract meaningful profile data from this file")
        return draft
    except AIParsingError:
        raise
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("resume_parse_json_failed", error=str(e), preview=raw[:400])
        raise AIParsingError(
            format_profile_unexpected_error(e, "Failed to parse extracted profile JSON")
        ) from e


def infer_country_preferences(draft) -> list[str]:
    """Detect the candidate's likely job countries from a parsed resume draft.

    Signals, strongest first:
      1. Work-experience locations (document order ≈ most recent first).
      2. Education locations.
      3. Phone dialing code (weak fallback, only when no location matched).

    Returns ISO alpha-2 codes, first-seen order, capped at 3. Used to seed
    ``users.country_preferences`` unless the user configured them manually.
    """
    from app.services.country_catalog import DIAL_CODE_TO_COUNTRY
    from app.services.job_location_classifier import detect_countries_in_text

    ordered: list[str] = []

    def _add(codes: list[str]) -> None:
        for code in codes:
            if code not in ordered:
                ordered.append(code)

    for work in (getattr(draft, "work_experience", None) or [])[:5]:
        _add(detect_countries_in_text(getattr(work, "location", None)))
    for edu in (getattr(draft, "education", None) or [])[:3]:
        _add(detect_countries_in_text(getattr(edu, "location", None)))

    if not ordered:
        dial = re.sub(r"\D", "", str(getattr(draft, "phone_country_code", None) or ""))
        if dial in DIAL_CODE_TO_COUNTRY:
            ordered.append(DIAL_CODE_TO_COUNTRY[dial])

    return ordered[:3]


async def parse_resume_bytes(*, raw: bytes, filename: str, user_id: str | None = None) -> ResumeParseResponse:
    if len(raw) > MAX_RESUME_BYTES:
        raise ValueError(f"File too large (max {MAX_RESUME_BYTES // (1024 * 1024)} MB).")

    kind = detect_resume_kind(raw, filename)
    warnings: list[str] = []

    if kind == "pdf":
        text_fallback = pdf_to_plain_text_any(raw)
        if not pymupdf_available():
            logger.warning("pymupdf_not_installed_pdf_text_only")
            if not text_fallback.strip():
                raise ValueError(
                    "Could not read this PDF. Install PyMuPDF for better support: pip install pymupdf"
                )
            text = _clip_resume_text(text_fallback, warnings)
            draft = await _call_openai_resume(user_text=text, image_base64_pngs=None, user_id=user_id)
            warnings.append(
                "PDF parsed as plain text (install pymupdf for page images / vision). Run: pip install pymupdf"
            )
            warnings.extend(_fill_missing_contact_from_text(draft, text))
            warnings.extend(_fill_missing_skills_from_text(draft, text))
            return ResumeParseResponse(draft=draft, source_kind="pdf", warnings=warnings)

        images, w = pdf_to_base64_pngs(raw)
        warnings.extend(w)
        if not images:
            raise ValueError("Could not render PDF pages")
        try:
            draft = await _call_openai_resume(user_text=None, image_base64_pngs=images, user_id=user_id)
        except Exception as e:
            logger.warning("resume_pdf_vision_failed_trying_text", error=str(e))
            if not text_fallback.strip():
                raise
            text = _clip_resume_text(text_fallback, warnings)
            draft = await _call_openai_resume(user_text=text, image_base64_pngs=None, user_id=user_id)
            warnings.append("PDF was parsed from extracted text (vision path failed or model has no vision).")
            warnings.extend(_fill_missing_contact_from_text(draft, text))
            warnings.extend(_fill_missing_skills_from_text(draft, text))
        else:
            warnings.extend(_fill_missing_contact_from_text(draft, text_fallback))
            warnings.extend(_fill_missing_skills_from_text(draft, text_fallback))
        return ResumeParseResponse(draft=draft, source_kind="pdf", warnings=warnings)

    text = docx_to_plain_text(raw)
    if not text.strip():
        raise ValueError("No text found in DOCX")
    text = _clip_resume_text(text, warnings)
    draft = await _call_openai_resume(user_text=text, image_base64_pngs=None, user_id=user_id)
    warnings.extend(_fill_missing_contact_from_text(draft, text))
    warnings.extend(_fill_missing_skills_from_text(draft, text))
    warnings.append("DOCX was parsed from text; use PDF for pixel-perfect layout.")
    return ResumeParseResponse(draft=draft, source_kind="docx", warnings=warnings)
