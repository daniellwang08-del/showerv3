"""Compile a ResumeDesign into a styled cover letter .docx template.

The cover letter reuses the *exact same* template as the resume: the same styled
header band (name, title, contacts, colors, typography, fonts) and the same section
styling. The only difference is that the single rendered section relabels the
"Professional Summary" heading to "Cover Letter" and carries a
``{{COVER_LETTER_BODY}}`` placeholder instead of the profile summary - all other
resume sections (skills, experience, education, certificates) are intentionally
omitted. The AI-generated body (greeting, paragraphs, and sign-off) is dropped into
that placeholder by the existing ``fill_cover_letter_template`` pipeline.
"""

from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.shared import Pt

from app.models.database import User
from app.models.resume_design_schemas import ResumeDesign
from app.services.resume_design_compiler import (
    _embed_fonts,
    _hex_to_rgb,
    _profile_dict,
    _render_font_family,
    _render_header,
    _render_header_band,
    _render_summary,
    _strip_headers,
)

COVER_LETTER_BODY_TAG = "{{COVER_LETTER_BODY}}"
_COVER_LETTER_TITLE = "Cover Letter"


def compile_cover_letter_design(design: ResumeDesign, user: User, out_path: Path) -> list[str]:
    """Build a styled cover letter .docx for *design* at *out_path*; return detected tags.

    Produces the identical letterhead/theme as the resume template and a single
    "Cover Letter" section whose body is the ``{{COVER_LETTER_BODY}}`` placeholder.
    """
    # Render with the same bundled face the resume uses so the .docx/PDF matches the
    # live preview on any host. Deep-copy so the caller's design object is untouched.
    design = design.model_copy(deep=True)
    design.typography.font_family = _render_font_family(design.typography.font_family)

    profile = _profile_dict(user)

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

    # Identical header to the resume (band when a header background is set, otherwise
    # the plain inline header) so the two documents share one letterhead.
    if design.layout.header_background != "none":
        _render_header_band(doc, design, profile, section)
    else:
        _render_header(doc, design, profile, trailing_space_pt=design.layout.hp_bottom)

    # The only body section: the summary block relabeled "Cover Letter", holding the
    # body placeholder. All other resume sections are intentionally left out.
    _render_summary(doc, design, title=_COVER_LETTER_TITLE, tag=COVER_LETTER_BODY_TAG)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    _strip_headers(out_path)
    _embed_fonts(out_path, [design.typography.font_family])
    return [COVER_LETTER_BODY_TAG]
