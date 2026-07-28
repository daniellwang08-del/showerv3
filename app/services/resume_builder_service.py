"""
Resume & cover letter document builder.

Opens user-designed DOCX templates, replaces placeholder tags with AI-tailored
content, and converts to PDF via the pure-Python ``dxpdf`` engine (no external
LibreOffice / MS Office binary required).

Placeholders recognised in the resume template:
  {{PROFILE_SUMMARY}}  - single paragraph replacement
  {{SKILLS_CONTENT}}   - replaced by N skill-category rows
  {{EXP_1}} … {{EXP_N}} - replaced by per-company experience blocks

Placeholders recognised in the cover letter template:
  {{COVER_LETTER_BODY}} - AI-generated body only; all letterhead, greeting, and signature
  are fixed text in the user's uploaded template.
"""

from __future__ import annotations

import re
import shutil
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from docx.text.paragraph import Paragraph
from lxml import etree

from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.docx_structure import iter_document_paragraphs
from app.utils.resume_text_format import parse_inline_markup

logger = get_logger(__name__)

WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
COVER_LETTER_BODY_TAG = "{{COVER_LETTER_BODY}}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def _w(tag: str) -> str:
    return f"{{{WNS}}}{tag}"


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
    size_pt: float | None = None,
) -> list[OxmlElement]:
    """Build Word runs from text that may contain ``**bold**`` / ``*italic*`` /
    ``__underline__`` markers (shared with the live preview)."""
    segments = parse_inline_markup(text or "")
    runs: list[OxmlElement] = []
    if prefix:
        runs.append(_make_run(prefix, rPr_template, bold=False, size_pt=size_pt))
    for seg in segments:
        if not seg.text:
            continue
        runs.append(
            _make_run(
                seg.text,
                rPr_template,
                bold=seg.bold,
                size_pt=size_pt,
                italic=seg.italic,
                underline=seg.underline,
            )
        )
    if not runs and prefix:
        runs.append(_make_run(prefix, rPr_template, bold=False, size_pt=size_pt))
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


def _apply_italic_underline(rPr: OxmlElement, italic: bool, underline: bool) -> None:
    """Add/remove ``<w:i>``/``<w:iCs>`` and ``<w:u>`` on a run-properties element."""
    for tag_name in ("w:i", "w:iCs"):
        for el in rPr.findall(qn(tag_name)):
            rPr.remove(el)
    if italic:
        rPr.append(OxmlElement("w:i"))
        rPr.append(OxmlElement("w:iCs"))
    for el in rPr.findall(qn("w:u")):
        rPr.remove(el)
    if underline:
        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rPr.append(u)


def _make_run(
    text: str,
    rPr_template: OxmlElement | None = None,
    bold: bool = False,
    size_pt: float | None = None,
    italic: bool = False,
    underline: bool = False,
) -> OxmlElement:
    """Create a <w:r> element with text and optional formatting."""
    r = OxmlElement("w:r")
    new_rPr = None
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
    elif bold or size_pt is not None or italic or underline:
        new_rPr = OxmlElement("w:rPr")
        if bold:
            new_rPr.append(OxmlElement("w:b"))
            new_rPr.append(OxmlElement("w:bCs"))
    if new_rPr is not None and (italic or underline):
        _apply_italic_underline(new_rPr, italic, underline)
    if new_rPr is not None and size_pt is not None:
        for tag_name in ("w:sz", "w:szCs"):
            for el in new_rPr.findall(qn(tag_name)):
                new_rPr.remove(el)
        half = str(int(round(size_pt * 2)))
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), half)
        new_rPr.append(sz)
        szCs = OxmlElement("w:szCs")
        szCs.set(qn("w:val"), half)
        new_rPr.append(szCs)
    if new_rPr is not None:
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


def _set_para_space_before(p, pts: float) -> None:
    """Force space-before (in points) on a built ``<w:p>``, overriding any spacing
    inherited from the anchor paragraph. Used to add a small, controlled gap (a few
    points) instead of a full blank line."""
    pPr = p.find(qn("w:pPr"))
    if pPr is None:
        pPr = OxmlElement("w:pPr")
        p.insert(0, pPr)
    spacing = pPr.find(qn("w:spacing"))
    if spacing is None:
        spacing = OxmlElement("w:spacing")
        pPr.append(spacing)
    spacing.set(qn("w:before"), str(int(round(pts * 20))))
    spacing.set(qn("w:beforeAutospacing"), "0")


def _set_para_space_after(p, pts: float) -> None:
    """Force space-after (in points) on a built ``<w:p>``, overriding any spacing
    inherited from the anchor paragraph. Lets a section's per-row gap match the live
    preview's CSS ``margin-bottom`` instead of the template's default section spacing."""
    pPr = p.find(qn("w:pPr"))
    if pPr is None:
        pPr = OxmlElement("w:pPr")
        p.insert(0, pPr)
    spacing = pPr.find(qn("w:spacing"))
    if spacing is None:
        spacing = OxmlElement("w:spacing")
        pPr.append(spacing)
    spacing.set(qn("w:after"), str(int(round(pts * 20))))
    spacing.set(qn("w:afterAutospacing"), "0")


def _metric(metrics: dict | None, field: str, fallback: float) -> float:
    """Realized gap (pt) for a body role, measured from the browser preview and shipped
    in ``tailored['layout_metrics']``. The preview is the single source of truth for
    spacing; *fallback* is used only when the design has not been measured yet."""
    if isinstance(metrics, dict):
        value = metrics.get(field)
        if isinstance(value, (int, float)):
            return float(value)
    return float(fallback)


# ── Placeholder replacement logic ──────────────────────────────────────────

def _find_paragraph_with_tag(doc: Document, tag: str) -> Paragraph | None:
    """Find the first paragraph whose combined run text contains *tag*."""
    for p in iter_document_paragraphs(doc):
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
    (unless cleanup_anchor is False - used when the anchor has other content to keep).
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

_SKILLS_SPLIT_RE = re.compile(r"[,;|\n]+")


def _split_skill_values(s: str) -> list[str]:
    return [x.strip() for x in _SKILLS_SPLIT_RE.split(s or "") if x.strip()]


def _tint_hex(value: str | None, keep: float) -> str:
    """Blend *value* toward white (keep=fraction of original retained)."""
    v = (value or "#000000").lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    try:
        r, g, b = int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except Exception:
        return "f1f5f9"
    r = round(255 * (1 - keep) + r * keep)
    g = round(255 * (1 - keep) + g * keep)
    b = round(255 * (1 - keep) + b * keep)
    return f"{r:02x}{g:02x}{b:02x}"


def _rpr_base_pt(rPr_template: OxmlElement | None, fallback: float = 10.5) -> float:
    """Read the base font size (pt) from a template ``<w:rPr>`` (``w:sz`` is half-points).

    The skills/used-skills elements clone the anchor paragraph's run properties, so the
    anchor's size *is* the body base size. We scale from it to mirror the preview's
    per-element ratios (caps category 0.92, badge 0.8, chips 0.9, …)."""
    if rPr_template is not None:
        sz = rPr_template.find(qn("w:sz"))
        if sz is not None:
            try:
                return int(sz.get(qn("w:val"))) / 2.0
            except (TypeError, ValueError):
                pass
    return fallback


def _styled_run(
    text: str,
    rPr_template: OxmlElement | None,
    *,
    bold: bool = False,
    caps: bool = False,
    color_hex: str | None = None,
    fill_hex: str | None = None,
    size_pt: float | None = None,
) -> OxmlElement:
    """A <w:r> with optional bold, caps, font color, background shading and font size."""
    r = OxmlElement("w:r")
    rPr = deepcopy(rPr_template) if rPr_template is not None else OxmlElement("w:rPr")
    remove_tags = ["w:b", "w:bCs", "w:caps", "w:color", "w:shd"]
    if size_pt is not None:
        remove_tags += ["w:sz", "w:szCs"]
    for tag_name in remove_tags:
        for el in rPr.findall(qn(tag_name)):
            rPr.remove(el)
    if size_pt is not None:
        half = str(int(round(size_pt * 2)))
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), half)
        rPr.append(sz)
        szCs = OxmlElement("w:szCs")
        szCs.set(qn("w:val"), half)
        rPr.append(szCs)
    if bold:
        rPr.insert(0, OxmlElement("w:b"))
        rPr.append(OxmlElement("w:bCs"))
    if caps:
        rPr.append(OxmlElement("w:caps"))
    if color_hex:
        col = OxmlElement("w:color")
        col.set(qn("w:val"), color_hex.lstrip("#"))
        rPr.append(col)
    if fill_hex:
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), fill_hex.lstrip("#"))
        rPr.append(shd)
    r.append(rPr)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    r.append(t)
    return r


def _category_runs(
    cat: str,
    rPr_tpl: OxmlElement | None,
    cat_style: str,
    accent: str | None,
    heading: str | None,
) -> list[OxmlElement]:
    # Mirror the preview's catLabel font sizes (ResumePreview.tsx): caps 0.92, badge 0.8,
    # everything else stays at the body base size.
    base_pt = _rpr_base_pt(rPr_tpl)
    if cat_style == "caps":
        return [_styled_run(cat.upper(), rPr_tpl, bold=True, color_hex=heading, size_pt=base_pt * 0.92)]
    if cat_style == "accent":
        return [_styled_run(cat, rPr_tpl, bold=True, color_hex=accent or heading)]
    if cat_style == "badge":
        return [_styled_run(f"  {cat.upper()}  ", rPr_tpl, bold=True, color_hex="#ffffff", fill_hex=accent or "334155", size_pt=base_pt * 0.8)]
    if cat_style == "bar":
        runs: list[OxmlElement] = []
        runs.append(_styled_run("\u258f ", rPr_tpl, bold=True, color_hex=accent or heading))
        runs.append(_styled_run(cat, rPr_tpl, bold=True, color_hex=heading))
        return runs
    return [_styled_run(cat, rPr_tpl, bold=True, color_hex=heading)]


def _build_skills_elements(
    skills: list[dict],
    anchor_p,
    style: dict | None = None,
    colors: dict | None = None,
    metrics: dict | None = None,
) -> list[OxmlElement]:
    """Build <w:p> elements for the skills section, cloning formatting from anchor.

    Each skill in a category is split into its own structured unit; the SkillsStyle
    *style* controls the layout (inline / stacked / bullets / chips / pipe / grid),
    category-label treatment and chip shading so the .docx matches the live preview.
    """
    rPr_tpl = _get_template_rPr(anchor_p)
    style = style or {}
    colors = colors or {}
    layout = style.get("layout", "inline")
    if layout == "bullets":  # one-term-per-line lists were dropped; render as chips
        layout = "chips"
    cat_style = style.get("category", "bold")
    accent_chips = bool(style.get("accent_chips"))
    accent = (colors.get("accent") or "").strip() or None
    heading = (colors.get("heading") or "").strip() or None
    text_col = (colors.get("text") or "").strip() or None

    # The live preview wraps every skill category in a div with a fixed bottom margin
    # (3px when the skills have no surface/chip background, else 5px) and gives each
    # inner <p> margin:0. The .docx anchor paragraph instead carries the template's
    # section spacing (section_gap/2), so the inter-row gap rendered larger than the
    # preview. Mirror the preview's per-row margins exactly (px -> pt at 72/96).
    surface = style.get("surface", "none")
    PX_TO_PT = 72.0 / 96.0
    # Gap *before* each category row (owned by space-before; space-after stays 0 so Word's
    # non-collapsing margins never double a gap). Measured from the preview, with the
    # surface-dependent CSS margin as the fallback. The first row's gap is the
    # heading->content gap, owned by the section heading, so it stays 0 here.
    row_gap_pt = _metric(metrics, "skill_row_pt", (3.0 if surface == "none" else 5.0) * PX_TO_PT)
    stacked_label_gap_pt = 2.0 * PX_TO_PT  # preview cat label marginBottom: 2px
    chips_label_gap_pt = 3.0 * PX_TO_PT    # preview cat label marginBottom: 3px

    result: list[OxmlElement] = []
    emitted_rows = 0
    for item in skills:
        cat = (item.get("category") or "").strip()
        vals = _split_skill_values(item.get("skills") or "")
        if not vals and not cat:
            continue
        cat_runs = _category_runs(cat, rPr_tpl, cat_style, accent, heading) if cat else []
        cat_paras: list[OxmlElement] = []

        if layout in ("inline", "pipe", "grid"):
            sep = "  |  " if layout == "pipe" else ", "
            runs = list(cat_runs)
            if cat:
                runs.append(_make_run(" " if cat_style == "badge" else ": ", rPr_tpl))
            runs.extend(_runs_from_marked_text(sep.join(vals), rPr_tpl))
            cat_paras.append(_make_paragraph_from_anchor(anchor_p, runs))
        elif layout == "stacked":
            if cat:
                lbl = _make_paragraph_from_anchor(anchor_p, cat_runs)
                _set_para_space_after(lbl, stacked_label_gap_pt)
                cat_paras.append(lbl)
            cat_paras.append(_make_paragraph_from_anchor(anchor_p, _runs_from_marked_text(", ".join(vals), rPr_tpl)))
        elif layout == "chips":
            if cat:
                lbl = _make_paragraph_from_anchor(anchor_p, cat_runs)
                _set_para_space_after(lbl, chips_label_gap_pt)
                cat_paras.append(lbl)
            fill = _tint_hex(accent, 0.14) if (accent_chips and accent) else "eef2f7"
            chip_color = accent if (accent_chips and accent) else text_col
            chip_pt = _rpr_base_pt(rPr_tpl) * 0.9  # preview chip fontSize == base * 0.9
            chip_runs: list[OxmlElement] = []
            for i, sk in enumerate(vals):
                if i:
                    chip_runs.append(_make_run("  ", rPr_tpl))
                chip_runs.append(_styled_run(f"  {sk}  ", rPr_tpl, color_hex=chip_color, fill_hex=fill, size_pt=chip_pt))
            cat_paras.append(_make_paragraph_from_anchor(anchor_p, chip_runs))
        else:
            runs = list(cat_runs)
            if cat:
                runs.append(_make_run(": ", rPr_tpl))
            runs.extend(_runs_from_marked_text(", ".join(vals), rPr_tpl))
            cat_paras.append(_make_paragraph_from_anchor(anchor_p, runs))

        if cat_paras:
            # Row owns the gap above it; the very first row inherits the heading gap (0).
            _set_para_space_before(cat_paras[0], 0.0 if emitted_rows == 0 else row_gap_pt)
            _set_para_space_after(cat_paras[-1], 0.0)
            emitted_rows += 1
        result.extend(cat_paras)
    return result


_INLINE_BULLET_RE = re.compile(r"[•▪‣◦∙·●]")
_LINE_BULLET_RE = re.compile(r"^\s*(?:[-*▪‣◦∙·●]|\d+[.)])\s+(.*)$")
_PROJECT_LINE_RE = re.compile(r"^\s*project\s*[:\-\u2013\u2014]\s*", re.IGNORECASE)


def _build_lead_paragraphs(
    lead: str,
    anchor_p,
    rPr_tpl,
    *,
    project_already_rendered: bool,
) -> list[OxmlElement]:
    """Render the experience lead text, putting a ``Project: <title>`` prefix on its
    own line (bold label) and keeping the remaining description as a flowing paragraph.

    The project title and description frequently arrive separated by a newline that
    would otherwise be collapsed into one run-on line; this restores the line break.
    """
    segments = [seg.strip() for seg in (lead or "").split("\n") if seg.strip()]
    if not segments:
        return []

    paragraphs: list[OxmlElement] = []
    start = 0
    first = segments[0]
    looks_like_title = bool(_PROJECT_LINE_RE.match(first)) and (len(segments) > 1 or len(first) <= 80)

    if looks_like_title:
        if project_already_rendered:
            # A PROJECT: line was already emitted from project_name - drop the duplicate.
            start = 1
        else:
            match = _PROJECT_LINE_RE.match(first)
            title = first[match.end():].strip()
            runs = [_make_run("Project: ", rPr_tpl, bold=True)]
            if title:
                runs.extend(_runs_from_marked_text(title, rPr_tpl))
            paragraphs.append(_make_paragraph_from_anchor(anchor_p, runs))
            start = 1

    description = " ".join(segments[start:]).strip()
    if description:
        paragraphs.append(_make_paragraph_from_anchor(anchor_p, _runs_from_marked_text(description, rPr_tpl)))
    return paragraphs


def split_description_and_bullets(text: str) -> tuple[str, list[str]]:
    """Separate a free-form experience description into a lead paragraph and bullets.

    Tailored/profile text frequently arrives as a single blob where individual
    achievements are joined inline with a bullet glyph (``… workloads. • Architected …
    • Built …``) or as newline-prefixed list items. Rendering that verbatim produces
    one giant run-on paragraph. This splits it so each achievement becomes its own
    bullet line while keeping any introductory sentence as the lead.
    """
    s = (text or "").strip()
    if not s:
        return "", []

    if _INLINE_BULLET_RE.search(s):
        segments = [seg.strip(" \t\r\n-\u2013\u2014").strip() for seg in _INLINE_BULLET_RE.split(s)]
        segments = [seg for seg in segments if seg]
        if len(segments) >= 2:
            return segments[0], segments[1:]
        return s, []

    lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
    matches = [_LINE_BULLET_RE.match(ln) for ln in lines]
    if sum(1 for m in matches if m) >= 2:
        lead_lines: list[str] = []
        bullets: list[str] = []
        for ln, m in zip(lines, matches):
            if m:
                bullets.append(m.group(1).strip())
            elif not bullets:
                lead_lines.append(ln)
        return " ".join(lead_lines).strip(), bullets

    return s, []


_EXP_MARKER_GLYPH: dict[str, str] = {
    "dot": "\u2022",
    "dash": "\u2013",
    "arrow": "\u2192",
    "chevron": "\u203A",
    "square": "\u25AA",
    "diamond": "\u25C6",
    "none": "",
}


def _exp_label_runs(label_style: str, rPr_tpl, accent: str | None, heading: str | None) -> list[OxmlElement]:
    text = "Key Contributions:"
    if label_style == "bold":
        return [_styled_run(text, rPr_tpl, bold=True, color_hex=heading)]
    if label_style == "accent":
        return [_styled_run(text, rPr_tpl, bold=True, color_hex=accent or heading)]
    if label_style == "caps":
        return [_styled_run("KEY CONTRIBUTIONS:", rPr_tpl, bold=True, color_hex=heading, size_pt=_rpr_base_pt(rPr_tpl) * 0.92)]
    return [_make_run(text, rPr_tpl, bold=False)]


def _exp_used_skills_paragraphs(
    used_skills: str,
    used_style: str,
    anchor_p,
    rPr_tpl,
    accent: str | None,
    heading: str | None,
    text_col: str | None,
) -> list[OxmlElement]:
    used_skills = (used_skills or "").strip()
    if not used_skills:
        return []
    # Mirror the preview's used-skills font sizes (ResumePreview.tsx): inline 0.92 (muted),
    # label 0.9, chips/pill 0.85.
    base_pt = _rpr_base_pt(rPr_tpl)
    if used_style == "inline":
        inline_pt = base_pt * 0.92
        runs = [_styled_run("Technologies: ", rPr_tpl, bold=True, color_hex=heading, size_pt=inline_pt)]
        runs.extend(_runs_from_marked_text(used_skills, rPr_tpl, size_pt=inline_pt))
        return [_make_paragraph_from_anchor(anchor_p, runs)]
    if used_style == "label":
        label_pt = base_pt * 0.9
        runs = [_styled_run("Tech \u00b7 ", rPr_tpl, bold=True, color_hex=accent or heading, size_pt=label_pt)]
        runs.extend(_runs_from_marked_text(used_skills, rPr_tpl, size_pt=label_pt))
        return [_make_paragraph_from_anchor(anchor_p, runs)]
    # chips / pill - each skill is a shaded segment
    accent_pill = used_style == "pill"
    fill = _tint_hex(accent, 0.16) if (accent_pill and accent) else "eef2f7"
    chip_color = accent if (accent_pill and accent) else text_col
    chip_pt = base_pt * 0.85
    runs: list[OxmlElement] = []
    for sk in _split_skill_values(used_skills):
        runs.append(_styled_run(f"  {sk}  ", rPr_tpl, color_hex=chip_color, fill_hex=fill, size_pt=chip_pt))
        runs.append(_make_run("  ", rPr_tpl))
    if not runs:
        return []
    return [_make_paragraph_from_anchor(anchor_p, runs)]


def _build_experience_body(
    exp: dict,
    anchor_p,
    project_header_p,
    style: dict | None,
    colors: dict | None,
    metrics: dict | None = None,
) -> list[OxmlElement]:
    """Build the body <w:p> elements for one company's experience block: project
    title, intro, 'Key Contributions:' label, contribution bullets and used skills.

    The company / role / date header is rendered separately (at template-compile time
    for builder themes, or carried by the user's own template), so this never emits a
    header. *style* is the ExperienceStyle dict (control board + item styling)."""
    rPr_tpl = _get_template_rPr(anchor_p)
    header_p_ref = project_header_p if project_header_p is not None else anchor_p
    style = style or {}
    colors = colors or {}
    accent = (colors.get("accent") or "").strip() or None
    heading = (colors.get("heading") or "").strip() or None
    text_col = (colors.get("text") or "").strip() or None

    project_style = style.get("project_style", "label")
    show_project = style.get("show_project_title", True)
    intro_style = style.get("intro_style", "plain")
    show_intro = style.get("show_intro", True)
    marker = style.get("marker", "dot")
    label_style = style.get("label_style", "plain")
    show_label = style.get("show_contributions_label", True)
    used_style = style.get("used_skills_style", "inline")
    show_used = style.get("show_used_skills", True)

    paragraphs: list[OxmlElement] = []
    roles: list[str] = []

    def _add(p, role: str) -> None:
        paragraphs.append(p)
        roles.append(role)

    project_name = exp.get("project_name")
    project_rendered = (
        bool(project_name) and project_name not in ("None", "null") and show_project and project_style != "hidden"
    )
    if project_rendered:
        header_rPr = _get_template_rPr(header_p_ref)
        p = OxmlElement("w:p")
        _clone_pPr(header_p_ref, p)
        if project_style == "label":
            p.append(_make_run("PROJECT:", header_rPr, bold=True))
            p.append(_make_run(f" {project_name}", header_rPr, bold=False))
        elif project_style == "accent":
            p.append(_styled_run(project_name, header_rPr, bold=True, color_hex=accent or heading))
        elif project_style == "bold":
            p.append(_styled_run(project_name, header_rPr, bold=True, color_hex=heading))
        else:  # italic degrades to plain in DOCX
            p.append(_make_run(project_name, header_rPr))
        _add(p, "lead")

    lead, inline_bullets = split_description_and_bullets(exp.get("project_description", ""))
    if show_intro and intro_style != "hidden":
        lead_paragraphs = _build_lead_paragraphs(
            lead, anchor_p, rPr_tpl, project_already_rendered=project_rendered
        )
    else:
        lead_paragraphs = []
    for lp in lead_paragraphs:
        _add(lp, "lead")

    explicit_bullets = [str(b) for b in (exp.get("bullets") or []) if str(b).strip()]
    bullets = [*inline_bullets, *explicit_bullets]
    if bullets:
        if show_label and label_style != "hidden":
            label_p = _make_paragraph_from_anchor(anchor_p, _exp_label_runs(label_style, rPr_tpl, accent, heading))
            _add(label_p, "label")

        for idx, bullet_text in enumerate(bullets, start=1):
            runs: list[OxmlElement] = []
            if marker == "numbered":
                runs.append(_styled_run(f"{idx}. ", rPr_tpl, bold=True, color_hex=accent))
            else:
                glyph = _EXP_MARKER_GLYPH.get(marker, "\u2022")
                if glyph:
                    runs.append(_styled_run(f"{glyph} ", rPr_tpl, bold=True, color_hex=accent))
            runs.extend(_runs_from_marked_text(str(bullet_text), rPr_tpl))
            _add(_make_paragraph_from_anchor(anchor_p, runs), "bullet")

    if show_used and used_style != "hidden":
        for up in _exp_used_skills_paragraphs(
            exp.get("used_skills", ""), used_style, anchor_p, rPr_tpl, accent, heading, text_col
        ):
            _add(up, "used")

    _apply_experience_spacing(paragraphs, roles, metrics)
    return paragraphs


_PX_TO_PT = 72.0 / 96.0
# Measured-manifest field + CSS-margin fallback for the gap *above* each experience
# paragraph role. The .docx reproduces these as ``space_before`` (with ``space_after``
# pinned to 0 on every line), so Word's non-collapsing margins never double a gap and
# the rhythm matches the live preview exactly. The company-to-company gap is owned by
# the next company header's space-before (set at template-compile time from
# ``exp_company_pt``); the last body line therefore just stays at space_after 0.
_EXP_ROLE_GAP: dict[str, tuple[str, float]] = {
    "lead": ("exp_lead_pt", 2.0 * _PX_TO_PT),     # project / description <p margin-top 2px>
    "label": ("exp_label_pt", 3.0 * _PX_TO_PT),   # "Key Contributions:" <p margin-top 3px>
    "bullet": ("exp_bullet_pt", 1.5 * _PX_TO_PT), # bullet row, gap before each line
    "used": ("exp_used_pt", 3.0 * _PX_TO_PT),     # used-skills line <p margin-top 3px>
}
# Uniform body rhythm (pt) for lead / label / bullet lines. Measured per-role gaps from
# 2-col layouts are noisy (cross-column measure noise, wrapped vs single-line rows) and
# produced visibly uneven spacing between consecutive body lines in the PDF.
_UNIFORM_BODY_GAP_PT = 2.0


def _apply_experience_spacing(
    paragraphs: list[OxmlElement], roles: list[str], metrics: dict | None = None
) -> None:
    """Pin each experience paragraph's gap to a stable body rhythm.

    Every line owns the gap *above* it via ``space_before`` and carries ``space_after``
    0, so Word's non-collapsing margins never double a gap. Lead / label / bullet rows
    share one uniform gap so contribution lists stay evenly spaced; only the used-skills
    line keeps its measured/fallback gap (it's a distinct footer row, not body copy).
    """
    if not paragraphs:
        return
    for p, role in zip(paragraphs, roles):
        if role in ("lead", "label", "bullet"):
            _set_para_space_before(p, _UNIFORM_BODY_GAP_PT)
        else:
            field, fallback = _EXP_ROLE_GAP.get(role, ("exp_bullet_pt", 1.5 * _PX_TO_PT))
            raw = _metric(metrics, field, fallback)
            # Clamp noisy measured gaps so a bad 2-col manifest cannot stretch body lines.
            _set_para_space_before(p, max(0.0, min(raw, 8.0)))
        _set_para_space_after(p, 0.0)


def _build_experience_elements(
    exp: dict,
    anchor_p,
    project_header_p=None,
    style: dict | None = None,
    colors: dict | None = None,
    metrics: dict | None = None,
) -> list[OxmlElement]:
    """Style-aware body builder for one company's ``{{EXP_N}}`` block.

    Kept as a thin wrapper around :func:`_build_experience_body` for backward
    compatibility with callers that do not pass a style.
    """
    return _build_experience_body(exp, anchor_p, project_header_p, style, colors, metrics)


def _clean_leftover_exp_placeholders(doc: Document) -> None:
    """Clear any unreplaced {{EXP_N}} placeholder text (replace with empty).

    We keep the paragraph element so the surrounding company header tables and
    spacing are not disrupted - only the tag text itself is removed.
    """
    pattern = re.compile(r"\{\{EXP_\d+\}\}")
    # Walk body *and* table cells / headers - two-column layouts render the experience
    # section inside a table cell, where doc.paragraphs would miss the leftover tag.
    for p in iter_document_paragraphs(doc):
        for run in p.runs:
            if pattern.search(run.text):
                run.text = pattern.sub("", run.text)


# ── Layout-preserving DOCX serialization ───────────────────────────────────

RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
HEADER_REL_TYPE = f"{OFFICE_REL_NS}/header"
FOOTER_REL_TYPE = f"{OFFICE_REL_NS}/footer"


def _read_template_header_footer_rids(template_path: Path) -> set[str]:
    """Return the set of rIds in the template that legitimately point to a
    real ``word/header*.xml`` or ``word/footer*.xml`` part. Any other
    header/footer reference in the modified output is a phantom one injected
    by python-docx that must be stripped to avoid layout shifts.
    """
    try:
        with zipfile.ZipFile(template_path, "r") as zf:
            try:
                rels_xml = zf.read("word/_rels/document.xml.rels")
            except KeyError:
                return set()
    except zipfile.BadZipFile:
        return set()

    root = etree.fromstring(rels_xml)
    rids: set[str] = set()
    for rel in root.findall(f"{{{RELS_NS}}}Relationship"):
        rel_type = rel.get("Type")
        if rel_type in (HEADER_REL_TYPE, FOOTER_REL_TYPE):
            rid = rel.get("Id")
            if rid:
                rids.add(rid)
    return rids


def _strip_phantom_header_footer_refs(root: etree._Element, allowed_rids: set[str]) -> None:
    """Remove ``<w:headerReference>`` / ``<w:footerReference>`` entries whose
    ``r:id`` is not in *allowed_rids*. These are the phantom references
    python-docx injects on save - keeping only ones the user truly authored.
    """
    rid_attr = f"{{{OFFICE_REL_NS}}}id"
    for ref_tag in (_w("headerReference"), _w("footerReference")):
        for ref in root.iter(ref_tag):
            rid = ref.get(rid_attr)
            if rid not in allowed_rids:
                parent = ref.getparent()
                if parent is not None:
                    parent.remove(ref)


def _save_docx_preserving_template_layout(
    doc: Document,
    template_path: Path,
    output_path: Path,
) -> None:
    """Write *doc* to *output_path* without inheriting python-docx's package mutations.

    ``python-docx`` rewrites the full DOCX package on ``doc.save()`` and
    auto-injects empty ``<w:headerReference>``/``<w:footerReference>`` entries
    into every ``<w:sectPr>`` plus phantom ``word/header*.xml`` /
    ``word/footer*.xml`` files into the archive. Word/LibreOffice then
    reserves header/footer space on every page even though those files are
    empty - pushing the body content down and visibly shifting the user's
    designed layout.

    Strategy:
      1. Serialize the in-memory document (with all placeholder replacements)
         using lxml so we keep the modified body content but skip
         ``doc.save()`` entirely (avoiding package-level mutations).
      2. Strip any ``<w:headerReference>`` / ``<w:footerReference>`` whose
         ``r:id`` does NOT correspond to a real header/footer relationship in
         the original template's ``word/_rels/document.xml.rels``. Genuine
         user-authored references are preserved.
      3. Copy the original template file byte-for-byte to *output_path*
         (preserves ``[Content_Types].xml``, all ``word/_rels``, fonts,
         styles, images, theme, custom XML, and any real header/footer files).
      4. Replace ONLY ``word/document.xml`` inside that zip with the cleaned
         XML so no package-level metadata or phantom parts leak through.
    """
    new_root_xml = etree.tostring(doc.element)
    new_root = etree.fromstring(new_root_xml)
    if new_root.find(_w("body")) is None:
        raise RuntimeError("Modified resume document is missing <w:body>.")

    allowed_rids = _read_template_header_footer_rids(template_path)
    _strip_phantom_header_footer_refs(new_root, allowed_rids)

    final_xml = etree.tostring(
        new_root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
    )

    shutil.copy2(template_path, output_path)
    _replace_docx_internal(output_path, "word/document.xml", final_xml)


# ── Public API ─────────────────────────────────────────────────────────────

def fill_resume_template(
    template_path: Path,
    output_path: Path,
    tailored: dict[str, Any],
) -> Path:
    """Fill resume template with tailored content and save to *output_path*."""
    doc = Document(str(template_path))

    # Browser-measured per-role body gaps (pt); the single source of truth for spacing.
    layout_metrics = tailored.get("layout_metrics")

    # Profile summary - simple inline replacement
    summary = tailored.get("profile_summary", "")
    anchor = _find_paragraph_with_tag(doc, "{{PROFILE_SUMMARY}}")
    if anchor:
        _set_paragraph_marked_text(anchor, summary, tag="{{PROFILE_SUMMARY}}")

    # Technical skills - replace with multiple skill-category paragraphs
    skills = tailored.get("technical_skills", [])
    if skills:
        skills_anchor = _find_paragraph_with_tag(doc, "{{SKILLS_CONTENT}}")
        if skills_anchor:
            elements = _build_skills_elements(
                skills, skills_anchor._p, tailored.get("skills_style"), tailored.get("colors"), layout_metrics
            )
            _replace_tag_with_paragraphs(doc, "{{SKILLS_CONTENT}}", elements)

    # Capture the PROJECT: header paragraph XML as a formatting template.
    # The template has a fixed "PROJECT: ..." line before {{EXP_1}} - we clone
    # its formatting for all other companies' PROJECT headers.
    project_header_ref = None
    for p in doc.paragraphs:
        full = "".join(run.text for run in p.runs)
        if full.strip().startswith("PROJECT:"):
            project_header_ref = p._p
            break

    # Work experience - replace each {{EXP_N}} placeholder
    experience = tailored.get("work_experience", [])
    exp_style = tailored.get("experience_style")
    exp_colors = tailored.get("colors")
    for idx, exp in enumerate(experience, start=1):
        tag = "{{" + f"EXP_{idx}" + "}}"
        exp_anchor = _find_paragraph_with_tag(doc, tag)
        if exp_anchor:
            if idx == 1 and project_header_ref is not None:
                # EXP_1: the template already has a PROJECT: line - update it with the
                # AI project name, then fill the body without re-rendering the project.
                project_name = exp.get("project_name")
                if project_name and project_name not in ("None", "null"):
                    for run in Paragraph(project_header_ref, None).runs:
                        full = run.text
                        if full.strip().startswith("PROJECT:"):
                            continue
                        if full.strip() and not full.strip().startswith("PROJECT"):
                            run.text = project_name
                            break

                # Project header is owned by the template here, so suppress it in the body.
                body_style = {**(exp_style or {}), "show_project_title": False}
                body_elements = _build_experience_body(
                    exp, exp_anchor._p, None, body_style, exp_colors, layout_metrics
                )
                if body_elements:
                    _replace_tag_with_paragraphs(doc, tag, body_elements)
                else:
                    _replace_inline_tag(exp_anchor, tag, "")
            else:
                elements = _build_experience_elements(
                    exp, exp_anchor._p, project_header_ref, exp_style, exp_colors, layout_metrics
                )
                if elements:
                    _replace_tag_with_paragraphs(doc, tag, elements)
                else:
                    _replace_inline_tag(exp_anchor, tag, "")

    _clean_leftover_exp_placeholders(doc)

    _save_docx_preserving_template_layout(doc, template_path, output_path)
    logger.info("resume_docx_created", path=str(output_path))
    return output_path


def _paragraph_text_from_xml(p_el: etree._Element) -> str:
    return "".join(t.text or "" for t in p_el.iter(_w("t")))


def _iter_document_body_paragraphs(body_el: etree._Element):
    for child in body_el:
        local = child.tag.split("}")[-1]
        if local == "p":
            yield child
        elif local == "tbl":
            for tc in child.iter(_w("tc")):
                for p_el in tc.findall(_w("p")):
                    yield p_el


def _extract_anchor_rpr(p_el: etree._Element) -> etree._Element | None:
    """Return a deep copy of the most representative ``<w:rPr>`` for new runs.

    Preference order:
      1. The ``<w:rPr>`` of the first run that contains visible text in *p_el*.
      2. The ``<w:rPr>`` of any run.
      3. The paragraph-level default run formatting at ``<w:pPr>/<w:rPr>``.
    """
    runs = p_el.findall(_w("r"))
    for r in runs:
        if r.find(_w("t")) is not None:
            rpr = r.find(_w("rPr"))
            if rpr is not None:
                return deepcopy(rpr)
    for r in runs:
        rpr = r.find(_w("rPr"))
        if rpr is not None:
            return deepcopy(rpr)
    p_pr = p_el.find(_w("pPr"))
    if p_pr is not None:
        rpr = p_pr.find(_w("rPr"))
        if rpr is not None:
            return deepcopy(rpr)
    return None


def _clear_paragraph_content(p_el: etree._Element) -> etree._Element | None:
    p_pr = p_el.find(_w("pPr"))
    for child in list(p_el):
        if child is not p_pr:
            p_el.remove(child)
    return p_pr


def _append_text_run(
    p_el: etree._Element,
    text: str,
    rpr_template: etree._Element | None,
) -> None:
    """Append a single ``<w:r><w:t>`` to *p_el* preserving font formatting."""
    if not text:
        return
    run = etree.SubElement(p_el, _w("r"))
    if rpr_template is not None:
        run.append(deepcopy(rpr_template))
    t_el = etree.SubElement(run, _w("t"))
    t_el.set(XML_SPACE, "preserve")
    t_el.text = text


def _append_break(p_el: etree._Element, rpr_template: etree._Element | None) -> None:
    """Append a soft line break (``<w:br/>``) carrying the same run formatting."""
    run = etree.SubElement(p_el, _w("r"))
    if rpr_template is not None:
        run.append(deepcopy(rpr_template))
    etree.SubElement(run, _w("br"))


def _append_text_with_breaks(
    p_el: etree._Element,
    text: str,
    rpr_template: etree._Element | None,
) -> None:
    """Append text where literal ``\\n`` characters become Word soft breaks."""
    if not text:
        return
    lines = text.split("\n")
    for idx, line in enumerate(lines):
        if idx > 0:
            _append_break(p_el, rpr_template)
        if line:
            _append_text_run(p_el, line, rpr_template)


def _make_body_paragraph(
    text: str,
    p_pr: etree._Element | None,
    rpr_template: etree._Element | None,
) -> etree._Element:
    """Build a ``<w:p>`` that inherits paragraph + run formatting from the anchor."""
    new_p = etree.Element(_w("p"))
    if p_pr is not None:
        new_p.insert(0, deepcopy(p_pr))
    _append_text_with_breaks(new_p, text, rpr_template)
    return new_p


def _replace_docx_internal(path: Path, internal: str, data: bytes) -> None:
    tmp_path = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(path, "r") as zin, zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            payload = data if info.filename == internal else zin.read(info.filename)
            zout.writestr(info, payload)
    tmp_path.replace(path)


def _patch_cover_letter_document_xml(document_xml: bytes, body_parts: list[str]) -> bytes:
    root = etree.fromstring(document_xml)
    body_el = root.find(_w("body"))
    if body_el is None:
        raise RuntimeError("Invalid cover letter template: missing document body.")

    tag = COVER_LETTER_BODY_TAG
    anchor: etree._Element | None = None
    for p_el in _iter_document_body_paragraphs(body_el):
        if tag in _paragraph_text_from_xml(p_el):
            anchor = p_el
            break

    if anchor is None:
        raise RuntimeError(
            f"Placeholder {tag} was not found in the document body. "
            "Add it to the main letter area of your template (not only in a text box)."
        )

    full_text = _paragraph_text_from_xml(anchor)
    before, _, after = full_text.partition(tag)

    rpr_template = _extract_anchor_rpr(anchor)
    p_pr = _clear_paragraph_content(anchor)

    prefix = before.rstrip("\n")
    if prefix.strip():
        _append_text_with_breaks(anchor, prefix, rpr_template)

    cursor = anchor
    for part in body_parts:
        new_p = _make_body_paragraph(part, p_pr, rpr_template)
        cursor.addnext(new_p)
        cursor = new_p

    suffix = after.lstrip("\n")
    if suffix.strip():
        cursor.addnext(_make_body_paragraph(suffix, p_pr, rpr_template))

    return etree.tostring(
        root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
    )


def fill_cover_letter_template(
    template_path: Path,
    output_path: Path,
    cover_letter_body: str,
) -> Path:
    """Fill the cover letter template with AI-generated body text only.

    Copies the template byte-for-byte except ``word/document.xml``, so headers,
    footers, drawings, and styles are preserved. Only ``{{COVER_LETTER_BODY}}`` is
    replaced - including when Word split the placeholder across multiple runs.

    The inserted paragraphs inherit the anchor paragraph's run formatting
    (``<w:rPr>``: font family, size, color, language) so the body uses the same
    typography the user designed in their template. Single ``\\n`` characters
    inside a paragraph are emitted as ``<w:br/>`` soft line breaks (used by the
    sign-off block: ``Best regards,\\nFull Name``).
    """
    body_parts = [p.strip("\r ") for p in cover_letter_body.split("\n\n") if p.strip()]
    if not body_parts:
        raise RuntimeError("Cover letter body is empty - nothing to insert into the template.")

    shutil.copy2(template_path, output_path)
    with zipfile.ZipFile(output_path, "r") as zf:
        document_xml = zf.read("word/document.xml")

    patched_xml = _patch_cover_letter_document_xml(document_xml, body_parts)
    _replace_docx_internal(output_path, "word/document.xml", patched_xml)
    logger.info("cover_letter_docx_created", path=str(output_path))
    return output_path


def convert_docx_to_pdf(docx_path: Path, pdf_path: Path) -> Path:
    """Convert DOCX to PDF using the pure-Python ``dxpdf`` package only.

    ``dxpdf`` ships as a self-contained pip wheel (Rust/Skia). No LibreOffice,
    MS Office, or other system binary is used or required.
    """
    import dxpdf  # imported lazily so import cost stays off the hot path

    if pdf_path.exists():
        pdf_path.unlink()

    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        dxpdf.convert_file(str(docx_path), str(pdf_path))
    except Exception as e:  # noqa: BLE001 - surface a clear, engine-specific error
        raise RuntimeError(f"dxpdf conversion failed: {e}") from e

    if not pdf_path.exists() or pdf_path.stat().st_size == 0:
        raise RuntimeError("dxpdf finished but produced no PDF output")

    logger.info("pdf_created", path=str(pdf_path), engine="dxpdf")
    return pdf_path


def safe_path_segment(value: str, *, fallback: str = "Unknown", max_len: int = 80) -> str:
    """Filesystem-safe single path segment (spaces → underscores, strip junk)."""
    cleaned = re.sub(r"[^\w\s-]", "", value or "", flags=re.UNICODE).strip()
    cleaned = re.sub(r"[\s_]+", "_", cleaned).strip("_")
    return (cleaned[:max_len] if cleaned else "") or fallback


def person_document_stem(first_name: str, last_name: str, kind: str = "resume") -> str:
    """Filename stem: ``Zeyu_Wang_resume`` / ``Zeyu_Wang_cover_letter`` (no extension)."""
    name = safe_path_segment(f"{first_name or ''} {last_name or ''}".strip(), fallback="Resume")
    suffix = "cover_letter" if kind == "cover_letter" else "resume"
    return f"{name}_{suffix}"


def person_resume_stem(first_name: str, last_name: str) -> str:
    """Alias for :func:`person_document_stem` with ``kind='resume'``."""
    return person_document_stem(first_name, last_name, "resume")


def build_output_directory(company_name: str) -> Path:
    """Create ``{RESUME_OUTPUT_ROOT}/{Company}/`` for resume artifacts.

    Files inside use ``{First_Last}_resume.pdf`` (see :func:`person_document_stem`).
    """
    settings = get_settings()
    root = Path(settings.resume_output_root)
    company_clean = safe_path_segment(company_name or "Unknown", fallback="Unknown", max_len=80)
    full_path = root / company_clean
    full_path.mkdir(parents=True, exist_ok=True)
    return full_path
