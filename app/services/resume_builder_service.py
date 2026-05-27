"""
Resume & cover letter document builder.

Opens user-designed DOCX templates, replaces placeholder tags with AI-tailored
content, and converts to PDF via LibreOffice.

Placeholders recognised in the resume template:
  {{PROFILE_SUMMARY}}  — single paragraph replacement
  {{SKILLS_CONTENT}}   — replaced by N skill-category rows
  {{EXP_1}} … {{EXP_N}} — replaced by per-company experience blocks

Placeholders recognised in the cover letter template:
  {{COVER_LETTER_BODY}} — multi-paragraph body (inline within same paragraph)
  {{DATE}}, {{FULL_NAME}}, {{PROFILE_TITLE}}, {{EMAIL}}, {{PHONE}}, {{LINKEDIN}},
  {{GITHUB}}, {{JOB_COMPANY}}, {{JOB_TITLE}}, {{JOB_LOCATION}}
  Dot-notation aliases: {{profile.full_name}}, {{job.company}}, etc.
"""

from __future__ import annotations

import platform
import re
import shutil
import subprocess
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from docx.text.paragraph import Paragraph

from app.core.config import get_settings
from app.core.logging import get_logger
from app.utils.resume_text_format import parse_bold_markers

logger = get_logger(__name__)

WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


# ── Low-level XML helpers ──────────────────────────────────────────────────

def _clone_pPr(source_p, target_p) -> None:
    """Deep-copy *all* paragraph properties (style, numbering, spacing, indent, …)
    from *source_p* XML element to *target_p* XML element."""
    src_pPr = source_p.find(qn("w:pPr"))
    if src_pPr is None:
        return
    tgt_pPr = target_p.find(qn("w:pPr"))
    if tgt_pPr is not None:
        target_p.remove(tgt_pPr)
    target_p.insert(0, deepcopy(src_pPr))


def _clone_rPr(source_r) -> OxmlElement | None:
    """Deep-copy run properties from a source run element (or None)."""
    rPr = source_r.find(qn("w:rPr"))
    if rPr is None:
        return None
    return deepcopy(rPr)


def _get_template_rPr(anchor_p) -> OxmlElement | None:
    """Get a representative rPr from the anchor paragraph (first run or pPr/rPr)."""
    for r in anchor_p.findall(qn("w:r")):
        rPr = r.find(qn("w:rPr"))
        if rPr is not None:
            return deepcopy(rPr)
    pPr = anchor_p.find(qn("w:pPr"))
    if pPr is not None:
        rPr = pPr.find(qn("w:rPr"))
        if rPr is not None:
            return deepcopy(rPr)
    return None


def _runs_from_marked_text(
    text: str,
    rPr_template: OxmlElement | None,
    *,
    prefix: str = "",
) -> list[OxmlElement]:
    """Build Word runs from text that may contain ``**bold**`` markers."""
    segments = parse_bold_markers(text or "")
    runs: list[OxmlElement] = []
    if prefix:
        runs.append(_make_run(prefix, rPr_template, bold=False))
    for segment, is_bold in segments:
        if not segment:
            continue
        runs.append(_make_run(segment, rPr_template, bold=is_bold))
    if not runs and prefix:
        runs.append(_make_run(prefix, rPr_template, bold=False))
    return runs


def _set_paragraph_marked_text(paragraph: Paragraph, text: str, *, tag: str | None = None) -> None:
    """Replace paragraph content with runs that honor ``**bold**`` markers."""
    p_xml = paragraph._p
    rPr_tpl = _get_template_rPr(p_xml)
    full = "".join(run.text for run in paragraph.runs)
    if tag:
        full = full.replace(tag, text)
    else:
        full = text

    pPr = p_xml.find(qn("w:pPr"))
    for child in list(p_xml):
        if child is not pPr:
            p_xml.remove(child)

    for run_el in _runs_from_marked_text(full, rPr_tpl):
        p_xml.append(run_el)


def _make_run(text: str, rPr_template: OxmlElement | None = None, bold: bool = False) -> OxmlElement:
    """Create a <w:r> element with text and optional formatting."""
    r = OxmlElement("w:r")
    if rPr_template is not None:
        new_rPr = deepcopy(rPr_template)
        if bold:
            if new_rPr.find(qn("w:b")) is None:
                new_rPr.insert(0, OxmlElement("w:b"))
            if new_rPr.find(qn("w:bCs")) is None:
                new_rPr.append(OxmlElement("w:bCs"))
        else:
            for tag_name in ("w:b", "w:bCs"):
                el = new_rPr.find(qn(tag_name))
                if el is not None:
                    new_rPr.remove(el)
        r.append(new_rPr)
    elif bold:
        new_rPr = OxmlElement("w:rPr")
        new_rPr.append(OxmlElement("w:b"))
        new_rPr.append(OxmlElement("w:bCs"))
        r.append(new_rPr)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    r.append(t)
    return r


def _make_paragraph_from_anchor(anchor_p, runs: list[OxmlElement]) -> OxmlElement:
    """Create a new <w:p> that inherits all pPr from *anchor_p* and contains *runs*."""
    new_p = OxmlElement("w:p")
    _clone_pPr(anchor_p, new_p)
    for r in runs:
        new_p.append(r)
    return new_p


# ── Placeholder replacement logic ──────────────────────────────────────────

def _find_paragraph_with_tag(doc: Document, tag: str) -> Paragraph | None:
    """Find the first paragraph whose combined run text contains *tag*."""
    for p in doc.paragraphs:
        full = "".join(run.text for run in p.runs)
        if tag in full:
            return p
    return None


def _replace_inline_tag(paragraph: Paragraph, tag: str, replacement: str) -> bool:
    """Replace *tag* within a paragraph's runs, keeping all other runs/breaks intact.

    Works correctly even when the tag appears in a single run alongside
    line-breaks and other text (like the cover letter template).
    """
    for run in paragraph.runs:
        if tag in run.text:
            run.text = run.text.replace(tag, replacement)
            return True
    return False


def _replace_tag_with_paragraphs(
    doc: Document,
    tag: str,
    new_paragraphs: list[OxmlElement],
    *,
    cleanup_anchor: bool = True,
) -> bool:
    """Replace the paragraph containing *tag* with a list of new <w:p> elements.

    The new paragraphs are inserted *after* the anchor; then the anchor is removed
    (unless cleanup_anchor is False — used when the anchor has other content to keep).
    """
    anchor = _find_paragraph_with_tag(doc, tag)
    if anchor is None:
        return False

    anchor_xml = anchor._p
    parent = anchor_xml.getparent()

    cursor = anchor_xml
    for new_p in new_paragraphs:
        cursor.addnext(new_p)
        cursor = new_p

    if cleanup_anchor:
        parent.remove(anchor_xml)
    return True


def _split_anchor_around_tag(
    doc: Document,
    tag: str,
    body_paragraphs: list[OxmlElement],
) -> bool:
    """Handle the case where *tag* is embedded in a paragraph alongside other content
    (e.g., the cover letter template: ``{{DATE}} <br> Dear Hiring Manager, <br> {{COVER_LETTER_BODY}}``).

    Strategy: find the run containing *tag*, remove the tag text from the run,
    and insert body paragraphs *after* the anchor paragraph. The anchor paragraph
    is preserved (it contains the date and greeting).
    """
    anchor = _find_paragraph_with_tag(doc, tag)
    if anchor is None:
        return False

    anchor_xml = anchor._p

    # Find the specific run that contains the tag
    tag_run = None
    tag_run_idx = None
    for idx, r in enumerate(anchor_xml.findall(qn("w:r"))):
        t_el = r.find(qn("w:t"))
        if t_el is not None and t_el.text and tag in t_el.text:
            tag_run = r
            tag_run_idx = idx
            break

    if tag_run is None:
        return False

    # Remove the tag text from the run
    t_el = tag_run.find(qn("w:t"))
    t_el.text = t_el.text.replace(tag, "")

    # Remove any trailing <w:br> elements after the tag run (they were separating
    # the tag from the next content, which is now gone)
    all_children = list(anchor_xml)
    pPr = anchor_xml.find(qn("w:pPr"))
    runs_and_brs = [c for c in all_children if c is not pPr] if pPr is not None else list(all_children)

    # Find elements after the tag run and remove trailing breaks/empty runs
    found_tag = False
    to_remove = []
    for child in runs_and_brs:
        if child is tag_run:
            found_tag = True
            # If the tag run is now empty, remove it too
            if not (t_el.text and t_el.text.strip()):
                to_remove.append(child)
            continue
        if found_tag:
            # Remove trailing breaks and empty runs after tag
            if child.tag == qn("w:r"):
                has_br = child.find(qn("w:br")) is not None
                has_text = False
                for sub_t in child.findall(qn("w:t")):
                    if sub_t.text and sub_t.text.strip():
                        has_text = True
                if has_br and not has_text:
                    to_remove.append(child)
                else:
                    break
            else:
                break

    for el in to_remove:
        anchor_xml.remove(el)

    # Insert body paragraphs after the anchor
    cursor = anchor_xml
    for new_p in body_paragraphs:
        cursor.addnext(new_p)
        cursor = new_p

    return True


# ── Resume content builders ───────────────────────────────────────────────

def _build_skills_elements(skills: list[dict], anchor_p) -> list[OxmlElement]:
    """Build <w:p> elements for the skills section, cloning formatting from anchor."""
    rPr_tpl = _get_template_rPr(anchor_p)
    result = []
    for item in skills:
        cat = item.get("category", "")
        vals = item.get("skills", "")
        runs = [
            _make_run(f"{cat}: ", rPr_tpl, bold=True),
            *_runs_from_marked_text(vals, rPr_tpl),
        ]
        result.append(_make_paragraph_from_anchor(anchor_p, runs))
    return result


def _build_experience_elements(
    exp: dict,
    anchor_p,
    project_header_p=None,
) -> list[OxmlElement]:
    """Build <w:p> elements for a single company's experience block.

    *anchor_p*: the ``{{EXP_N}}`` paragraph XML — used for body/bullet formatting.
    *project_header_p*: the ``PROJECT: …`` paragraph XML from the template — used for
        the "PROJECT:" header line formatting.  When None, falls back to anchor_p.

    Produces: PROJECT header, description paragraph, 'Key Contributions:' label,
    then bullet paragraphs.
    """
    rPr_tpl = _get_template_rPr(anchor_p)
    header_p_ref = project_header_p if project_header_p is not None else anchor_p
    paragraphs: list[OxmlElement] = []

    project_name = exp.get("project_name")
    if project_name and project_name not in ("None", "null"):
        header_rPr = _get_template_rPr(header_p_ref)
        p = OxmlElement("w:p")
        _clone_pPr(header_p_ref, p)
        p.append(_make_run("PROJECT:", header_rPr, bold=True))
        p.append(_make_run(f" {project_name}", header_rPr, bold=False))
        paragraphs.append(p)

    desc = exp.get("project_description", "")
    if desc:
        p = _make_paragraph_from_anchor(anchor_p, _runs_from_marked_text(desc, rPr_tpl))
        paragraphs.append(p)

    bullets = exp.get("bullets", [])
    if bullets:
        label_p = _make_paragraph_from_anchor(anchor_p, [
            _make_run("Key Contributions:", rPr_tpl, bold=False),
        ])
        paragraphs.append(label_p)

        for bullet_text in bullets:
            bullet_runs = _runs_from_marked_text(str(bullet_text), rPr_tpl, prefix="• ")
            bp = _make_paragraph_from_anchor(anchor_p, bullet_runs)
            paragraphs.append(bp)

    return paragraphs


def _clean_leftover_exp_placeholders(doc: Document) -> None:
    """Clear any unreplaced {{EXP_N}} placeholder text (replace with empty).

    We keep the paragraph element so the surrounding company header tables and
    spacing are not disrupted — only the tag text itself is removed.
    """
    pattern = re.compile(r"\{\{EXP_\d+\}\}")
    for p in doc.paragraphs:
        for run in p.runs:
            if pattern.search(run.text):
                run.text = pattern.sub("", run.text)


# ── Public API ─────────────────────────────────────────────────────────────

def fill_resume_template(
    template_path: Path,
    output_path: Path,
    tailored: dict[str, Any],
) -> Path:
    """Fill resume template with tailored content and save to *output_path*."""
    doc = Document(str(template_path))

    # Profile summary — simple inline replacement
    summary = tailored.get("profile_summary", "")
    anchor = _find_paragraph_with_tag(doc, "{{PROFILE_SUMMARY}}")
    if anchor:
        _set_paragraph_marked_text(anchor, summary, tag="{{PROFILE_SUMMARY}}")

    # Technical skills — replace with multiple skill-category paragraphs
    skills = tailored.get("technical_skills", [])
    if skills:
        skills_anchor = _find_paragraph_with_tag(doc, "{{SKILLS_CONTENT}}")
        if skills_anchor:
            elements = _build_skills_elements(skills, skills_anchor._p)
            _replace_tag_with_paragraphs(doc, "{{SKILLS_CONTENT}}", elements)

    # Capture the PROJECT: header paragraph XML as a formatting template.
    # The template has a fixed "PROJECT: ..." line before {{EXP_1}} — we clone
    # its formatting for all other companies' PROJECT headers.
    project_header_ref = None
    for p in doc.paragraphs:
        full = "".join(run.text for run in p.runs)
        if full.strip().startswith("PROJECT:"):
            project_header_ref = p._p
            break

    # Work experience — replace each {{EXP_N}} placeholder
    experience = tailored.get("work_experience", [])
    for idx, exp in enumerate(experience, start=1):
        tag = "{{" + f"EXP_{idx}" + "}}"
        exp_anchor = _find_paragraph_with_tag(doc, tag)
        if exp_anchor:
            if idx == 1 and project_header_ref is not None:
                # EXP_1: the template already has a PROJECT: line — update it
                # with the AI project name, then fill the body without a header.
                project_name = exp.get("project_name")
                if project_name and project_name not in ("None", "null"):
                    for run in Paragraph(project_header_ref, None).runs:
                        full = run.text
                        if full.strip().startswith("PROJECT:"):
                            continue
                        if full.strip() and not full.strip().startswith("PROJECT"):
                            run.text = project_name
                            break

                # Build body (no project header — template has it)
                rPr_tpl = _get_template_rPr(exp_anchor._p)
                body_elements: list[OxmlElement] = []

                desc = exp.get("project_description", "")
                if desc:
                    body_elements.append(_make_paragraph_from_anchor(
                        exp_anchor._p, _runs_from_marked_text(desc, rPr_tpl)
                    ))

                bullets = exp.get("bullets", [])
                if bullets:
                    body_elements.append(_make_paragraph_from_anchor(
                        exp_anchor._p, [_make_run("Key Contributions:", rPr_tpl)]
                    ))
                    for bt in bullets:
                        body_elements.append(_make_paragraph_from_anchor(
                            exp_anchor._p, _runs_from_marked_text(str(bt), rPr_tpl, prefix="• ")
                        ))

                if body_elements:
                    _replace_tag_with_paragraphs(doc, tag, body_elements)
                else:
                    _replace_inline_tag(exp_anchor, tag, "")
            else:
                elements = _build_experience_elements(
                    exp, exp_anchor._p, project_header_ref
                )
                if elements:
                    _replace_tag_with_paragraphs(doc, tag, elements)
                else:
                    _replace_inline_tag(exp_anchor, tag, "")

    _clean_leftover_exp_placeholders(doc)

    doc.save(str(output_path))
    logger.info("resume_docx_created", path=str(output_path))
    return output_path


def fill_cover_letter_template(
    template_path: Path,
    output_path: Path,
    cover_letter_body: str,
    *,
    context: dict[str, Any] | None = None,
) -> Path:
    """Fill cover letter template with profile/job placeholders and generated body.

    The template typically has a paragraph containing:
        Dear Hiring Manager,<br><br>{{COVER_LETTER_BODY}}
    We split {{COVER_LETTER_BODY}} into separate paragraphs inserted after
    the anchor, preserving the greeting.
    """
    doc = Document(str(template_path))

    if context:
        from app.services.cover_letter_template_service import build_cover_letter_tag_map

        tag_map = build_cover_letter_tag_map(context)
        for tag, value in sorted(tag_map.items(), key=lambda item: len(item[0]), reverse=True):
            replace_tag_in_document(doc, tag, value)

    body_parts = [p.strip() for p in cover_letter_body.split("\n\n") if p.strip()]
    if body_parts:
        body_anchor = _find_paragraph_with_tag(doc, "{{COVER_LETTER_BODY}}")
        if body_anchor:
            rPr_tpl = _get_template_rPr(body_anchor._p)
            body_elements = []
            for part in body_parts:
                p = OxmlElement("w:p")
                _clone_pPr(body_anchor._p, p)
                p.append(_make_run(part, rPr_tpl))
                body_elements.append(p)
            _split_anchor_around_tag(doc, "{{COVER_LETTER_BODY}}", body_elements)

    doc.save(str(output_path))
    logger.info("cover_letter_docx_created", path=str(output_path))
    return output_path


def _find_libreoffice() -> str | None:
    settings = get_settings()
    if settings.libreoffice_path:
        p = Path(settings.libreoffice_path)
        if p.exists():
            return str(p)

    candidates = [shutil.which("soffice"), shutil.which("libreoffice")]
    if platform.system() == "Windows":
        candidates.extend([
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ])
    for c in candidates:
        if c and Path(c).exists():
            return str(c)
    return None


def convert_docx_to_pdf(docx_path: Path, pdf_path: Path) -> Path:
    """Convert DOCX to PDF using LibreOffice headless."""
    libre = _find_libreoffice()
    if not libre:
        raise RuntimeError("LibreOffice not found. Install LibreOffice or set LIBREOFFICE_PATH.")

    if pdf_path.exists():
        pdf_path.unlink()

    outdir = pdf_path.parent
    cmd = [libre, "--headless", "--convert-to", "pdf", "--outdir", str(outdir), str(docx_path)]

    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"LibreOffice conversion failed: {e.stderr}") from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("LibreOffice conversion timed out after 120s") from e

    produced = outdir / f"{docx_path.stem}.pdf"
    if not produced.exists():
        raise RuntimeError("LibreOffice finished but PDF was not produced")

    if produced.resolve() != pdf_path.resolve():
        if pdf_path.exists():
            pdf_path.unlink()
        produced.replace(pdf_path)

    logger.info("pdf_created", path=str(pdf_path))
    return pdf_path


def build_output_directory(
    first_name: str,
    last_name: str,
    company_name: str,
    position_title: str,
) -> Path:
    """Create the output directory for resume files."""
    settings = get_settings()
    root = Path(settings.resume_output_root)

    person_dir = f"{first_name}_{last_name}".strip("_") or "Unknown"
    now = datetime.now()
    timestamp = now.strftime("%Y-%m-%d_%H-%M")
    company_clean = re.sub(r"[^\w\s-]", "", company_name or "Unknown").strip().replace(" ", "_")[:50]
    position_clean = re.sub(r"[^\w\s-]", "", position_title or "Unknown").strip().replace(" ", "_")[:50]
    job_dir = f"{timestamp}_{company_clean}_{position_clean}"

    full_path = root / person_dir / job_dir
    full_path.mkdir(parents=True, exist_ok=True)
    return full_path
