"""Curated theme presets, font catalog, and color palettes for the resume builder.

Fonts are limited to families that are either standard on Windows/macOS or have
metric-compatible substitutes installed with LibreOffice on the server, so the
docx -> PDF conversion stays faithful to the in-browser preview.
"""

from __future__ import annotations

from app.models.resume_design_schemas import (
    Colors,
    ColorPreset,
    ExperienceStyle,
    FontOption,
    LayoutConfig,
    ResumeDesign,
    ResumeThemeCatalogResponse,
    SectionMeta,
    SectionOptions,
    SkillsStyle,
    SummaryStyle,
    ThemePreset,
    Typography,
)

FONT_OPTIONS: list[FontOption] = [
    FontOption(id="calibri", label="Calibri", family="Calibri", category="sans"),
    FontOption(id="arial", label="Arial", family="Arial", category="sans"),
    FontOption(id="helvetica", label="Helvetica", family="Helvetica", category="sans"),
    FontOption(id="georgia", label="Georgia", family="Georgia", category="serif"),
    FontOption(id="cambria", label="Cambria", family="Cambria", category="serif"),
    FontOption(id="times", label="Times New Roman", family="Times New Roman", category="serif"),
    FontOption(id="garamond", label="Garamond", family="Garamond", category="serif"),
]

COLOR_PRESETS: list[ColorPreset] = [
    ColorPreset(id="slate", label="Slate", colors=Colors(text="#1f2933", heading="#0f172a", accent="#2563eb", muted="#64748b")),
    ColorPreset(id="emerald", label="Emerald", colors=Colors(text="#1f2933", heading="#064e3b", accent="#059669", muted="#6b7280")),
    ColorPreset(id="burgundy", label="Burgundy", colors=Colors(text="#26201f", heading="#3f1d2e", accent="#9f1239", muted="#6b7280")),
    ColorPreset(id="navy", label="Navy", colors=Colors(text="#1f2933", heading="#0b2447", accent="#1d4ed8", muted="#64748b")),
    ColorPreset(id="charcoal", label="Charcoal", colors=Colors(text="#222222", heading="#111111", accent="#111111", muted="#6b7280")),
    ColorPreset(id="violet", label="Violet", colors=Colors(text="#1f2933", heading="#3b0764", accent="#7c3aed", muted="#6b7280")),
]

def _s(
    id: str,
    label: str,
    *,
    surface: str = "none",
    border: str = "none",
    title: str = "above",
    title_accent: str = "none",
    align: str = "left",
    italic: bool = False,
    radius_pt: float = 0,
    pad_pt: float = 10,
) -> SummaryStyle:
    return SummaryStyle(
        id=id,
        label=label,
        surface=surface,  # type: ignore[arg-type]
        border=border,  # type: ignore[arg-type]
        title=title,  # type: ignore[arg-type]
        title_accent=title_accent,  # type: ignore[arg-type]
        align=align,  # type: ignore[arg-type]
        italic=italic,
        radius_pt=radius_pt,
        pad_pt=pad_pt,
    )


# 32 distinct treatments spanning background, border, title position, accent and
# alignment. Every option renders identically in the live preview and the .docx.
SUMMARY_STYLE_PRESETS: list[SummaryStyle] = [
    _s("plain", "Plain", pad_pt=0),
    _s("underline", "Underlined Title", title_accent="underline", pad_pt=0),
    _s("accent-bar", "Accent Bar", title_accent="bar", pad_pt=0),
    _s("left-rule", "Left Rule", border="left", pad_pt=12),
    _s("soft-card", "Soft Card", surface="tint", radius_pt=10, pad_pt=14),
    _s("solid-banner", "Solid Banner", surface="solid", radius_pt=4, pad_pt=14),
    _s("outline-box", "Outline Box", surface="outline", border="full", radius_pt=8, pad_pt=14),
    _s("side-label", "Side Label", title="side", pad_pt=0),
    _s("centered", "Centered", title="centered", align="center", pad_pt=0),
    _s("overline", "Overline Caps", title="overline", pad_pt=0),
    _s("badge", "Badge Title", title="badge", pad_pt=0),
    _s("gradient-wash", "Gradient Wash", surface="gradient", radius_pt=12, pad_pt=16),
    _s("italic-quote", "Italic Quote", border="left", title="hidden", italic=True, pad_pt=12),
    _s("justified", "Justified", title_accent="underline", align="justify", pad_pt=0),
    _s("minimal-hidden", "Headless", title="hidden", pad_pt=0),
    _s("top-rule", "Top Rule", border="top", pad_pt=12),
    _s("bottom-rule", "Bottom Rule", border="bottom", pad_pt=10),
    _s("framed-rails", "Framed Rails", border="x", title="centered", align="center", pad_pt=12),
    _s("tinted-left", "Tinted + Left Bar", surface="tint", border="left", radius_pt=0, pad_pt=14),
    _s("solid-centered", "Solid Centered", surface="solid", title="centered", align="center", radius_pt=4, pad_pt=16),
    _s("card-dot", "Dotted Card", surface="tint", title_accent="dot", radius_pt=14, pad_pt=14),
    _s("box-title", "Boxed Title", title_accent="box", pad_pt=0),
    _s("outline-side", "Outline + Side", surface="outline", border="full", title="side", radius_pt=8, pad_pt=14),
    _s("gradient-center", "Gradient Centered", surface="gradient", title="centered", align="center", radius_pt=12, pad_pt=16),
    _s("italic-centered", "Italic Centered", title="overline", italic=True, align="center", pad_pt=0),
    _s("heavy-left", "Heavy Left", surface="tint", border="left", italic=True, radius_pt=0, pad_pt=14),
    _s("underline-center", "Centered Underline", title="centered", title_accent="underline", align="center", pad_pt=0),
    _s("inline-lead", "Run-in Lead", title="inline", align="left", pad_pt=0),
    _s("soft-justify", "Soft Justified", surface="tint", align="justify", radius_pt=10, pad_pt=14),
    _s("banner-overline", "Banner Overline", surface="solid", title="overline", radius_pt=4, pad_pt=14),
    _s("elegant-rule", "Elegant Justify", title_accent="underline", align="justify", italic=False, pad_pt=0),
    _s("spotlight", "Spotlight", surface="gradient", border="left", title="badge", radius_pt=12, pad_pt=16),
]


def _sk(
    id: str,
    label: str,
    *,
    layout: str = "inline",
    category: str = "bold",
    surface: str = "none",
    divider: bool = False,
    accent_chips: bool = False,
    radius_pt: float = 0,
    pad_pt: float = 6,
) -> SkillsStyle:
    return SkillsStyle(
        id=id,
        label=label,
        layout=layout,  # type: ignore[arg-type]
        category=category,  # type: ignore[arg-type]
        surface=surface,  # type: ignore[arg-type]
        divider=divider,
        accent_chips=accent_chips,
        radius_pt=radius_pt,
        pad_pt=pad_pt,
    )


# 32 distinct skills treatments. Each skill is its own structured unit, but skills
# flow horizontally (chips / comma / pipe) instead of one term per line. Themes vary
# the layout, category label and surface.
SKILLS_STYLE_PRESETS: list[SkillsStyle] = [
    # Inline (Category: a, b, c)
    _sk("inline", "Inline", layout="inline", category="bold"),
    _sk("inline-caps", "Inline Caps", layout="inline", category="caps"),
    _sk("inline-accent", "Inline Accent", layout="inline", category="accent"),
    _sk("inline-bar", "Inline + Bar", layout="inline", category="bar"),
    _sk("tint-inline", "Tinted Inline", layout="inline", category="bold", surface="tint", radius_pt=8, pad_pt=10),
    _sk("badge-inline", "Badge Inline", layout="inline", category="badge"),
    # Pipe (a | b | c)
    _sk("pipe", "Pipe Separated", layout="pipe", category="bold"),
    _sk("pipe-accent", "Pipe Accent", layout="pipe", category="accent"),
    _sk("pipe-caps", "Pipe Caps", layout="pipe", category="caps"),
    # Stacked (label over a flowing line of skills)
    _sk("stacked", "Stacked", layout="stacked", category="bold"),
    _sk("stacked-caps", "Stacked Caps", layout="stacked", category="caps"),
    _sk("stacked-bar", "Stacked + Bar", layout="stacked", category="bar"),
    _sk("stacked-accent", "Stacked Accent", layout="stacked", category="accent"),
    _sk("stacked-divider", "Stacked Divider", layout="stacked", category="bold", divider=True),
    _sk("accent-divider", "Accent Divider", layout="stacked", category="accent", divider=True),
    _sk("tint-stacked", "Tinted Stacked", layout="stacked", category="accent", surface="tint", radius_pt=10, pad_pt=12),
    _sk("card-stacked", "Stacked Cards", layout="stacked", category="bold", surface="card", radius_pt=12, pad_pt=12),
    _sk("badge-stacked", "Badge Stacked", layout="stacked", category="badge"),
    # Chips (each skill a wrapping pill)
    _sk("chips", "Chips", layout="chips", category="bold"),
    _sk("chips-accent", "Accent Chips", layout="chips", category="bold", accent_chips=True),
    _sk("chips-caps", "Chips Caps", layout="chips", category="caps", accent_chips=True),
    _sk("chips-bar", "Barred Chips", layout="chips", category="bar"),
    _sk("chips-badge", "Badge + Chips", layout="chips", category="badge", accent_chips=True),
    _sk("chips-divider", "Chips Divider", layout="chips", category="bold", divider=True),
    _sk("chips-tint", "Tinted Chips", layout="chips", category="bold", surface="tint", radius_pt=10, pad_pt=10),
    _sk("chips-tint-accent", "Tinted Accent Chips", layout="chips", category="accent", surface="tint", radius_pt=10, pad_pt=10, accent_chips=True),
    _sk("chips-card", "Chip Cards", layout="chips", category="bold", surface="card", radius_pt=12, pad_pt=12, accent_chips=True),
    # Grid (category label beside a flowing line of skills)
    _sk("grid", "Two Column", layout="grid", category="bold"),
    _sk("grid-caps", "Two Column Caps", layout="grid", category="caps"),
    _sk("grid-accent", "Two Column Accent", layout="grid", category="accent"),
    _sk("grid-chips", "Grid Chips", layout="grid", category="bold", accent_chips=True),
    _sk("grid-badge", "Grid Badge", layout="grid", category="badge", accent_chips=True),
]


def _e(
    id: str,
    label: str,
    *,
    header_layout: str = "inline",
    date_position: str = "right",
    surface: str = "none",
    accent_target: str = "company",
    project_style: str = "label",
    intro_style: str = "plain",
    marker: str = "dot",
    label_style: str = "plain",
    used_skills_style: str = "inline",
    badge_style: str = "inline",
    show_employment_type: bool = True,
    show_arrangement: bool = False,
    show_project_title: bool = True,
    show_intro: bool = True,
    show_used_skills: bool = True,
    show_contributions_label: bool = True,
    radius_pt: float = 0,
    pad_pt: float = 0,
    entry_gap_pt: float = 8,
) -> ExperienceStyle:
    return ExperienceStyle(
        id=id,
        label=label,
        header_layout=header_layout,  # type: ignore[arg-type]
        date_position=date_position,  # type: ignore[arg-type]
        surface=surface,  # type: ignore[arg-type]
        accent_target=accent_target,  # type: ignore[arg-type]
        project_style=project_style,  # type: ignore[arg-type]
        intro_style=intro_style,  # type: ignore[arg-type]
        marker=marker,  # type: ignore[arg-type]
        label_style=label_style,  # type: ignore[arg-type]
        used_skills_style=used_skills_style,  # type: ignore[arg-type]
        badge_style=badge_style,  # type: ignore[arg-type]
        show_employment_type=show_employment_type,
        show_arrangement=show_arrangement,
        show_project_title=show_project_title,
        show_intro=show_intro,
        show_used_skills=show_used_skills,
        show_contributions_label=show_contributions_label,
        radius_pt=radius_pt,
        pad_pt=pad_pt,
        entry_gap_pt=entry_gap_pt,
    )


# 36 distinct work-experience treatments. Themes vary the header layout, date
# placement, entry surface, project-title / intro / contribution-marker styling and
# the used-skills presentation. The show_* flags set sensible per-theme defaults for
# the control board; users can override any of them.
EXPERIENCE_STYLE_PRESETS: list[ExperienceStyle] = [
    # --- Classic / inline header, date right-aligned (the default) ---
    _e("classic", "Classic", marker="dot", label_style="plain"),
    _e("classic-dash", "Classic Dash", marker="dash"),
    _e("classic-arrow", "Arrow Impact", marker="arrow"),
    _e("classic-chevron", "Chevron", marker="chevron"),
    _e("classic-square", "Square Bullets", marker="square"),
    _e("classic-diamond", "Diamond Bullets", marker="diamond"),
    _e("numbered", "Numbered Impact", marker="numbered", label_style="bold"),
    _e("no-label", "Clean (No Label)", marker="dot", label_style="hidden"),
    _e("caps-label", "Caps Label", marker="dot", label_style="caps"),
    _e("accent-label", "Accent Label", marker="dot", label_style="accent"),
    # --- Date inline with the header ---
    _e("inline-date", "Inline Date", date_position="inline", marker="dot"),
    _e("inline-date-dash", "Inline Date Dash", date_position="inline", marker="dash"),
    _e("right-accent-date", "Accent Date", date_position="right", accent_target="date", marker="dot"),
    _e("right-arrow", "Right Date Arrow", date_position="right", marker="arrow", label_style="hidden"),
    # --- Date below header (muted sub-line) ---
    _e("subline", "Sub-line Date", date_position="below", marker="dot"),
    _e("subline-caps", "Sub-line Caps", date_position="below", marker="dot", label_style="caps"),
    _e("subline-italic-intro", "Italic Intro", date_position="below", marker="dot", intro_style="italic"),
    # --- Stacked header (company over role) ---
    _e("stacked", "Stacked Header", header_layout="stacked", date_position="below", marker="dot"),
    _e("stacked-accent-role", "Stacked Accent Role", header_layout="stacked", date_position="below", accent_target="role", marker="dash"),
    _e("stacked-arrow", "Stacked Arrow", header_layout="stacked", date_position="right", marker="arrow"),
    # --- Two-column (header left, date column right) ---
    _e("two-col", "Two Column", header_layout="two_column", date_position="right", marker="dot"),
    _e("two-col-chevron", "Two Column Chevron", header_layout="two_column", date_position="right", marker="chevron"),
    _e("two-col-accent", "Two Column Accent", header_layout="two_column", date_position="right", accent_target="company", marker="dash", label_style="hidden"),
    # --- Timeline / left bar surfaces ---
    _e("timeline", "Timeline Rail", surface="left_bar", date_position="below", marker="dot", pad_pt=10, entry_gap_pt=12),
    _e("timeline-arrow", "Timeline Arrow", surface="left_bar", date_position="below", marker="arrow", pad_pt=10, entry_gap_pt=12),
    _e("accent-rail", "Accent Rail", surface="left_bar", date_position="right", accent_target="company", marker="dot", pad_pt=12, entry_gap_pt=14),
    # --- Divider between entries ---
    _e("divider", "Divider", surface="divider", date_position="inline", marker="dot", entry_gap_pt=12),
    _e("divider-right", "Divider + Right Date", surface="divider", date_position="right", marker="dash", entry_gap_pt=12),
    _e("divider-caps", "Divider Caps", surface="divider", date_position="below", marker="dot", label_style="caps", entry_gap_pt=12),
    # --- Card / tinted surfaces ---
    _e("card", "Card", surface="card", date_position="right", marker="dot", radius_pt=12, pad_pt=14, entry_gap_pt=14),
    _e("card-chips", "Card + Tech Chips", surface="card", date_position="right", marker="dot", used_skills_style="chips", radius_pt=12, pad_pt=14, entry_gap_pt=14),
    _e("tint", "Tinted", surface="tint", date_position="below", marker="dot", radius_pt=10, pad_pt=12, entry_gap_pt=12),
    _e("tint-accent", "Tinted Accent", surface="tint", date_position="right", accent_target="company", marker="dash", radius_pt=10, pad_pt=12, entry_gap_pt=12),
    # --- Project / skills emphasis ---
    _e("project-bold", "Bold Project", project_style="bold", marker="dot"),
    _e("project-accent", "Accent Project", project_style="accent", marker="dot"),
    _e("project-italic", "Italic Project", project_style="italic", intro_style="italic", marker="dash"),
    _e("tech-chips", "Tech Chips", used_skills_style="chips", marker="dot", show_arrangement=True),
    _e("tech-pill", "Tech Pills", used_skills_style="pill", marker="chevron"),
    _e("tech-label", "Tech Labelled", used_skills_style="label", marker="dot"),
    _e("badge-pill", "Pill Badges", badge_style="pill", show_arrangement=True, marker="dot"),
    _e("compact", "Compact", date_position="right", marker="dash", show_intro=False, show_contributions_label=False, entry_gap_pt=6),
    _e("minimal-clean", "Minimal Clean", date_position="right", marker="none", project_style="hidden", show_contributions_label=False, label_style="hidden"),
]


SECTION_META: list[SectionMeta] = [
    SectionMeta(id="summary", label="Professional summary", description="One tailored paragraph per application."),
    SectionMeta(id="skills", label="Technical skills", description="Tailored skill categories."),
    SectionMeta(id="experience", label="Work experience", description="One tailored slot per role."),
    SectionMeta(id="education", label="Education", description="From your profile."),
    SectionMeta(id="certificates", label="Certifications", description="From your profile."),
]


def _design(
    *,
    theme_id: str,
    font: str,
    colors: Colors,
    columns: int = 1,
    uppercase: bool = True,
    heading_scale: float = 1.25,
    name_scale: float = 2.0,
    header_align: str = "left",
    accent_rule: bool = True,
    header_background: str = "none",
) -> ResumeDesign:
    return ResumeDesign(
        theme_id=theme_id,
        typography=Typography(
            font_family=font,
            heading_scale=heading_scale,
            name_scale=name_scale,
            uppercase_headings=uppercase,
        ),
        colors=colors,
        layout=LayoutConfig(
            columns=columns,  # type: ignore[arg-type]
            header_align=header_align,  # type: ignore[arg-type]
            accent_rule=accent_rule,
            header_background=header_background,  # type: ignore[arg-type]
        ),
        sections=SectionOptions(),
    )


THEME_PRESETS: list[ThemePreset] = [
    ThemePreset(
        id="classic",
        label="Classic",
        description="Timeless single-column layout with accent rules under each heading.",
        accent_swatch="#2563eb",
        design=_design(theme_id="classic", font="Calibri", colors=COLOR_PRESETS[0].colors),
    ),
    ThemePreset(
        id="modern",
        label="Modern",
        description="Clean sans-serif, centered name, and a colored accent.",
        accent_swatch="#059669",
        design=_design(
            theme_id="modern",
            font="Arial",
            colors=COLOR_PRESETS[1].colors,
            header_align="center",
            heading_scale=1.18,
            header_background="solid",
        ),
    ),
    ThemePreset(
        id="executive",
        label="Executive",
        description="Serif typography with understated, no-rule headings for a refined look.",
        accent_swatch="#9f1239",
        design=_design(
            theme_id="executive",
            font="Georgia",
            colors=COLOR_PRESETS[2].colors,
            uppercase=False,
            heading_scale=1.35,
            name_scale=2.2,
            accent_rule=False,
        ),
    ),
    ThemePreset(
        id="technical",
        label="Technical",
        description="Two-column layout with a skills/education sidebar - great for engineers.",
        accent_swatch="#1d4ed8",
        design=_design(
            theme_id="technical",
            font="Calibri",
            colors=COLOR_PRESETS[3].colors,
            columns=2,
            heading_scale=1.15,
            name_scale=1.9,
            header_background="soft",
        ),
    ),
    ThemePreset(
        id="minimal",
        label="Minimal",
        description="Monochrome, no accent rules, generous spacing - maximum readability.",
        accent_swatch="#111111",
        design=_design(
            theme_id="minimal",
            font="Helvetica",
            colors=COLOR_PRESETS[4].colors,
            accent_rule=False,
            heading_scale=1.12,
            name_scale=1.8,
        ),
    ),
]

_THEME_BY_ID = {preset.id: preset for preset in THEME_PRESETS}


def default_design() -> ResumeDesign:
    return _THEME_BY_ID["classic"].design.model_copy(deep=True)


def get_theme(theme_id: str | None) -> ThemePreset | None:
    if not theme_id:
        return None
    return _THEME_BY_ID.get(theme_id)


def build_catalog() -> ResumeThemeCatalogResponse:
    return ResumeThemeCatalogResponse(
        themes=[t.model_copy(deep=True) for t in THEME_PRESETS],
        fonts=list(FONT_OPTIONS),
        color_presets=list(COLOR_PRESETS),
        sections=list(SECTION_META),
        summary_styles=[s.model_copy(deep=True) for s in SUMMARY_STYLE_PRESETS],
        skills_styles=[s.model_copy(deep=True) for s in SKILLS_STYLE_PRESETS],
        experience_styles=[e.model_copy(deep=True) for e in EXPERIENCE_STYLE_PRESETS],
    )
