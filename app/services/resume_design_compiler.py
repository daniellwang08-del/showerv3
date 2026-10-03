"""Compile a ResumeDesign into a styled .docx template + matching blueprint.

The generated template carries the same placeholder tags the existing fill engine
understands ({{PROFILE_SUMMARY}}, {{SKILLS_CONTENT}}, {{EXP_1..N}}), so no changes to
``resume_blueprint_renderer`` / ``resume_builder_service`` are needed - the builder
simply *produces* a template instead of requiring the user to upload one.
"""

from __future__ import annotations

import base64
import os
import re
import uuid
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Pt, RGBColor

from app.models.database import User
from app.models.resume_design_schemas import ResumeDesign
from app.models.resume_template_schemas import ResumeTemplateAiValidation, ResumeTemplateBlueprint
from app.services.resume_builder_service import (
    _replace_docx_internal,
    _strip_phantom_header_footer_refs,
    _w,
)
from app.services.resume_context_builder import (
    _format_period,
    _format_phone,
    _full_name,
    _profile_work_rows,
)
from app.utils.flexible_date import format_flexible_date
from app.services.resume_icons import contact_icon_png
from app.services.resume_template_service import _default_blueprint_from_tags, count_work_roles

try:  # pragma: no cover - import guard for lxml
    from lxml import etree
except Exception:  # pragma: no cover
    etree = None  # type: ignore[assignment]

import zipfile

SIDEBAR_SECTIONS = {"skills", "education", "certificates"}

# US Letter page width in EMU (8.5 in × 914_400 EMU/in = 612 pt). Used to place the
# right-aligned date tab stop at the true right text edge so it matches the preview.
_LETTER_WIDTH_EMU = 7_772_400


def _page_usable_emu(design: ResumeDesign) -> int:
    """Full-page content width (page minus left/right margins) in EMU."""
    return max(int(_LETTER_WIDTH_EMU - (design.layout.m_left + design.layout.m_right) * 12_700), 1_000_000)


def _container_usable_emu(container: Any, design: ResumeDesign) -> int:
    """Right-tab stop position for the container being written into.

    In a two-column layout education lives in a ~34% sidebar cell. Using the full-page
    width as the tab stop places the date past the cell edge into the main column, the
    same visual bleed as the preview flex overflow. Prefer the cell width when present.
    """
    full = _page_usable_emu(design)
    width = getattr(container, "width", None)
    if width is None:
        return full
    try:
        # python-docx Length is int-like (EMU). Leave a small inset so the date stays
        # inside the cell padding rather than kissing the border.
        cell_emu = int(width)
    except (TypeError, ValueError):
        return full
    if cell_emu <= 0:
        return full
    return max(int(cell_emu * 0.96), 200_000)

# Bundled OFL font directory (shipped so any render host has the exact face the preview
# uses). Carlito is metric-identical to Calibri and embeds cleanly into the .docx.
_FONT_ASSET_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"

# Designed family -> the bundled face actually rendered, so the preview, the .docx and
# the LibreOffice-rendered PDF all use one identical font (same metrics => same wrapping
# and page breaks). Keyed by lowercase family name.
_FONT_RENDER_MAP = {"calibri": "Carlito", "carlito": "Carlito"}

# Embeddable variants for each rendered family: (style flags) -> TTF filename.
_FONT_EMBED_FILES: dict[str, dict[str, str]] = {
    "Carlito": {
        "regular": "Carlito-Regular.ttf",
        "bold": "Carlito-Bold.ttf",
        "italic": "Carlito-Italic.ttf",
        "bolditalic": "Carlito-BoldItalic.ttf",
    },
}


def _render_font_family(name: str) -> str:
    """Map a designed font family to the bundled face that is actually rendered."""
    return _FONT_RENDER_MAP.get((name or "").strip().lower(), name)


_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
_PR_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_FONT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
_OBFUSCATED_FONT_CT = "application/vnd.openxmlformats-officedocument.obfuscatedFont"
_EMBED_SLOT_TAG = {
    "regular": "embedRegular",
    "bold": "embedBold",
    "italic": "embedItalic",
    "bolditalic": "embedBoldItalic",
}


def _obfuscate_font(data: bytes, key_uuid: uuid.UUID) -> bytes:
    """Apply the ECMA-376 font obfuscation: XOR the first 32 bytes of the TTF with the
    16 GUID bytes (reversed), repeated twice. Symmetric with Word/LibreOffice de-obf."""
    key = key_uuid.bytes[::-1]
    out = bytearray(data)
    for i in range(min(32, len(out))):
        out[i] ^= key[i % 16]
    return bytes(out)


def _embed_fonts(docx_path: Path, families: list[str]) -> None:
    """Embed the bundled variants of *families* into the .docx using Word's obfuscated
    embedded-font format, so every renderer (LibreOffice/Word on any OS, including hosts
    without the font installed) uses the exact same face as the live preview.

    Best-effort and fully guarded: any failure leaves the .docx untouched and valid (it
    still *names* Carlito, which renders correctly wherever the font is present)."""
    if etree is None:
        return
    try:
        plan: list[dict[str, Any]] = []
        for fam in families:
            for slot, fname in _FONT_EMBED_FILES.get(fam, {}).items():
                p = _FONT_ASSET_DIR / fname
                if p.exists():
                    plan.append({"family": fam, "slot": slot, "path": p})
        if not plan:
            return

        with zipfile.ZipFile(docx_path, "r") as zin:
            parts: dict[str, bytes] = {i.filename: zin.read(i.filename) for i in zin.infolist()}

        font_table = parts.get("word/fontTable.xml")
        content_types = parts.get("[Content_Types].xml")
        settings = parts.get("word/settings.xml")
        if font_table is None or content_types is None or settings is None:
            return  # not a standard python-docx package; skip rather than risk corruption

        ft_root = etree.fromstring(font_table)
        rels_raw = parts.get("word/_rels/fontTable.xml.rels")
        if rels_raw is not None:
            rels_root = etree.fromstring(rels_raw)
        else:
            rels_root = etree.Element(f"{{{_PR_NS}}}Relationships")

        existing_ids = {r.get("Id") for r in rels_root}
        next_n = 1

        def new_rid() -> str:
            nonlocal next_n
            while f"rIdFont{next_n}" in existing_ids:
                next_n += 1
            rid = f"rIdFont{next_n}"
            existing_ids.add(rid)
            next_n += 1
            return rid

        # Group variants per family so each family becomes one <w:font> with embeds.
        by_family: dict[str, list[dict[str, Any]]] = {}
        for item in plan:
            by_family.setdefault(item["family"], []).append(item)

        font_idx = 0
        for fam, items in by_family.items():
            # Reuse or create the <w:font w:name="fam"> element.
            font_el = None
            for fe in ft_root.findall(f"{{{_W_NS}}}font"):
                if fe.get(f"{{{_W_NS}}}name") == fam:
                    font_el = fe
                    break
            if font_el is None:
                font_el = etree.SubElement(ft_root, f"{{{_W_NS}}}font")
                font_el.set(f"{{{_W_NS}}}name", fam)

            for slot in ("regular", "bold", "italic", "bolditalic"):
                match = next((it for it in items if it["slot"] == slot), None)
                if not match:
                    continue
                key_uuid = uuid.uuid4()
                font_idx += 1
                part_name = f"word/fonts/font{font_idx}.odttf"
                parts[part_name] = _obfuscate_font(match["path"].read_bytes(), key_uuid)

                rid = new_rid()
                rel = etree.SubElement(rels_root, f"{{{_PR_NS}}}Relationship")
                rel.set("Id", rid)
                rel.set("Type", _FONT_REL_TYPE)
                rel.set("Target", f"fonts/font{font_idx}.odttf")

                embed = etree.SubElement(font_el, f"{{{_W_NS}}}{_EMBED_SLOT_TAG[slot]}")
                embed.set(f"{{{_R_NS}}}id", rid)
                embed.set(f"{{{_W_NS}}}fontKey", "{" + str(key_uuid).upper() + "}")
                embed.set(f"{{{_W_NS}}}subsetted", "false")

        # Tell the consumer to honour embedded fonts.
        set_root = etree.fromstring(settings)
        if set_root.find(f"{{{_W_NS}}}embedTrueTypeFonts") is None:
            embed_flag = etree.Element(f"{{{_W_NS}}}embedTrueTypeFonts")
            set_root.insert(0, embed_flag)

        # Register the obfuscated-font extension in the content types.
        ct_root = etree.fromstring(content_types)
        has_odttf = any(
            d.get("Extension", "").lower() == "odttf" for d in ct_root.findall(f"{{{_CT_NS}}}Default")
        )
        if not has_odttf:
            default = etree.SubElement(ct_root, f"{{{_CT_NS}}}Default")
            default.set("Extension", "odttf")
            default.set("ContentType", _OBFUSCATED_FONT_CT)

        parts["word/fontTable.xml"] = etree.tostring(ft_root, xml_declaration=True, encoding="UTF-8", standalone=True)
        parts["word/_rels/fontTable.xml.rels"] = etree.tostring(rels_root, xml_declaration=True, encoding="UTF-8", standalone=True)
        parts["word/settings.xml"] = etree.tostring(set_root, xml_declaration=True, encoding="UTF-8", standalone=True)
        parts["[Content_Types].xml"] = etree.tostring(ct_root, xml_declaration=True, encoding="UTF-8", standalone=True)

        tmp = docx_path.with_name(docx_path.name + ".fonts.tmp")
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for name, payload in parts.items():
                zout.writestr(name, payload)
        tmp.replace(docx_path)
    except Exception:
        # Never let font embedding break template generation.
        return


def _clean_url(value: str | None) -> str:
    """Strip protocol / www / trailing slash so header links read cleanly."""
    v = (value or "").strip()
    v = re.sub(r"^https?://", "", v, flags=re.IGNORECASE)
    v = re.sub(r"^www\.", "", v, flags=re.IGNORECASE)
    return v.rstrip("/")


def _ensure_http_url(value: str | None) -> str | None:
    v = (value or "").strip()
    if not v:
        return None
    if v.lower().startswith(("http://", "https://")):
        return v
    return "https://" + v.lstrip("/")


def _contact_href(kind: str, raw: str | None, display: str) -> str | None:
    """Absolute href for a contact item (mailto / tel / https)."""
    if kind == "email" and display.strip():
        return f"mailto:{display.strip()}"
    if kind == "phone" and display.strip():
        digits = re.sub(r"[^\d+]", "", display)
        return f"tel:{digits}" if digits else None
    if kind in ("linkedin", "github"):
        return _ensure_http_url(raw or display)
    return None


def _add_hyperlink_text(
    paragraph,
    url: str,
    text: str,
    *,
    font: str,
    size_pt: float,
    color: RGBColor,
) -> None:
    """Append an external hyperlink run styled like normal contact text (no blue underline)."""
    part = paragraph.part
    r_id = part.relate_to(
        url,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True,
    )
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    hyperlink.set(qn("w:history"), "1")

    run = paragraph.add_run(text)
    _set_run(run, font=font, size_pt=size_pt, color=color)
    run.font.underline = False
    r_el = run._r
    paragraph._p.remove(r_el)
    hyperlink.append(r_el)
    paragraph._p.append(hyperlink)


def _hex_to_rgb(value: str) -> RGBColor:
    v = (value or "#000000").lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    try:
        return RGBColor(int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))
    except Exception:
        return RGBColor(0x1F, 0x29, 0x33)


def _tint(value: str, keep: float) -> str:
    """Blend *value* toward white. ``keep`` is the fraction of the original color
    retained (0 → white, 1 → original). Used for soft header bands."""
    v = (value or "#000000").lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    try:
        r, g, b = int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except Exception:
        return "#f1f5f9"
    r = round(255 * (1 - keep) + r * keep)
    g = round(255 * (1 - keep) + g * keep)
    b = round(255 * (1 - keep) + b * keep)
    return f"#{r:02x}{g:02x}{b:02x}"


def _set_cell_background(cell, color_hex: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color_hex.lstrip("#"))
    tc_pr.append(shd)


def _set_cell_margins(cell, *, top: int, bottom: int, left: int, right: int) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = OxmlElement("w:tcMar")
    for tag, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        node = OxmlElement(f"w:{tag}")
        node.set(qn("w:w"), str(val))
        node.set(qn("w:type"), "dxa")
        tc_mar.append(node)
    tc_pr.append(tc_mar)


def _emu_to_twips(emu: int) -> int:
    return int(round(emu / 635))


def _set_row_exact_height(row, height_tw: int) -> None:
    """Pin a table row to *exactly* ``height_tw`` twips. Used for the header image
    band so a full-bleed background picture of the same height fills it edge to edge
    with no flat fallback strip and without bleeding into the body below.

    NOTE: ``hRule="atLeast"`` must NOT be used for the band - LibreOffice adds the
    cell's top+bottom margins on top of an ``atLeast`` height, inflating the band by
    ~the padding amount and leaving an empty strip under the contacts. ``exact`` makes
    the band height deterministic so the picture and the band line up precisely."""
    tr_pr = row._tr.get_or_add_trPr()
    tr_height = OxmlElement("w:trHeight")
    tr_height.set(qn("w:val"), str(max(0, int(height_tw))))
    tr_height.set(qn("w:hRule"), "exact")
    tr_pr.append(tr_height)


# Canonical child order for <w:tblPr> per the OOXML schema (CT_TblPr).
_TBLPR_ORDER = [
    "w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual", "w:tblStyleRowBandSize",
    "w:tblStyleColBandSize", "w:tblW", "w:tblJc", "w:tblCellSpacing", "w:tblInd",
    "w:tblBorders", "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook", "w:tblCaption",
    "w:tblDescription",
]


def _reorder_tblpr(tbl_pr) -> None:
    index = {qn(tag): i for i, tag in enumerate(_TBLPR_ORDER)}
    children = sorted(list(tbl_pr), key=lambda c: index.get(c.tag, 999))
    for child in children:
        tbl_pr.remove(child)
    for child in children:
        tbl_pr.append(child)


def _set_table_full_bleed(
    table, page_width_emu: int, left_margin_emu: int, right_margin_emu: int = 0
) -> None:
    """Stretch *table* across the page and shift it left into the margin so a header
    band touches the page's left and right edges.

    Width is exactly ``page_width`` (not page+margins). dxpdf centers text inside the
    declared table width; the old LibreOffice oversize (page+both margins) made the
    layout box ~720 pt starting at x=0, so ``jc=center`` landed at page_center+left_margin
    (+54 pt). Page-width + negative ``tblInd`` keeps left flush and centers correctly.
    ``right_margin_emu`` is accepted for call-site compatibility but unused.
    """
    del right_margin_emu  # unused under dxpdf; kept so callers need not change
    table.allow_autofit = False
    tbl_pr = table._tbl.tblPr
    for tag in ("w:tblW", "w:tblInd", "w:tblLayout"):
        for el in tbl_pr.findall(qn(tag)):
            tbl_pr.remove(el)
    tbl_w = OxmlElement("w:tblW")
    tbl_w.set(qn("w:type"), "dxa")
    tbl_w.set(qn("w:w"), str(_emu_to_twips(page_width_emu)))
    tbl_pr.append(tbl_w)
    tbl_ind = OxmlElement("w:tblInd")
    tbl_ind.set(qn("w:type"), "dxa")
    tbl_ind.set(qn("w:w"), str(-_emu_to_twips(left_margin_emu)))
    tbl_pr.append(tbl_ind)
    # Never emit OOXML "autofit" - dxpdf only accepts "auto" | "fixed".
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)
    _reorder_tblpr(tbl_pr)


def _set_run(run, *, font: str, size_pt: float, color: RGBColor, bold: bool = False, caps: bool = False) -> None:
    run.font.name = font
    run.font.size = Pt(size_pt)
    run.font.color.rgb = color
    run.font.bold = bold
    if caps:
        run.font.all_caps = True
    # Ensure the east-asian / complex-script font also maps so LibreOffice picks it up.
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs"):
        rfonts.set(qn(attr), font)


def _add_bottom_border(paragraph, color_hex: str) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    borders = p_pr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        p_pr.append(borders)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "2")
    bottom.set(qn("w:color"), color_hex.lstrip("#"))
    borders.append(bottom)


def _add_top_border(paragraph, color_hex: str) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    borders = p_pr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        p_pr.append(borders)
    top = OxmlElement("w:top")
    top.set(qn("w:val"), "single")
    top.set(qn("w:sz"), "12")
    top.set(qn("w:space"), "2")
    top.set(qn("w:color"), color_hex.lstrip("#"))
    borders.insert(0, top)


def _set_run_shading(run, fill_hex: str) -> None:
    """Fill the background behind a single run (used for badge / boxed titles)."""
    rpr = run._element.get_or_add_rPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex.lstrip("#"))
    rpr.append(shd)


def _set_cell_borders(cell, color_hex: str, sides: set[str], sz: int = 8) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    color = color_hex.lstrip("#")
    for side in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{side}")
        if side in sides:
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), str(sz))
            el.set(qn("w:space"), "0")
            el.set(qn("w:color"), color)
        else:
            el.set(qn("w:val"), "nil")
        borders.append(el)
    tc_pr.append(borders)


_ALIGN_MAP = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}


def _summary_border_sides(border: str) -> tuple[set[str], int]:
    if border == "full":
        return {"top", "left", "bottom", "right"}, 8
    if border == "left":
        return {"left"}, 18
    if border == "top":
        return {"top"}, 12
    if border == "bottom":
        return {"bottom"}, 12
    if border == "x":
        return {"top", "bottom"}, 8
    return set(), 8


def _layout_gap(design: ResumeDesign, field: str, fallback: float) -> float:
    """Realized vertical gap (pt) for a body role, measured from the browser preview.

    The preview is the single source of truth for spacing: it reports the exact gap it
    drew before each kind of block (see ``LayoutMetrics``) so the .docx reproduces it
    regardless of how the user changed the schema (section gap, entry gap, line height,
    surface, markers, ...). ``fallback`` is used only for designs the preview has not
    measured yet (older saves / API-only requests).

    Values are clamped so a bad 2-column measure cannot insert multi-inch gaps between
    body lines (uneven bullet rhythm) or shove the first section off page 1.
    """
    metrics = getattr(design.layout, "layout_metrics", None)
    value: float | None = None
    if metrics is not None:
        raw = getattr(metrics, field, None)
        if raw is not None:
            value = float(raw)
    if value is None:
        value = float(fallback)
    # Keep body rhythm tight and even, especially experience bullets.
    if field == "exp_bullet_pt":
        return max(1.0, min(value, 3.5))
    if field == "heading_before_pt" and design.layout.columns == 2:
        return max(0.0, min(value, 12.0))
    if field.startswith("exp_") or field in {"skill_row_pt", "edu_entry_pt", "cert_row_pt", "heading_after_pt"}:
        return max(0.0, min(value, 28.0))
    return value


def _heading(container, text: str, design: ResumeDesign) -> None:
    typo = design.typography
    para = container.add_paragraph()
    # space-before owns the section gap above the heading; space-after owns the
    # heading->first-row gap. Both come from the measured preview (constants are only a
    # fallback) so they track the user's section-gap / line-height edits exactly.
    para.paragraph_format.space_before = Pt(_layout_gap(design, "heading_before_pt", design.layout.section_gap_pt))
    para.paragraph_format.space_after = Pt(_layout_gap(design, "heading_after_pt", 3.75))
    para.paragraph_format.keep_with_next = True
    run = para.add_run(text.upper() if typo.uppercase_headings else text)
    _set_run(
        run,
        font=typo.font_family,
        size_pt=typo.base_font_pt * typo.heading_scale,
        color=_hex_to_rgb(design.colors.heading),
        bold=True,
        caps=typo.uppercase_headings,
    )
    if design.layout.accent_rule:
        _add_bottom_border(para, design.colors.accent)


def _set_exact_line_spacing(para, size_pt: float, multiplier: float) -> None:
    """Reproduce the CSS ``line-height: <multiplier>`` box model EXACTLY.

    CSS line height = ``multiplier x font-size``. Word's MULTIPLE rule (what you get from
    assigning a bare float to ``line_spacing``) instead multiplies the font's *natural*
    single-line height - ~1.22x the font size for Carlito - so the same 1.12 renders ~22%
    taller (measured: 14.3 pt vs the design's 11.76 pt for 10.5 pt text) and pushes the
    pagination out of sync with the preview. Pinning an EXACT point height per line makes
    the .docx wrap identically to the browser preview."""
    pf = para.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    pf.line_spacing = Pt(size_pt * multiplier)


def _body(
    container,
    text: str,
    design: ResumeDesign,
    *,
    bold: bool = False,
    color_hex: str | None = None,
    size_delta: float = 0.0,
    space_after: float = 2.0,
) -> Any:
    typo = design.typography
    para = container.add_paragraph()
    para.paragraph_format.space_after = Pt(space_after)
    _set_exact_line_spacing(para, typo.base_font_pt + size_delta, typo.line_spacing)
    run = para.add_run(text)
    _set_run(
        run,
        font=typo.font_family,
        size_pt=typo.base_font_pt + size_delta,
        color=_hex_to_rgb(color_hex or design.colors.text),
        bold=bold,
    )
    return para


def _placeholder_paragraph(container, tag: str, design: ResumeDesign) -> None:
    """A body-styled paragraph holding only a placeholder tag for the fill engine."""
    _body(container, tag, design, space_after=design.layout.section_gap_pt / 2)


def _remove_leading_empty(container) -> None:
    paras = container.paragraphs
    if paras and not paras[0].runs and not paras[0].text.strip():
        el = paras[0]._p
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)


def _remove_trailing_empty(container) -> None:
    """Drop a trailing blank paragraph Word inserts after nested tables."""
    paras = container.paragraphs
    if not paras:
        return
    last = paras[-1]
    if last.runs or last.text.strip():
        return
    el = last._p
    parent = el.getparent()
    if parent is not None:
        parent.remove(el)


def _remove_empty_paragraphs(container) -> None:
    """Remove blank paragraphs (no text / drawings) from a cell or document body.

    ``add_table`` leaves an empty ``w:p`` after each table. In stacked contacts those
    default-spaced blanks sat *between* rows and added ~26 pt gaps (measured), which
    blew past the pinned band height and spilled white-on-white contact text.
    """
    parent = getattr(container, "_tc", None)
    if parent is None:
        parent = getattr(container, "_element", None)
    if parent is None:
        return
    for child in list(parent):
        if child.tag != qn("w:p"):
            continue
        if child.find(".//" + qn("w:drawing")) is not None:
            continue
        if child.find(".//" + qn("w:pict")) is not None:
            continue
        texts = child.findall(".//" + qn("w:t"))
        if any((t.text or "").strip() for t in texts):
            continue
        parent.remove(child)


def _clear_table_borders(table) -> None:
    tbl_pr = table._tbl.tblPr
    for old in tbl_pr.findall(qn("w:tblBorders")):
        tbl_pr.remove(old)
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        node = OxmlElement(f"w:{edge}")
        node.set(qn("w:val"), "nil")
        node.set(qn("w:sz"), "0")
        node.set(qn("w:space"), "0")
        node.set(qn("w:color"), "auto")
        borders.append(node)
    tbl_pr.append(borders)


# Common Windows / Linux font filenames for contact-width measurement.
_FONT_FILES: dict[str, tuple[str, ...]] = {
    "Arial": ("arial.ttf", "Arial.ttf", "Arial.ttf"),
    "Calibri": ("calibri.ttf", "Calibri.ttf"),
    "Georgia": ("georgia.ttf", "Georgia.ttf"),
    "Times New Roman": ("times.ttf", "timesnr.ttf", "Times New Roman.ttf"),
    "Verdana": ("verdana.ttf", "Verdana.ttf"),
    "Tahoma": ("tahoma.ttf", "Tahoma.ttf"),
    "Helvetica": ("arial.ttf", "Helvetica.ttf"),  # close metric stand-in
}


def _font_search_dirs() -> list[Path]:
    dirs: list[Path] = []
    windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
    if windir:
        dirs.append(Path(windir) / "Fonts")
    dirs.extend(
        [
            Path("/usr/share/fonts"),
            Path("/usr/local/share/fonts"),
            Path.home() / ".fonts",
            Path.home() / ".local/share/fonts",
        ]
    )
    return dirs


@lru_cache(maxsize=32)
def _resolve_measure_font_path(font_family: str) -> str | None:
    family = (font_family or "Arial").strip() or "Arial"
    names = list(_FONT_FILES.get(family, ()))
    # Always fall back to Arial/Calibri so measurement still works for odd families.
    names.extend(("arial.ttf", "Arial.ttf", "calibri.ttf", "Calibri.ttf"))
    seen: set[str] = set()
    for name in names:
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        for d in _font_search_dirs():
            cand = d / name
            if cand.is_file():
                return str(cand)
    return None


@lru_cache(maxsize=512)
def _measure_text_width_pt(text: str, size_pt: float, font_family: str) -> float:
    """Measure string width in points using the real TTF (dxpdf uses system fonts).

    The old ``len(text) * 0.49em`` heuristic under-sized emails (wide glyphs) and
    let the icon+text wrap onto two lines inside the fixed contact cell.
    """
    if not text or size_pt <= 0:
        return 0.0
    path = _resolve_measure_font_path(font_family)
    if path:
        try:
            from PIL import ImageFont

            # Load oversized then scale down for sub-pt accuracy.
            scale = 64.0
            font = ImageFont.truetype(path, size=max(1, int(round(size_pt * scale))))
            return float(font.getlength(text)) / scale
        except Exception:
            pass
    # Conservative fallback: wide enough for mixed email/URL glyphs.
    return len(text) * size_pt * 0.62


def _set_tc_width_twips(cell, width_tw: int) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    for el in tc_pr.findall(qn("w:tcW")):
        tc_pr.remove(el)
    tc_w = OxmlElement("w:tcW")
    tc_w.set(qn("w:type"), "dxa")
    tc_w.set(qn("w:w"), str(max(1, int(width_tw))))
    tc_pr.insert(0, tc_w)


def _emit_contact_icon_text_pair(
    cell,
    *,
    kind: str,
    text: str,
    href: str | None,
    icon_h: float,
    contact_size: float,
    contact_hex: str,
    contact_color: RGBColor,
    font_family: str,
    icon_style: str,
    offset_x_pt: float = 0.0,
    offset_y_pt: float = 0.0,
) -> None:
    """Emit one contact as a 2-col nested table so the icon can be nudged vs the label.

    dxpdf top-aligns ``wp:inline`` pictures with the text span top and ignores
    ``w:position`` on image runs, so icon+text in one paragraph always looks high.
    Transparent PNG padding also fails (dxpdf flattens alpha to opaque black).

    User nudges (``offset_x_pt`` / ``offset_y_pt``, + = right / down) MUST use
    paragraph ``space_before`` (Y) and text ``left_indent = -offset_x`` (X), not
    ``tcMar``. Proven under dxpdf: cell top margins apply to the whole row (Y± leave
    relative midY unchanged); icon ``left_indent`` clips in the narrow icon column;
    growing that column by the indent cancels +X.
    """
    png = None
    # Product default is brand (filled LinkedIn/GitHub). Treat unknown as brand.
    style = "outline" if icon_style == "outline" else ("none" if icon_style == "none" else "brand")
    if style != "none":
        try:
            png = contact_icon_png(kind, contact_hex, style)
        except Exception:
            png = None

    # Drop the empty paragraph python-docx leaves in a new cell before the table.
    _remove_leading_empty(cell)

    if not png:
        p = cell.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        _set_exact_line_spacing(p, contact_size, 1.2)
        if href:
            _add_hyperlink_text(
                p, href, text, font=font_family, size_pt=contact_size, color=contact_color
            )
        else:
            r = p.add_run(text)
            _set_run(r, font=font_family, size_pt=contact_size, color=contact_color)
        _remove_trailing_empty(cell)
        return

    nudge_x = max(-6.0, min(6.0, float(offset_x_pt or 0.0)))
    nudge_y = max(-6.0, min(6.0, float(offset_y_pt or 0.0)))

    inner = cell.add_table(rows=1, cols=2)
    _clear_table_borders(inner)
    inner.allow_autofit = False
    # Thin space between icon and label (~1.5pt) via icon-col right margin.
    gap_tw = 30
    icon_content_tw = max(120, int(round(icon_h * 20)))
    # Fixed icon-col width: +X is applied as paragraph left_indent *inside* this box.
    # Growing the column by the indent shifts the text column identically and cancels +X
    # (proven: indent=4pt + col+=4pt → relative dX unchanged).
    icon_col_tw = icon_content_tw + gap_tw
    # When nudge_x < 0, text gets a positive left_indent; grow the text column so the
    # label does not wrap (indent steals content width under dxpdf).
    text_indent_tw = max(0, int(round(-nudge_x * 20)))
    text_col_tw = max(
        240,
        int(round(_measure_text_width_pt(text, contact_size, font_family) * 20))
        + 40
        + text_indent_tw,
    )
    tbl = inner._tbl
    grid = tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for w in (icon_col_tw, text_col_tw):
        gc = OxmlElement("w:gridCol")
        gc.set(qn("w:w"), str(w))
        grid.append(gc)
    tbl_pr = tbl.tblPr
    for tag in ("w:tblW", "w:tblLayout"):
        for el in tbl_pr.findall(qn(tag)):
            tbl_pr.remove(el)
    tbl_w = OxmlElement("w:tblW")
    tbl_w.set(qn("w:type"), "dxa")
    tbl_w.set(qn("w:w"), str(icon_col_tw + text_col_tw))
    tbl_pr.append(tbl_w)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)
    _reorder_tblpr(tbl_pr)

    icon_cell, text_cell = inner.rows[0].cells
    _set_tc_width_twips(icon_cell, icon_col_tw)
    _set_tc_width_twips(text_cell, text_col_tw)
    _set_cell_margins(icon_cell, top=0, bottom=0, left=0, right=gap_tw)
    _set_cell_margins(text_cell, top=0, bottom=0, left=0, right=0)
    # TOP + paragraph space_before/indent: relative nudges survive dxpdf. CENTER + tcMar
    # does not (row-shared top margin; +X column growth cancel).
    icon_cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
    text_cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP

    # Slightly taller icon line box + CENTER was mid≈0; with TOP, keep the line box and
    # let the user nudge. Baseline optical center is still close for Modern sizes.
    icon_line_pt = icon_h + contact_size * 0.11
    p_icon = icon_cell.paragraphs[0]
    p_icon.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p_icon.paragraph_format.space_before = Pt(max(0.0, nudge_y))
    p_icon.paragraph_format.space_after = Pt(0)
    p_icon.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    p_icon.paragraph_format.line_spacing = Pt(icon_line_pt)
    try:
        p_icon.add_run().add_picture(BytesIO(png), height=Pt(icon_h))
    except Exception:
        pass

    p_text = text_cell.paragraphs[0]
    p_text.alignment = WD_ALIGN_PARAGRAPH.LEFT
    # X nudge on the *text* indent (inverted): icon left_indent clips inside the narrow
    # icon column under dxpdf, and growing that column cancels +X. Moving the label by
    # ``-nudge_x`` yields the same relative shift as translating the icon (proven).
    p_text.paragraph_format.left_indent = Pt(-nudge_x)
    p_text.paragraph_format.space_before = Pt(max(0.0, -nudge_y))
    p_text.paragraph_format.space_after = Pt(0)
    _set_exact_line_spacing(p_text, contact_size, 1.2)
    if href:
        _add_hyperlink_text(
            p_text, href, text, font=font_family, size_pt=contact_size, color=contact_color
        )
    else:
        r = p_text.add_run(text)
        _set_run(r, font=font_family, size_pt=contact_size, color=contact_color)

    _remove_trailing_empty(cell)


def _estimate_contact_col_twips(
    text: str,
    size_pt: float,
    *,
    has_icon: bool,
    icon_h_pt: float,
    font_family: str,
) -> int:
    """Content width (twips) for one contact cell under dxpdf fixed-column layout.

    Must be ≥ icon + thin-space + text or the paragraph wraps: icon on line 1,
    text on line 2 (the broken email row in the Modern image header).
    """
    # Include the thin space emitted between icon and label.
    label = ("\u2009" + text) if has_icon else text
    text_pt = _measure_text_width_pt(label, size_pt, font_family)
    # Contact icons are square PNGs sized to ``icon_h`` (base_font * 0.66), not contact_size.
    icon_pt = float(icon_h_pt) if has_icon else 0.0
    # dxpdf wrap is strict at the cell edge, keep a few pt of slack.
    return max(240, int(round((text_pt + icon_pt + 5.0) * 20)))


def _set_centered_fixed_table(
    table, col_widths_tw: list[int], *, contain_tw: int
) -> None:
    """Center a nested table with explicit fixed column widths (dxpdf-safe).

    Must rewrite ``w:gridCol`` / ``w:tcW`` - leaving python-docx's equal parent-width
    splits makes contacts sit at 0/180/360/540 and clips GitHub.

    dxpdf ignores ``tblJc=center`` on nested tables inside a header cell, so we
    center with a positive ``tblInd`` = (contain_tw - table_width) / 2.
    Uses ``tblLayout=fixed`` (never OOXML ``autofit``, which dxpdf rejects).
    """
    if not col_widths_tw:
        return
    widths = [max(120, int(w)) for w in col_widths_tw]
    total = sum(widths)
    contain = max(total, int(contain_tw))
    indent = max(0, (contain - total) // 2)

    tbl = table._tbl
    tbl_grid = tbl.tblGrid
    for child in list(tbl_grid):
        tbl_grid.remove(child)
    for w in widths:
        gc = OxmlElement("w:gridCol")
        gc.set(qn("w:w"), str(w))
        tbl_grid.append(gc)

    row = table.rows[0]
    for i, cell in enumerate(row.cells):
        tc_pr = cell._tc.get_or_add_tcPr()
        for el in tc_pr.findall(qn("w:tcW")):
            tc_pr.remove(el)
        tc_w = OxmlElement("w:tcW")
        tc_w.set(qn("w:type"), "dxa")
        tc_w.set(qn("w:w"), str(widths[i]))
        tc_pr.insert(0, tc_w)

    table.allow_autofit = False
    tbl_pr = table._tbl.tblPr
    for tag in ("w:tblW", "w:tblJc", "w:tblInd", "w:tblLayout"):
        for el in tbl_pr.findall(qn(tag)):
            tbl_pr.remove(el)
    tbl_w = OxmlElement("w:tblW")
    tbl_w.set(qn("w:type"), "dxa")
    tbl_w.set(qn("w:w"), str(total))
    tbl_pr.append(tbl_w)
    # Left-align the table, then push it with tblInd, dxpdf honors this path.
    tbl_jc = OxmlElement("w:tblJc")
    tbl_jc.set(qn("w:val"), "left")
    tbl_pr.append(tbl_jc)
    if indent:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_ind.set(qn("w:type"), "dxa")
        tbl_ind.set(qn("w:w"), str(indent))
        tbl_pr.append(tbl_ind)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)
    _clear_table_borders(table)
    _reorder_tblpr(tbl_pr)


def _apply_header_contact_scrim(raw: bytes, *, light_text: bool) -> bytes:
    """Darken the lower portion of a header-band photo so light contact text remains
    readable over bright spots (ceiling lights, windows, etc.).

    The baked overlay is uniform; local highlights still wash out ``#e2e8f0`` contacts.
    A bottom gradient scrim targets exactly where the contact row sits."""
    if not light_text or not raw:
        return raw
    try:
        from PIL import Image as _PILImage
        from PIL import ImageDraw as _PILDraw

        with _PILImage.open(BytesIO(raw)) as src:
            im = src.convert("RGBA")
            w, h = im.size
            if w < 8 or h < 8:
                return raw
            overlay = _PILImage.new("RGBA", (w, h), (0, 0, 0, 0))
            draw = _PILDraw.Draw(overlay)
            y0 = int(h * 0.52)
            span = max(1, h - y0)
            for y in range(y0, h):
                t = (y - y0) / span
                # Ease-in: stronger near the bottom where contacts live.
                alpha = int(155 * (t ** 1.15))
                draw.line([(0, y), (w - 1, y)], fill=(0, 0, 0, alpha))
            composed = _PILImage.alpha_composite(im, overlay)
            buf = BytesIO()
            composed.convert("RGB").save(buf, format="PNG", optimize=True)
            return buf.getvalue()
    except Exception:
        return raw


# ── Section renderers ──────────────────────────────────────────────────────

def _render_header(
    container,
    design: ResumeDesign,
    profile: dict[str, Any],
    *,
    on_dark: bool = False,
    trailing_space_pt: float | None = None,
    # Horizontal band padding is applied as cell margins on the band table (dxpdf
    # honors tcMar). Paragraph indents here are only for non-band callers.
    band_pad_left_pt: float | None = None,
    band_pad_right_pt: float | None = None,
) -> None:
    typo = design.typography
    align = WD_ALIGN_PARAGRAPH.CENTER if design.layout.header_align == "center" else WD_ALIGN_PARAGRAPH.LEFT
    pad_left = float(band_pad_left_pt) if band_pad_left_pt is not None else 0.0
    pad_right = float(band_pad_right_pt) if band_pad_right_pt is not None else 0.0

    def _apply_band_insets(para) -> None:
        if pad_left <= 0 and pad_right <= 0:
            return
        para.paragraph_format.left_indent = Pt(pad_left)
        para.paragraph_format.right_indent = Pt(pad_right)

    name_color = _hex_to_rgb("#ffffff" if on_dark else design.colors.heading)
    title_color = _hex_to_rgb("#f1f5f9" if on_dark else design.colors.accent)
    # Pure white on dark/image bands`#e2e8f0` washes out over bright photo regions.
    contact_hex = "#ffffff" if on_dark else design.colors.muted
    contact_color = _hex_to_rgb(contact_hex)

    name_para = container.add_paragraph()
    name_para.alignment = align
    name_para.paragraph_format.space_before = Pt(0)
    # Preview title uses marginTop: 2px ≈ 1.5 pt.
    name_para.paragraph_format.space_after = Pt(1.5)
    _apply_band_insets(name_para)
    _set_exact_line_spacing(name_para, typo.base_font_pt * typo.name_scale, 1.1)
    name_run = name_para.add_run(profile.get("full_name") or "Your Name")
    _set_run(
        name_run,
        font=typo.font_family,
        size_pt=typo.base_font_pt * typo.name_scale,
        color=name_color,
        bold=True,
    )
    last_para = name_para

    if profile.get("title"):
        title_para = container.add_paragraph()
        title_para.alignment = align
        title_para.paragraph_format.space_before = Pt(0)
        # Preview contact row uses marginTop: 4px ≈ 3 pt.
        title_para.paragraph_format.space_after = Pt(3)
        _apply_band_insets(title_para)
        _set_exact_line_spacing(title_para, typo.base_font_pt * 1.1, 1.2)
        title_run = title_para.add_run(profile["title"])
        _set_run(
            title_run,
            font=typo.font_family,
            size_pt=typo.base_font_pt * 1.1,
            color=title_color,
            bold=False,
        )
        last_para = title_para

    raw_email = (profile.get("email") or "").strip() or None
    raw_phone = (profile.get("phone") or "").strip() or None
    raw_linkedin = (profile.get("linkedin") or "").strip() or None
    raw_github = (profile.get("github") or "").strip() or None
    contact_items: list[tuple[str, str, str | None]] = []
    if raw_email:
        contact_items.append(("email", raw_email, _contact_href("email", raw_email, raw_email)))
    if raw_phone:
        contact_items.append(("phone", raw_phone, _contact_href("phone", raw_phone, raw_phone)))
    if raw_linkedin:
        contact_items.append(
            ("linkedin", _clean_url(raw_linkedin), _contact_href("linkedin", raw_linkedin, raw_linkedin))
        )
    if raw_github:
        contact_items.append(
            ("github", _clean_url(raw_github), _contact_href("github", raw_github, raw_github))
        )
    # Preview contactStyle == base * 0.92 (ResumePreview.tsx).
    contact_size = typo.base_font_pt * 0.92
    # Cap-height-ish glyph; vertical centering via nested icon|text table (not inline).
    icon_h = typo.base_font_pt * 0.66
    raw_icon_style = getattr(design.layout, "contact_icons", "brand") or "brand"
    # Default / unknown → brand (filled LinkedIn & GitHub).
    icon_style = (
        "none"
        if raw_icon_style == "none"
        else ("outline" if raw_icon_style == "outline" else "brand")
    )
    icon_off_x = float(getattr(design.layout, "contact_icon_offset_x_pt", 0.0) or 0.0)
    icon_off_y = float(getattr(design.layout, "contact_icon_offset_y_pt", 0.0) or 0.0)

    def emit_pair(host_cell, kind: str, text: str, href: str | None) -> None:
        _emit_contact_icon_text_pair(
            host_cell,
            kind=kind,
            text=text,
            href=href,
            icon_h=icon_h,
            contact_size=contact_size,
            contact_hex=contact_hex,
            contact_color=contact_color,
            font_family=typo.font_family,
            icon_style=icon_style,
            offset_x_pt=icon_off_x,
            offset_y_pt=icon_off_y,
        )

    if contact_items:
        # One outer cell per contact; each hosts a nested icon|text pair table so
        # dxpdf can vertically center the picture (inline runs cannot).
        gap_tw = 120  # 6pt ≈ preview flex gap / 2 as left margin on cols 1..n
        has_icon = icon_style != "none"
        col_widths = [
            _estimate_contact_col_twips(
                val,
                contact_size,
                has_icon=has_icon,
                icon_h_pt=icon_h,
                font_family=typo.font_family,
            )
            for _, val, _ in contact_items
        ]
        if design.layout.contact_layout == "stacked":
            for kind, val, href in contact_items:
                # Single-column host so stacked rows still get icon|text centering.
                row_tbl = container.add_table(rows=1, cols=1)
                _clear_table_borders(row_tbl)
                host = row_tbl.rows[0].cells[0]
                # Preview stacked gap ≈ 2px (~1.5 pt); keep a 1 pt bottom margin.
                _set_cell_margins(host, top=0, bottom=20, left=0, right=0)
                if design.layout.header_align == "center":
                    page_pt = _LETTER_WIDTH_EMU / 12_700.0
                    contain_tw = int(
                        round(
                            (
                                page_pt
                                - design.layout.hp_left
                                - design.layout.hp_right
                                - pad_left
                                - pad_right
                            )
                            * 20
                        )
                    )
                    w = _estimate_contact_col_twips(
                        val,
                        contact_size,
                        has_icon=has_icon,
                        icon_h_pt=icon_h,
                        font_family=typo.font_family,
                    )
                    _set_centered_fixed_table(row_tbl, [w], contain_tw=contain_tw)
                emit_pair(host, kind, val, href)
                last_para = host.paragraphs[0] if host.paragraphs else last_para
            # Drop the empty ``w:p`` stubs ``add_table`` inserts between stacked rows.
            _remove_empty_paragraphs(container)
        else:
            for i in range(1, len(col_widths)):
                col_widths[i] += gap_tw
            page_pt = _LETTER_WIDTH_EMU / 12_700.0
            contain_tw = int(
                round(
                    (page_pt - design.layout.hp_left - design.layout.hp_right - pad_left - pad_right)
                    * 20
                )
            )
            table = container.add_table(rows=1, cols=len(contact_items))
            if design.layout.header_align == "center":
                _set_centered_fixed_table(table, col_widths, contain_tw=contain_tw)
            else:
                # Left-aligned: fixed cols, no centering indent.
                _set_centered_fixed_table(table, col_widths, contain_tw=sum(col_widths))
            for i, (kind, val, href) in enumerate(contact_items):
                cell = table.rows[0].cells[i]
                _set_cell_margins(
                    cell,
                    top=0,
                    bottom=0,
                    left=gap_tw if i > 0 else 0,
                    right=0,
                )
                emit_pair(cell, kind, val, href)
                last_para = cell.paragraphs[0] if cell.paragraphs else last_para
            _remove_trailing_empty(container)

    if trailing_space_pt is not None:
        last_para.paragraph_format.space_after = Pt(trailing_space_pt)


def _decode_data_url(data_url: str) -> bytes | None:
    """Decode a ``data:image/...;base64,...`` URL into raw bytes, re-encoding to a
    format Word/python-docx can embed.

    The frontend bakes header images as WebP by default (smaller files), but
    python-docx/Word do NOT support WebP - ``add_picture`` raises
    ``UnrecognizedImageError`` for it, which previously made the header band silently
    fall back to a flat fill (the chosen image never appeared in the .docx/PDF). We
    transcode anything that isn't already a docx-friendly raster to PNG via Pillow so
    the picture actually embeds."""
    try:
        if "," not in data_url:
            return None
        head, b64 = data_url.split(",", 1)
        if "base64" not in head:
            return None
        raw = base64.b64decode(b64)
        return _coerce_docx_image(raw)
    except Exception:
        return None


_DOCX_SAFE_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "BMP", "TIFF"}


def _coerce_docx_image(raw: bytes) -> bytes:
    """Return image bytes in a format python-docx/Word can embed. Formats Word does
    not understand (notably WebP, which the frontend produces) are transcoded to PNG.
    Falls back to the original bytes if Pillow is unavailable."""
    try:
        from PIL import Image as _PILImage

        with _PILImage.open(BytesIO(raw)) as im:
            fmt = (im.format or "").upper()
            if fmt in _DOCX_SAFE_IMAGE_FORMATS:
                return raw
            converted = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            buf = BytesIO()
            converted.save(buf, format="PNG")
            return buf.getvalue()
    except Exception:
        return raw


# Hard ceilings for browser-reported header geometry. Values above these (seen after
# theme/column switches or bad measure passes) pin a near-page-tall first-page header
# and push the body, especially the Technical two-column table, onto page 2, so page
# 1 shows only the name band over blank white.
#
# Evidence (dxpdf): removing the exact ``trHeight`` pin and letting nested contact
# tables define natural header height produced pages=2 with page-0 text = header only
# and no body, matching the Technical blank-page-1 bug in production.
_MAX_PINNED_BAND_PT = 220.0
_MAX_PINNED_BAND_PT_TWO_COL = 110.0
_MAX_HEADER_GAP_CONTRIB_PT = 48.0
_MAX_HEADER_GAP_CONTRIB_PT_TWO_COL = 16.0


def _max_pinned_band_pt(design: ResumeDesign) -> float:
    return _MAX_PINNED_BAND_PT_TWO_COL if design.layout.columns == 2 else _MAX_PINNED_BAND_PT


def _max_header_gap_contrib_pt(design: ResumeDesign) -> float:
    return (
        _MAX_HEADER_GAP_CONTRIB_PT_TWO_COL
        if design.layout.columns == 2
        else _MAX_HEADER_GAP_CONTRIB_PT
    )


def _effective_band_height_pt(design: ResumeDesign, profile: dict[str, Any]) -> float:
    """Visible header band height (pt) for the behindDoc band image / body spacer.

    Uses the browser-measured ``header_metrics.band_pt`` when present, but never
    shorter than the typography estimate. Stale inline metrics (e.g. 87.9 pt) must
    not clip stacked contacts, proven: undersized band paints white ``on_dark``
    text onto the page and hides labels.

    Also rejects absurdly *large* measurements so a bad measure cannot evacuate the
    body from page 1 via an oversized page-1 spacer.
    """
    estimate = _header_band_height_pt(design, profile)
    ceiling = _max_pinned_band_pt(design)
    metrics = getattr(design.layout, "header_metrics", None)
    if metrics is not None and metrics.band_pt and metrics.band_pt > 0:
        measured = float(metrics.band_pt)
        if measured > ceiling:
            return min(estimate, ceiling)
        return min(max(measured, estimate), ceiling)
    return min(estimate, ceiling)


def _header_gap_contrib_pt(design: ResumeDesign) -> float:
    """Extra page-1 gap (pt) after the band, before the first section (excl. section_gap)."""
    ceiling = _max_header_gap_contrib_pt(design)
    measured = getattr(design.layout, "header_metrics", None)
    if measured is not None and measured.gap_pt is not None and measured.gap_pt >= 0:
        gap_contrib = max(0.0, float(measured.gap_pt) - design.layout.section_gap_pt)
        if gap_contrib <= ceiling:
            return gap_contrib
    return min(max(0.0, design.layout.m_top * 0.6), ceiling)


def _header_band_height_pt(design: ResumeDesign, profile: dict[str, Any]) -> float:
    """Estimate the header band height (pt) from typography + padding + present
    content, so the behind-text image is sized to fill exactly that band."""
    # Being marginally generous is safe: the band uses an *exact* row height, so a
    # slight over-estimate only adds padding; an under-estimate clips contacts.
    typo = design.typography
    base = typo.base_font_pt
    lay = design.layout
    contact_size = base * 0.92
    # Mirrors compiler line boxes:
    #   name  -> base * name_scale, exact line 1.1
    #   title -> base * 1.1, exact 1.2 + 1.5 pt space_after on name / 3 pt on title
    #   contact row -> nested icon|text table, height ≈ contact_size * 1.2
    content = base * typo.name_scale * 1.10
    if profile.get("title"):
        content += base * 1.1 * 1.20 + 1.5 + 3.0
    n_contacts = sum(1 for k in ("email", "phone", "linkedin", "github") if profile.get(k))
    if n_contacts:
        row_h = contact_size * 1.2
        if lay.contact_layout == "stacked":
            # Each stacked host keeps a 1 pt bottom cell margin (20 twips).
            content += n_contacts * (row_h + 1.0) + 3.0
        else:
            content += row_h + 3.0
    # hp_top/hp_bottom are the designed band paddings; +2 pt anti-clip margin.
    return lay.hp_top + lay.hp_bottom + content + 2.0


def _add_band_background_image(paragraph, image_bytes: bytes, width_emu: int, height_emu: int) -> bool:
    """Anchor *image_bytes* as a full-bleed, behind-text picture at the page's
    top-left corner. Returns True on success."""
    try:
        run = paragraph.add_run()
        run.add_picture(BytesIO(image_bytes), width=Emu(int(width_emu)), height=Emu(int(height_emu)))
        drawing = run._r.find(qn("w:drawing"))
        if drawing is None:
            return False
        inline = drawing.find(qn("wp:inline"))
        if inline is None:
            return False
        extent = inline.find(qn("wp:extent"))
        graphic = inline.find(qn("a:graphic"))
        doc_pr = inline.find(qn("wp:docPr"))
        if extent is None or graphic is None or doc_pr is None:
            return False
        cx, cy = extent.get("cx"), extent.get("cy")

        anchor = OxmlElement("wp:anchor")
        for attr, val in (
            ("distT", "0"), ("distB", "0"), ("distL", "0"), ("distR", "0"),
            ("simplePos", "0"), ("relativeHeight", "0"), ("behindDoc", "1"),
            # layoutInCell MUST be 0: with it on, LibreOffice positions/clips the
            # picture relative to the cell's shifted content frame, so a page-width
            # image stops ~a margin short of the right edge (white strip). Anchored to
            # the page (offset 0,0) with the band pinned to the page top, the picture
            # spans the full page width and its height matches the exact band height,
            # so there is no right-edge strip and no bleed into the body below.
            ("locked", "0"), ("layoutInCell", "0"), ("allowOverlap", "1"),
        ):
            anchor.set(attr, val)

        simple_pos = OxmlElement("wp:simplePos")
        simple_pos.set("x", "0")
        simple_pos.set("y", "0")
        anchor.append(simple_pos)

        for tag, rel in (("wp:positionH", "page"), ("wp:positionV", "page")):
            pos = OxmlElement(tag)
            pos.set("relativeFrom", rel)
            off = OxmlElement("wp:posOffset")
            off.text = "0"
            pos.append(off)
            anchor.append(pos)

        ext = OxmlElement("wp:extent")
        ext.set("cx", cx)
        ext.set("cy", cy)
        anchor.append(ext)

        effect = OxmlElement("wp:effectExtent")
        for a in ("l", "t", "r", "b"):
            effect.set(a, "0")
        anchor.append(effect)

        anchor.append(OxmlElement("wp:wrapNone"))
        anchor.append(doc_pr)
        anchor.append(OxmlElement("wp:cNvGraphicFramePr"))
        anchor.append(graphic)

        drawing.remove(inline)
        drawing.append(anchor)
        return True
    except Exception:
        return False


# dxpdf reserves the first-page header's *row* height as the top inset on EVERY page,
# even when that header only paints on page 1 (proven: pin 90pt → page2 y0≈91; pin 1pt
# → page2 y0≈m_top). Keep the visual band via a page-anchored behindDoc image and pin
# geometry to 1pt so continuation pages use only the real top margin.
_FIRST_HEADER_GEOMETRY_PIN_PT = 1.0


def _solid_fill_png(hex6: str, *, width_px: int, height_px: int) -> bytes:
    """Flat RGB PNG used as a full-bleed behindDoc band fill (soft/solid headers)."""
    from PIL import Image as _PILImage

    h = (hex6 or "2563eb").lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    try:
        rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        rgb = (37, 99, 235)
    img = _PILImage.new("RGB", (max(2, int(width_px)), max(2, int(height_px))), rgb)
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _render_header_band(doc, design: ResumeDesign, profile: dict[str, Any], section) -> None:
    """Render the header inside a full-bleed shaded band (single-cell table) that
    touches the page's top, left, and right edges.

    The band lives in the first-page header so it can sit flush at y=0 while
    ``section.top_margin`` stays at ``m_top`` for continuation pages. The header
    *geometry* is pinned to 1pt (see ``_FIRST_HEADER_GEOMETRY_PIN_PT``); the visible
    band height comes from a behindDoc image so dxpdf does not inflate page 2+ tops.
    """
    bg = design.layout.header_background
    header_image = design.layout.header_image if bg == "image" else None
    image_bytes = _decode_data_url(header_image.data_url) if header_image else None

    if header_image and image_bytes:
        light_text = header_image.text == "light"
        on_dark = light_text
        # Fallback fill (shown only if the image fails to render) matches the text mode.
        fill = "0f172a" if light_text else "e2e8f0"
        # Extra bottom scrim so contact text stays readable over bright photo regions.
        image_bytes = _apply_header_contact_scrim(image_bytes, light_text=light_text)
    elif bg == "solid":
        fill = (design.colors.accent or "#2563eb").lstrip("#")
        on_dark = True
        image_bytes = None
    else:
        fill = _tint(design.colors.accent, 0.14).lstrip("#")
        on_dark = False
        image_bytes = None

    section.different_first_page_header_footer = True
    section.header_distance = Pt(0)
    band_container = section.first_page_header
    for _hp in list(band_container.paragraphs):
        _hp._p.getparent().remove(_hp._p)
    table = band_container.add_table(rows=1, cols=1, width=section.page_width)
    # A header must not end on a table; a 1 pt trailing paragraph keeps it valid without
    # adding meaningful height below the band. Also anchors the behindDoc band image.
    band_tail = band_container.add_paragraph()
    band_tail.paragraph_format.space_before = Pt(0)
    band_tail.paragraph_format.space_after = Pt(0)
    band_tail.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    band_tail.paragraph_format.line_spacing = Pt(1)
    cell = table.rows[0].cells[0]
    _set_table_full_bleed(table, section.page_width, section.left_margin, section.right_margin)
    # Match page-width band (not page+margins) so dxpdf centering stays on page center.
    cell.width = section.page_width
    lay = design.layout
    pad_l_tw = max(0, int(round(lay.hp_left * 20)))
    pad_r_tw = max(0, int(round(lay.hp_right * 20)))
    band_h_pt = _effective_band_height_pt(design, profile)

    # Honour asymmetric vertical padding: top-align with hp_top (preview match).
    # Do NOT shade the cell when a behindDoc image supplies the band, cell fill would
    # paint over the picture (image mode) or only fill the 1pt geometry pin (soft/solid).
    _set_cell_margins(
        cell,
        top=max(0, int(round(lay.hp_top * 20))),
        bottom=0,
        left=pad_l_tw,
        right=pad_r_tw,
    )
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
    _render_header(cell, design, profile, on_dark=on_dark)
    _remove_leading_empty(cell)
    _remove_trailing_empty(cell)
    _set_row_exact_height(table.rows[0], int(round(_FIRST_HEADER_GEOMETRY_PIN_PT * 20)))

    # Paint the full band as a page-anchored behindDoc image (photo or flat soft/solid).
    paint_bytes = image_bytes
    if paint_bytes is None:
        # ~2× page width in px keeps the stretch crisp; height tracks band_h.
        paint_bytes = _solid_fill_png(
            fill,
            width_px=1224,
            height_px=max(2, int(round(band_h_pt * 2))),
        )
    ok = _add_band_background_image(
        band_tail,
        paint_bytes,
        width_emu=section.page_width,
        height_emu=int(round(band_h_pt * 12700)),
    )
    if not ok:
        # Embedding failed, fall back to a cell fill and accept a taller geometry pin
        # so page-1 text stays on the coloured band (page 2+ may gain a larger top inset).
        _set_cell_background(cell, fill)
        _set_row_exact_height(table.rows[0], int(round(float(band_h_pt) * 20)))

    # Body starts at ~m_top when the geometry pin is 1pt. Push page-1 content down to
    # band_h + gap (same as when the header row itself was band_h tall):
    #   spacer = band_h + gap_contrib - m_top
    # The spacer is document-leading only, so pages 2+ keep a clean m_top inset.
    #
    # CRITICAL: use exact line height, not space_before (engines suppress space_before
    # on the first body paragraph after a header). Cap gap_contrib so a bad measure
    # cannot evacuate the body from page 1.
    gap_ceiling = _max_header_gap_contrib_pt(design)
    gap_contrib = min(max(0.0, _header_gap_contrib_pt(design)), gap_ceiling)
    if ok:
        spacer_pt = max(1.0, float(band_h_pt) + gap_contrib - float(lay.m_top))
    else:
        spacer_pt = max(1.0, gap_contrib)
    # Absolute ceiling: never let the spacer alone approach a page height.
    spacer_pt = min(spacer_pt, gap_ceiling + max(0.0, float(band_h_pt) - float(lay.m_top)))
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    spacer.paragraph_format.line_spacing = Pt(spacer_pt)


_SUMMARY_TITLE = "Professional Summary"
_SUMMARY_TAG = "{{PROFILE_SUMMARY}}"


def _summary_emit_title(target, design: ResumeDesign, st, on_solid: bool, *, title: str = _SUMMARY_TITLE) -> list:
    """Emit the styled summary heading into *target*. Returns the paragraphs created
    (empty for hidden / inline titles, which fold the label into the body).

    ``title`` overrides the default "Professional Summary" label so the same styled
    heading can be reused as the cover letter's "Cover Letter" section title."""
    typo = design.typography
    # 'side' degrades to an above-title in the .docx (clean and width-safe).
    mode = "above" if st.title == "side" else st.title
    if mode in ("hidden", "inline"):
        return []

    upper = typo.uppercase_headings
    title_color = _hex_to_rgb("#ffffff" if on_solid else design.colors.heading)
    accent_color = _hex_to_rgb("#ffffff" if on_solid else design.colors.accent)
    accent_hex = "#ffffff" if on_solid else design.colors.accent
    size = typo.base_font_pt * typo.heading_scale

    p = target.add_paragraph()
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.keep_with_next = True

    if mode == "overline":
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if st.align == "center" else WD_ALIGN_PARAGRAPH.LEFT
        _add_top_border(p, accent_hex)
        p.paragraph_format.space_before = Pt(2)
        run = p.add_run(title.upper())
        _set_run(run, font=typo.font_family, size_pt=typo.base_font_pt * 0.95, color=title_color, bold=True, caps=True)
        return [p]

    if mode == "badge":
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if st.align == "center" else WD_ALIGN_PARAGRAPH.LEFT
        badge_bg = "#ffffff" if on_solid else design.colors.accent
        badge_fg = design.colors.accent if on_solid else "#ffffff"
        run = p.add_run(f"  {title.upper()}  ")
        _set_run(run, font=typo.font_family, size_pt=typo.base_font_pt * 0.82, color=_hex_to_rgb(badge_fg), bold=True, caps=True)
        _set_run_shading(run, badge_bg)
        return [p]

    # Standard above / centered title.
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER if mode == "centered" else WD_ALIGN_PARAGRAPH.LEFT
    if st.title_accent == "bar":
        bar = p.add_run("\u258f ")
        _set_run(bar, font=typo.font_family, size_pt=size, color=accent_color, bold=True)
    elif st.title_accent == "dot":
        dot = p.add_run("\u25cf ")
        _set_run(dot, font=typo.font_family, size_pt=typo.base_font_pt, color=accent_color, bold=True)

    run = p.add_run(title.upper() if upper else title)
    if st.title_accent == "box":
        _set_run(run, font=typo.font_family, size_pt=size, color=_hex_to_rgb("#ffffff"), bold=True, caps=upper)
        _set_run_shading(run, design.colors.accent)
    else:
        _set_run(run, font=typo.font_family, size_pt=size, color=title_color, bold=True, caps=upper)

    # 'none' accent inherits the global accent-rule so the default style matches the
    # other section headings; 'underline' always draws it.
    if st.title_accent == "underline" or (st.title_accent == "none" and design.layout.accent_rule):
        _add_bottom_border(p, accent_hex)
    return [p]


def _summary_emit_body(target, design: ResumeDesign, st, on_solid: bool, *, title: str = _SUMMARY_TITLE, tag: str = _SUMMARY_TAG):
    typo = design.typography
    body_color = _hex_to_rgb("#ffffff" if on_solid else design.colors.text)
    p = target.add_paragraph()
    p.alignment = _ALIGN_MAP.get(st.align, WD_ALIGN_PARAGRAPH.LEFT)
    _set_exact_line_spacing(p, typo.base_font_pt, typo.line_spacing)
    # Space-before ownership: the summary body owns no trailing gap. The following
    # section heading owns the inter-section gap via its own space-before, and Word's
    # non-collapsing margins would otherwise add this on top (preview keeps body margin 0).
    p.paragraph_format.space_after = Pt(0)
    if st.title == "inline":
        upper = typo.uppercase_headings
        lead = p.add_run((title.upper() if upper else title) + ".  ")
        _set_run(
            lead,
            font=typo.font_family,
            size_pt=typo.base_font_pt,
            color=_hex_to_rgb("#ffffff" if on_solid else design.colors.heading),
            bold=True,
            caps=upper,
        )
    run = p.add_run(tag)
    _set_run(run, font=typo.font_family, size_pt=typo.base_font_pt, color=body_color, bold=False)
    if st.italic:
        run.font.italic = True
    return p


def _render_summary(container, design: ResumeDesign, *, title: str = _SUMMARY_TITLE, tag: str = _SUMMARY_TAG) -> None:
    """Render the summary section. ``title``/``tag`` are overridable so the cover
    letter can reuse this exact styled section as its "Cover Letter" body block."""
    st = design.sections.summary_style
    on_solid = st.surface in ("solid", "gradient")
    has_box = st.surface != "none" or st.border != "none"
    gap = design.layout.section_gap_pt

    if has_box:
        # Spacer paragraph carries the section gap (tables cannot set space-before).
        spacer = container.add_paragraph()
        spacer.paragraph_format.space_before = Pt(gap)
        spacer.paragraph_format.space_after = Pt(0)
        spacer.paragraph_format.line_spacing = Pt(2)

        table = container.add_table(rows=1, cols=1)
        table.allow_autofit = False
        cell = table.rows[0].cells[0]

        if st.surface == "tint":
            _set_cell_background(cell, _tint(design.colors.accent, 0.12))
        elif st.surface in ("solid", "gradient"):
            # No real gradient in WordprocessingML; a solid accent keeps white text legible.
            _set_cell_background(cell, design.colors.accent)
        sides, sz = _summary_border_sides(st.border)
        if sides:
            _set_cell_borders(cell, "#ffffff" if on_solid else design.colors.accent, sides, sz)
        pad_tw = max(60, int(round(st.pad_pt * 20)))
        _set_cell_margins(cell, top=pad_tw, bottom=pad_tw, left=pad_tw, right=pad_tw)

        _summary_emit_title(cell, design, st, on_solid, title=title)
        _summary_emit_body(cell, design, st, on_solid, title=title, tag=tag)
        _remove_leading_empty(cell)
        return

    paras = _summary_emit_title(container, design, st, on_solid, title=title)
    body = _summary_emit_body(container, design, st, on_solid, title=title, tag=tag)
    first = paras[0] if paras else body
    first.paragraph_format.space_before = Pt(gap)


def _render_skills(container, design: ResumeDesign) -> None:
    _heading(container, "Technical Skills", design)
    _placeholder_paragraph(container, "{{SKILLS_CONTENT}}", design)


def _experience_date_text(design: ResumeDesign, style, row: dict[str, Any]) -> str:
    """Date / location / type badge text for the experience header sub-line."""
    bits: list[str] = []
    if design.sections.show_period and row.get("period"):
        bits.append(row["period"])
    if design.sections.show_location and row.get("location"):
        bits.append(row["location"])
    if style.badge_style != "hidden":
        if style.show_employment_type and row.get("employment_type"):
            bits.append(str(row["employment_type"]))
        if style.show_arrangement and row.get("job_type"):
            bits.append(str(row["job_type"]))
    return "  |  ".join(bits)


def _render_experience(container, design: ResumeDesign, rows: list[dict[str, Any]], slot_count: int) -> None:
    _heading(container, "Work Experience", design)
    style = design.sections.experience_style
    font = design.typography.font_family
    if not rows:
        # Mirror the preview's empty-state note instead of emitting a phantom
        # "Company / Role" slot with a dangling {{EXP_1}} placeholder.
        _body(
            container,
            "Add work experience in your profile to populate this section.",
            design,
            color_hex=design.colors.muted,
            space_after=0.0,
        )
        return
    # The live preview renders the company/role at the base font size (bold + accent for
    # emphasis), so the PDF must too. A larger header here makes the fixed company gap
    # read tighter than the preview even though the gap value is identical.
    head_pt = design.typography.base_font_pt
    # The preview renders dates with mutedStyle == base * 0.92 (ResumePreview.tsx).
    # Mirror that exactly so the date line's height (and the gap it consumes) matches.
    date_pt = design.typography.base_font_pt * 0.92
    company_color = _hex_to_rgb(design.colors.accent if style.accent_target == "company" else design.colors.heading)
    role_color = _hex_to_rgb(design.colors.accent if style.accent_target == "role" else design.colors.text)
    date_color = _hex_to_rgb(design.colors.accent if style.accent_target == "date" else design.colors.muted)
    # Right-aligned tab stop sits at the container's right text edge (cell width in
    # two-column layouts, otherwise the full page content width).
    usable_emu = _container_usable_emu(container, design)

    for i in range(1, slot_count + 1):
        row = rows[i - 1] if i - 1 < len(rows) else {}
        company = row.get("company_name") or "Company"
        title = row.get("job_title") or "Role"
        date_text = _experience_date_text(design, style, row)

        def add_company_run(p, with_role: bool) -> None:
            c_run = p.add_run(company)
            _set_run(c_run, font=font, size_pt=head_pt, color=company_color, bold=True)
            if with_role and title:
                t_run = p.add_run(f"  -  {title}")
                _set_run(t_run, font=font, size_pt=head_pt, color=role_color, bold=False)

        def add_role_line() -> None:
            if not title:
                return
            r_para = container.add_paragraph()
            r_para.paragraph_format.space_before = Pt(0)
            r_para.paragraph_format.space_after = Pt(0)
            r_para.paragraph_format.keep_with_next = True
            r_run = r_para.add_run(title)
            _set_run(r_run, font=font, size_pt=head_pt, color=role_color, bold=False)

        def add_date_subline() -> None:
            if date_text:
                _body(container, date_text, design, color_hex=design.colors.muted, size_delta=date_pt - head_pt, space_after=0.0)

        header_para = container.add_paragraph()
        # Each company owns the gap *above* it via space-before (space-after is 0 here and
        # on every body line, so Word's non-collapsing margins never double a gap). The
        # first company's gap is the heading->content gap (owned by the heading's
        # space-after, so 0 here); later companies use the measured company-to-company gap.
        header_para.paragraph_format.space_before = Pt(
            0.0 if i == 1 else _layout_gap(design, "exp_company_pt", style.entry_gap_pt)
        )
        header_para.paragraph_format.space_after = Pt(0)
        header_para.paragraph_format.keep_with_next = True

        if style.header_layout == "stacked":
            # Company (line 1), role (line 2), date below or right.
            if style.date_position == "right" and date_text:
                header_para.paragraph_format.tab_stops.add_tab_stop(Emu(usable_emu), WD_TAB_ALIGNMENT.RIGHT)
                add_company_run(header_para, with_role=False)
                d_run = header_para.add_run(f"\t{date_text}")
                _set_run(d_run, font=font, size_pt=date_pt, color=date_color)
                add_role_line()
            else:
                add_company_run(header_para, with_role=False)
                add_role_line()
                add_date_subline()
        elif style.header_layout == "two_column" or style.date_position == "right":
            # Header left, date right via a right-aligned tab stop.
            if date_text:
                header_para.paragraph_format.tab_stops.add_tab_stop(Emu(usable_emu), WD_TAB_ALIGNMENT.RIGHT)
            add_company_run(header_para, with_role=True)
            if date_text:
                d_run = header_para.add_run(f"\t{date_text}")
                _set_run(d_run, font=font, size_pt=date_pt, color=date_color)
        elif style.date_position == "inline":
            add_company_run(header_para, with_role=True)
            if date_text:
                d_run = header_para.add_run(f"   \u00b7   {date_text}")
                _set_run(d_run, font=font, size_pt=date_pt, color=date_color)
        else:
            # inline header, date below
            add_company_run(header_para, with_role=True)
            add_date_subline()

        _placeholder_paragraph(container, "{{" + f"EXP_{i}" + "}}", design)


def _education_date_text(design: ResumeDesign, style, item: dict[str, Any]) -> str:
    """Period / grade / location text for the education header sub-line."""
    bits: list[str] = []
    if style.show_period and item.get("period"):
        bits.append(str(item["period"]))
    if style.show_mark and item.get("mark"):
        bits.append(str(item["mark"]))
    if style.show_location and item.get("location"):
        bits.append(str(item["location"]))
    return "  |  ".join(bits)


def _render_education(container, design: ResumeDesign, education: list[dict[str, Any]]) -> None:
    _heading(container, "Education", design)
    style = design.sections.education_style
    font = design.typography.font_family
    # Match the live preview, which renders the university/degree at the base font size.
    head_pt = design.typography.base_font_pt
    # Preview dates use mutedStyle == base * 0.92; mirror it for height/gap parity.
    sub_pt = design.typography.base_font_pt * 0.92
    muted = _hex_to_rgb(design.colors.muted)
    uni_color = _hex_to_rgb(design.colors.accent if style.accent_target == "university" else design.colors.heading)
    degree_color = _hex_to_rgb(design.colors.accent if style.accent_target == "degree" else design.colors.text)
    usable_emu = _container_usable_emu(container, design)

    # Each entry owns the gap above it via space-before (space-after stays 0 on the
    # entry's last line). The first entry's gap is the heading->content gap (owned by the
    # heading's space-after, so 0 here); later entries use the measured entry-to-entry gap.
    emitted_entries = 0

    for item in education:
        uni = item.get("university_name") or ""
        degree = item.get("degree") or ""
        if not (uni or degree):
            continue
        date_text = _education_date_text(design, style, item)

        def add_uni_run(p, with_degree: bool) -> None:
            if uni:
                u_run = p.add_run(uni)
                _set_run(u_run, font=font, size_pt=head_pt, color=uni_color, bold=True)
            if with_degree and degree:
                sep = "  -  " if uni else ""
                d_run = p.add_run(f"{sep}{degree}")
                _set_run(d_run, font=font, size_pt=head_pt, color=degree_color, bold=False)

        def add_degree_line() -> None:
            if not degree:
                return
            d_para = container.add_paragraph()
            d_para.paragraph_format.space_before = Pt(0)
            d_para.paragraph_format.space_after = Pt(0)
            d_para.paragraph_format.keep_with_next = True
            d_run = d_para.add_run(degree)
            _set_run(d_run, font=font, size_pt=head_pt, color=degree_color, bold=False)

        def add_date_subline() -> None:
            if date_text:
                _body(container, date_text, design, color_hex=design.colors.muted, size_delta=sub_pt - head_pt, space_after=0.0)

        header_para = container.add_paragraph()
        header_para.paragraph_format.space_before = Pt(
            _layout_gap(design, "edu_entry_pt", style.entry_gap_pt) if emitted_entries else 0.0
        )
        header_para.paragraph_format.space_after = Pt(0)
        header_para.paragraph_format.keep_with_next = True
        emitted_entries += 1

        if style.header_layout == "stacked":
            if style.date_position == "right" and date_text:
                header_para.paragraph_format.tab_stops.add_tab_stop(Emu(usable_emu), WD_TAB_ALIGNMENT.RIGHT)
                add_uni_run(header_para, with_degree=False)
                t_run = header_para.add_run(f"\t{date_text}")
                _set_run(t_run, font=font, size_pt=sub_pt, color=muted)
                add_degree_line()
            else:
                add_uni_run(header_para, with_degree=False)
                add_degree_line()
                add_date_subline()
        elif style.date_position == "right":
            if date_text:
                header_para.paragraph_format.tab_stops.add_tab_stop(Emu(usable_emu), WD_TAB_ALIGNMENT.RIGHT)
            add_uni_run(header_para, with_degree=True)
            if date_text:
                t_run = header_para.add_run(f"\t{date_text}")
                _set_run(t_run, font=font, size_pt=sub_pt, color=muted)
        elif style.date_position == "inline":
            add_uni_run(header_para, with_degree=True)
            if date_text:
                t_run = header_para.add_run(f"   \u00b7   {date_text}")
                _set_run(t_run, font=font, size_pt=sub_pt, color=muted)
        else:  # date below
            add_uni_run(header_para, with_degree=True)
            add_date_subline()

        if style.show_description and (item.get("description") or "").strip():
            # Trailing line of the entry: keep space-after 0 so the next entry's measured
            # space-before (edu_entry) owns the whole inter-entry gap without doubling it.
            _body(container, str(item["description"]).strip(), design, space_after=0.0)


_CERT_GLYPH: dict[str, str] = {
    "dot": "\u2022",
    "dash": "\u2013",
    "check": "\u2713",
    "arrow": "\u2192",
    "square": "\u25AA",
    "none": "",
}


# ── Profile extraction ─────────────────────────────────────────────────────

def _profile_dict(user: User) -> dict[str, Any]:
    return {
        "full_name": _full_name(user),
        "title": (getattr(user, "profile_title", None) or "").strip(),
        "email": (getattr(user, "profile_email", None) or getattr(user, "email", None) or "").strip(),
        "phone": _format_phone(user),
        "linkedin": (getattr(user, "linkedin_url", None) or "").strip(),
        "github": (getattr(user, "github_url", None) or "").strip(),
    }


def _education_rows(user: User) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in getattr(user, "education", None) or []:
        if not isinstance(item, dict):
            continue
        uni = (item.get("university_name") or "").strip()
        degree = (item.get("degree") or "").strip()
        if uni or degree:
            rows.append({
                "university_name": uni,
                "degree": degree,
                "period": _format_period(item.get("period_start"), item.get("period_end")),
                "mark": (item.get("mark") or "").strip(),
                "location": (item.get("location") or "").strip(),
                "description": (item.get("description") or "").strip(),
            })
    return rows


def _certificate_rows(user: User) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in getattr(user, "certificates", None) or []:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        if not name:
            continue
        rows.append({
            "name": name,
            "issued_at": format_flexible_date((item.get("issued_at") or "").strip()),
            "url": (item.get("url") or "").strip(),
        })
    return rows


def _cert_display_text(item: dict[str, Any]) -> str:
    name = str(item.get("name") or "").strip()
    issued = format_flexible_date(str(item.get("issued_at") or "").strip())
    return f"{name} ({issued})" if issued else name


def _emit_cert_entry(
    paragraph,
    item: dict[str, Any],
    design: ResumeDesign,
    *,
    prefix: str = "",
) -> None:
    """Write one certification into *paragraph*, hyperlinking the name when a URL exists."""
    typo = design.typography
    color = _hex_to_rgb(design.colors.text)
    muted = _hex_to_rgb(design.colors.muted)
    size = typo.base_font_pt
    name = str(item.get("name") or "").strip()
    issued = format_flexible_date(str(item.get("issued_at") or "").strip())
    href = _ensure_http_url(item.get("url"))

    if prefix:
        pre = paragraph.add_run(prefix)
        _set_run(pre, font=typo.font_family, size_pt=size, color=color)

    if href and name:
        _add_hyperlink_text(
            paragraph,
            href,
            name,
            font=typo.font_family,
            size_pt=size,
            color=color,
        )
        if issued:
            tail = paragraph.add_run(f" ({issued})")
            _set_run(tail, font=typo.font_family, size_pt=size, color=muted)
    else:
        text = _cert_display_text(item)
        run = paragraph.add_run(text)
        _set_run(run, font=typo.font_family, size_pt=size, color=color)


def _render_certificates(container, design: ResumeDesign, certificates: list[dict[str, Any]]) -> None:
    _heading(container, "Certifications", design)
    style = design.sections.certificates_style
    items = [c for c in certificates if str(c.get("name") or "").strip()]
    if not items:
        return

    typo = design.typography

    if style.layout == "inline":
        para = container.add_paragraph()
        para.paragraph_format.space_after = Pt(2.0)
        _set_exact_line_spacing(para, typo.base_font_pt, typo.line_spacing)
        for idx, item in enumerate(items):
            if idx:
                sep = para.add_run(", ")
                _set_run(sep, font=typo.font_family, size_pt=typo.base_font_pt, color=_hex_to_rgb(design.colors.text))
            _emit_cert_entry(para, item, design)
    elif style.layout == "pipe":
        para = container.add_paragraph()
        para.paragraph_format.space_after = Pt(2.0)
        _set_exact_line_spacing(para, typo.base_font_pt, typo.line_spacing)
        for idx, item in enumerate(items):
            if idx:
                sep = para.add_run("  |  ")
                _set_run(sep, font=typo.font_family, size_pt=typo.base_font_pt, color=_hex_to_rgb(design.colors.text))
            _emit_cert_entry(para, item, design)
    elif style.layout == "chips":
        para = container.add_paragraph()
        para.paragraph_format.space_after = Pt(2.0)
        _set_exact_line_spacing(para, typo.base_font_pt, typo.line_spacing)
        for idx, item in enumerate(items):
            if idx:
                sep = para.add_run("    ")
                _set_run(sep, font=typo.font_family, size_pt=typo.base_font_pt, color=_hex_to_rgb(design.colors.text))
            _emit_cert_entry(para, item, design)
    else:
        # list / grid: one entry per line with the chosen marker glyph.
        glyph = _CERT_GLYPH.get(style.marker, "\u2022")
        prefix = f"{glyph}  " if glyph else ""
        row_gap = _layout_gap(design, "cert_row_pt", 1.0 * 72.0 / 96.0)
        for idx_n, item in enumerate(items):
            para = container.add_paragraph()
            para.paragraph_format.space_after = Pt(0.0)
            para.paragraph_format.space_before = Pt(0.0 if idx_n == 0 else row_gap)
            _set_exact_line_spacing(para, typo.base_font_pt, typo.line_spacing)
            _emit_cert_entry(para, item, design, prefix=prefix)


def _skill_count(user: User) -> int:
    count = 0
    for item in getattr(user, "technical_skills", None) or []:
        if isinstance(item, dict) and ((item.get("category") or "").strip() or (item.get("skills") or "").strip()):
            count += 1
    return count


# ── Public API ─────────────────────────────────────────────────────────────

def _strip_headers(path: Path) -> None:
    """Drop any header/footer references python-docx injected, so the generated
    template does not reserve phantom header/footer space in LibreOffice."""
    if etree is None:
        return
    try:
        with zipfile.ZipFile(path, "r") as zf:
            document_xml = zf.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile):
        return
    root = etree.fromstring(document_xml)
    # Preserve the intentional first-page header (it carries the full-bleed band); strip
    # every other phantom header/footer ref so continuation pages keep a clean top margin.
    allowed: set[str] = set()
    for ref in root.iter(qn("w:headerReference")):
        if ref.get(qn("w:type")) == "first":
            rid = ref.get(qn("r:id"))
            if rid:
                allowed.add(rid)
    _strip_phantom_header_footer_refs(root, allowed)
    final_xml = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    _replace_docx_internal(path, "word/document.xml", final_xml)


def compile_design(
    design: ResumeDesign,
    user: User,
    out_path: Path,
    *,
    apply_content: bool = False,
) -> tuple[list[str], ResumeTemplateBlueprint]:
    """Build a styled .docx for *design* at *out_path*; return (tags, blueprint).

    When *apply_content* is true and the design carries a manual content override
    (``design.content``), the template is built from that override instead of the user's
    profile. Builder preview/working-template paths opt in; the per-job AI build does not.
    """
    # Render every Calibri design with the bundled, metric-identical Carlito so the
    # .docx/PDF uses the exact same typeface (and therefore the same line wrapping and
    # page breaks) as the live preview, on any OS - the design is deep-copied first so
    # the caller's object is untouched.
    design = design.model_copy(deep=True)
    # Two-column page body (Technical theme) is retired, keep single-column only.
    design.layout.columns = 1
    if design.theme_id == "technical":
        design.theme_id = "classic"
    design.typography.font_family = _render_font_family(design.typography.font_family)
    if apply_content:
        from app.services.resume_content_overlay import apply_content_overlay

        user = apply_content_overlay(user, design.content)
    profile = _profile_dict(user)
    work_rows = _profile_work_rows(user)
    education = _education_rows(user)
    certificates = _certificate_rows(user)
    has_skills = _skill_count(user) > 0
    # One placeholder slot per real work row. (Previously forced to >= 1, which emitted a
    # phantom "Company / Role" entry and a dangling {{EXP_1}} when the profile had none.)
    slot_count = len(work_rows)

    order = [s for s in design.layout.section_order if s not in set(design.layout.hidden_sections)]
    # Skip data-driven sections the profile cannot fill.
    if not has_skills and "skills" in order:
        order.remove("skills")
    if not education and "education" in order:
        order.remove("education")
    if not certificates and "certificates" in order:
        order.remove("certificates")
    if "summary" not in order:
        order.insert(0, "summary")
    if "experience" not in order:
        order.append("experience")

    doc = Document()
    section = doc.sections[0]
    section.top_margin = Pt(design.layout.m_top)
    section.bottom_margin = Pt(design.layout.m_bottom)
    section.left_margin = Pt(design.layout.m_left)
    section.right_margin = Pt(design.layout.m_right)

    normal = doc.styles["Normal"]
    normal.font.name = design.typography.font_family
    normal.font.size = Pt(design.typography.base_font_pt)
    normal.font.color.rgb = _hex_to_rgb(design.colors.text)

    def render_section(container, sec: str) -> None:
        if sec == "summary":
            _render_summary(container, design)
        elif sec == "skills":
            _render_skills(container, design)
        elif sec == "experience":
            _render_experience(container, design, work_rows, slot_count)
        elif sec == "education":
            _render_education(container, design, education)
        elif sec == "certificates":
            _render_certificates(container, design, certificates)

    usable = max(section.page_width - section.left_margin - section.right_margin, Pt(360))
    if design.layout.header_background != "none":
        # First-page header band (flush top) + m_top section margin for pages 2+.
        # Geometry pin is 1pt; visible band height is a behindDoc image (see helper).
        _render_header_band(doc, design, profile, section)
    else:
        _render_header(doc, design, profile, trailing_space_pt=design.layout.hp_bottom)

    if design.layout.columns == 2:
        sidebar = [s for s in order if s in SIDEBAR_SECTIONS]
        main = [s for s in order if s not in SIDEBAR_SECTIONS]
        table = doc.add_table(rows=1, cols=2)
        # Fixed column widths (twips). python-docx's default equal gridCols + autofit
        # confuse dxpdf; pin sidebar/main explicitly like nested contact tables.
        usable_tw = max(1, int(round(float(usable) / 914400.0 * 1440.0)))
        left_tw = max(1, int(round(usable_tw * 0.34)))
        right_tw = max(1, usable_tw - left_tw)
        table.allow_autofit = False
        tbl = table._tbl
        tbl_pr = tbl.tblPr
        for tag in ("w:tblW", "w:tblLayout"):
            for el in tbl_pr.findall(qn(tag)):
                tbl_pr.remove(el)
        tbl_w = OxmlElement("w:tblW")
        tbl_w.set(qn("w:type"), "dxa")
        tbl_w.set(qn("w:w"), str(usable_tw))
        tbl_pr.append(tbl_w)
        layout_el = OxmlElement("w:tblLayout")
        layout_el.set(qn("w:type"), "fixed")
        tbl_pr.append(layout_el)
        tbl_grid = tbl.tblGrid
        for el in list(tbl_grid):
            tbl_grid.remove(el)
        for w in (left_tw, right_tw):
            gc = OxmlElement("w:gridCol")
            gc.set(qn("w:w"), str(w))
            tbl_grid.append(gc)
        left_cell, right_cell = table.rows[0].cells
        for cell, w in ((left_cell, left_tw), (right_cell, right_tw)):
            cell.width = w
            tc_pr = cell._tc.get_or_add_tcPr()
            for el in tc_pr.findall(qn("w:tcW")):
                tc_pr.remove(el)
            tc_w = OxmlElement("w:tcW")
            tc_w.set(qn("w:type"), "dxa")
            tc_w.set(qn("w:w"), str(w))
            tc_pr.insert(0, tc_w)
        for sec in main:
            render_section(right_cell, sec)
        for sec in sidebar:
            render_section(left_cell, sec)
        _remove_leading_empty(left_cell)
        _remove_leading_empty(right_cell)
        # First block in each column should not inherit a large heading_before, that
        # reads as a blank band under the name header on page 1.
        for col_cell in (left_cell, right_cell):
            paras = col_cell.paragraphs
            if paras:
                paras[0].paragraph_format.space_before = Pt(0)
    else:
        for sec in order:
            render_section(doc, sec)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    _strip_headers(out_path)
    # Embed the rendered font so the .docx/PDF looks identical on hosts that lack it.
    _embed_fonts(out_path, [design.typography.font_family])

    tags: list[str] = ["{{PROFILE_SUMMARY}}"]
    if has_skills and "skills" in order:
        tags.append("{{SKILLS_CONTENT}}")
    tags.extend("{{" + f"EXP_{i}" + "}}" for i in range(1, slot_count + 1))

    profile_work_count = count_work_roles(user)
    blueprint = _default_blueprint_from_tags(tags, profile_work_count)
    blueprint.engine = "legacy_exp_n"
    blueprint.ai_validation = ResumeTemplateAiValidation(
        passed=True,
        template_type="legacy_exp_n",
        summary="Generated by the resume builder from your selected theme and layout.",
        detected_required_tags=tags,
    )
    return tags, blueprint
