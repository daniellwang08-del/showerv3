"""Pydantic models for the visual resume design builder.

A *design* is a pure styling/layout config (theme + typography + colors + section
arrangement). The backend compiles it into a styled .docx template that already
carries the placeholder tags ({{PROFILE_SUMMARY}}, {{SKILLS_CONTENT}}, {{EXP_N}}, …)
so the existing fill + PDF pipeline renders it unchanged.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SectionId = Literal["summary", "skills", "experience", "education", "certificates"]
HeaderAlign = Literal["left", "center"]
ContactLayout = Literal["inline", "stacked"]
SkillsLayout = Literal["categories", "inline"]
HeaderBackground = Literal["none", "soft", "solid", "image"]
ContactIconStyle = Literal["brand", "outline", "none"]
HeaderImageText = Literal["light", "dark"]

SummarySurface = Literal["none", "tint", "solid", "gradient", "outline"]
SummaryBorder = Literal["none", "full", "left", "top", "bottom", "x"]
SummaryTitleMode = Literal["above", "hidden", "inline", "side", "centered", "overline", "badge"]
SummaryTitleAccent = Literal["none", "underline", "bar", "box", "dot"]
SummaryAlign = Literal["left", "center", "justify"]

SkillsLayoutMode = Literal["inline", "stacked", "bullets", "chips", "pipe", "grid"]
SkillsCategoryStyle = Literal["bold", "caps", "accent", "bar", "badge"]
SkillsSurface = Literal["none", "tint", "card"]

ExperienceHeaderLayout = Literal["inline", "stacked", "two_column"]
ExperienceDatePosition = Literal["inline", "right", "below"]
ExperienceSurface = Literal["none", "divider", "left_bar", "card", "tint"]
ExperienceAccentTarget = Literal["company", "role", "date", "none"]
ExperienceProjectStyle = Literal["label", "bold", "italic", "accent", "hidden"]
ExperienceIntroStyle = Literal["plain", "italic", "indented", "hidden"]
ExperienceMarker = Literal["dot", "dash", "arrow", "chevron", "square", "diamond", "numbered", "none"]
ExperienceLabelStyle = Literal["hidden", "plain", "bold", "caps", "accent"]
ExperienceSkillsStyle = Literal["chips", "inline", "label", "pill", "hidden"]
ExperienceBadgeStyle = Literal["inline", "pill", "hidden"]

EducationHeaderLayout = Literal["inline", "stacked"]
EducationDatePosition = Literal["inline", "right", "below"]
EducationSurface = Literal["none", "divider", "left_bar", "card", "tint"]
EducationAccentTarget = Literal["university", "degree", "none"]

CertificatesLayout = Literal["list", "inline", "pipe", "chips", "grid"]
CertificatesMarker = Literal["dot", "dash", "check", "arrow", "square", "none"]
CertificatesSurface = Literal["none", "tint", "card"]

DEFAULT_SECTION_ORDER: list[str] = ["summary", "skills", "experience", "education", "certificates"]
SIDEBAR_SECTIONS: list[str] = ["skills", "education", "certificates"]


class Typography(BaseModel):
    font_family: str = "Calibri"
    base_font_pt: float = Field(default=10.5, ge=8, le=14)
    heading_scale: float = Field(default=1.25, ge=1.0, le=2.2)
    name_scale: float = Field(default=2.0, ge=1.4, le=3.5)
    line_spacing: float = Field(default=1.12, ge=1.0, le=2.0)
    uppercase_headings: bool = True


class Colors(BaseModel):
    text: str = "#1f2933"
    heading: str = "#0f172a"
    accent: str = "#2563eb"
    muted: str = "#64748b"


class HeaderImage(BaseModel):
    """A header-band background image.

    The frontend crops the chosen/uploaded image to the band's exact aspect ratio,
    bakes in the legibility overlay, and compresses it, so ``data_url`` holds ONLY
    the pixels actually shown - keeping the stored design and the embedded .docx
    asset small. The same single image drives the live preview (CSS background) and
    the generated .docx (full-bleed picture behind the header text)."""

    data_url: str = Field(..., max_length=8_000_000)  # data:image/webp;base64,...
    # band width / band height the crop was produced at (used to size the .docx band).
    aspect: float = Field(default=5.0, ge=1.0, le=14.0)
    # "preset:<id>" for the built-in library, or "upload" for a user file.
    source: str = "upload"
    # Baked overlay strength + text treatment (informational; overlay is baked in).
    overlay: float = Field(default=0.4, ge=0.0, le=0.9)
    text: HeaderImageText = "light"


class HeaderMetrics(BaseModel):
    """Exact header-band geometry measured in the browser preview (pt).

    The live preview lays out the band with real font line-boxes; the backend can
    only *estimate* the same height. To make the .docx band pixel-identical to what
    the user designed, the preview measures the rendered band and reports it here, and
    the compiler pins the band to ``band_pt`` instead of using its own estimate.
    Values are ``None`` for older designs / before the preview has measured, in which
    case the compiler falls back to the estimate."""

    # Total outer band height (top padding + content + bottom padding), in points.
    band_pt: float | None = Field(default=None, ge=0, le=600)
    # Distance from the band's bottom edge to the top of the first content block (pt).
    gap_pt: float | None = Field(default=None, ge=0, le=400)
    # Width the band was measured at (px); lets the compiler ignore stale measurements
    # taken at a different reference width.
    measured_at_px: float | None = Field(default=None, ge=0, le=4000)


class LayoutMetrics(BaseModel):
    """Per-role vertical gaps (pt) measured from the rendered browser preview.

    The live preview is the single source of truth for spacing: it lays out the exact
    CSS (line-height, per-element margins, padding) the user designed. Rather than the
    backend re-deriving those gaps (px->pt conversion + CSS margin-collapsing, which
    Word does not replicate), the preview measures the realized gap *before* each kind
    of block and reports it here. The compiler/fill engine then apply each paragraph's
    ``space_before`` directly from these values (with ``space_after = 0`` everywhere),
    so the .docx reproduces the preview pixel-for-pixel regardless of how the user
    changes the schema. Every field is ``None`` until the preview measures, in which
    case the backend falls back to its built-in defaults."""

    # Section heading: gap above it (the section gap) and below it (heading -> first row).
    heading_before_pt: float | None = Field(default=None, ge=0, le=120)
    heading_after_pt: float | None = Field(default=None, ge=0, le=120)
    # Work-experience body gaps.
    exp_lead_pt: float | None = Field(default=None, ge=0, le=120)
    exp_label_pt: float | None = Field(default=None, ge=0, le=120)
    exp_bullet_pt: float | None = Field(default=None, ge=0, le=120)
    exp_used_pt: float | None = Field(default=None, ge=0, le=120)
    # Company-to-company gap (the entry wrapper's bottom margin).
    exp_company_pt: float | None = Field(default=None, ge=0, le=120)
    # Repeated-row gaps for the data-driven sections.
    skill_row_pt: float | None = Field(default=None, ge=0, le=120)
    edu_entry_pt: float | None = Field(default=None, ge=0, le=120)
    cert_row_pt: float | None = Field(default=None, ge=0, le=120)
    measured_at_px: float | None = Field(default=None, ge=0, le=4000)


class LayoutConfig(BaseModel):
    columns: Literal[1, 2] = 1
    # ``margin_pt`` / ``header_padding_pt`` remain as the legacy single-value source so
    # older saved designs still parse; the per-side fields override them when present.
    margin_pt: float = Field(default=54, ge=9, le=160)
    margin_top_pt: float | None = Field(default=None, ge=9, le=160)
    margin_right_pt: float | None = Field(default=None, ge=9, le=160)
    margin_bottom_pt: float | None = Field(default=None, ge=9, le=160)
    margin_left_pt: float | None = Field(default=None, ge=9, le=160)
    section_gap_pt: float = Field(default=10, ge=2, le=28)
    header_align: HeaderAlign = "left"
    header_background: HeaderBackground = "none"
    header_padding_pt: float = Field(default=16, ge=0, le=120)
    header_pad_top_pt: float | None = Field(default=None, ge=0, le=120)
    header_pad_right_pt: float | None = Field(default=None, ge=0, le=120)
    header_pad_bottom_pt: float | None = Field(default=None, ge=0, le=120)
    header_pad_left_pt: float | None = Field(default=None, ge=0, le=120)
    header_image: HeaderImage | None = None
    # Browser-measured band geometry (pt); when present the compiler pins the band to
    # these exact values instead of estimating, so preview and PDF match to the point.
    header_metrics: HeaderMetrics | None = None
    # Browser-measured per-role body spacing (pt); when present the compiler/fill engine
    # apply these exact gaps so the .docx matches the preview after any schema change.
    layout_metrics: LayoutMetrics | None = None
    contact_layout: ContactLayout = "inline"
    contact_icons: ContactIconStyle = "brand"
    # Manual icon↔text alignment (pt). Positive X = icon right; positive Y = icon down.
    # Preview and PDF both honor these so users can correct theme-specific dxpdf drift.
    contact_icon_offset_x_pt: float = Field(default=0.0, ge=-6.0, le=6.0)
    contact_icon_offset_y_pt: float = Field(default=0.0, ge=-6.0, le=6.0)
    accent_rule: bool = True
    section_order: list[str] = Field(default_factory=lambda: list(DEFAULT_SECTION_ORDER))
    hidden_sections: list[str] = Field(default_factory=list)

    # ── Effective per-side values (override → legacy single value) ──────────
    @property
    def m_top(self) -> float:
        return self.margin_top_pt if self.margin_top_pt is not None else self.margin_pt

    @property
    def m_right(self) -> float:
        return self.margin_right_pt if self.margin_right_pt is not None else self.margin_pt

    @property
    def m_bottom(self) -> float:
        return self.margin_bottom_pt if self.margin_bottom_pt is not None else self.margin_pt

    @property
    def m_left(self) -> float:
        return self.margin_left_pt if self.margin_left_pt is not None else self.margin_pt

    @property
    def hp_top(self) -> float:
        return self.header_pad_top_pt if self.header_pad_top_pt is not None else self.header_padding_pt

    @property
    def hp_bottom(self) -> float:
        return self.header_pad_bottom_pt if self.header_pad_bottom_pt is not None else self.header_padding_pt

    @property
    def hp_left(self) -> float:
        # Header text aligns with the body left margin unless overridden.
        return self.header_pad_left_pt if self.header_pad_left_pt is not None else self.m_left

    @property
    def hp_right(self) -> float:
        return self.header_pad_right_pt if self.header_pad_right_pt is not None else self.m_right


class SummaryStyle(BaseModel):
    """Visual treatment for the Professional Summary section. The same tokens drive
    the live preview (CSS) and the generated .docx (shaded/bordered container table)."""

    id: str = "plain"
    label: str = "Plain"
    surface: SummarySurface = "none"
    border: SummaryBorder = "none"
    title: SummaryTitleMode = "above"
    title_accent: SummaryTitleAccent = "none"
    align: SummaryAlign = "left"
    italic: bool = False
    radius_pt: float = Field(default=0, ge=0, le=24)
    pad_pt: float = Field(default=10, ge=0, le=28)


class SkillsStyle(BaseModel):
    """Visual treatment for the Technical Skills section. Each skill within a category
    is split into its own structured unit (chip / bullet / segment). Drives the live
    preview (CSS) and the generated .docx identically."""

    id: str = "inline"
    label: str = "Inline"
    layout: SkillsLayoutMode = "inline"
    category: SkillsCategoryStyle = "bold"
    surface: SkillsSurface = "none"
    divider: bool = False
    accent_chips: bool = False
    radius_pt: float = Field(default=0, ge=0, le=24)
    pad_pt: float = Field(default=6, ge=0, le=24)


class ExperienceStyle(BaseModel):
    """Visual treatment + per-item control board for the Work Experience section.

    A single set of tokens drives both the live preview (CSS) and the generated .docx
    so each company entry renders identically. ``show_*`` flags act as the control
    board for the optional sub-items (employment type, arrangement, project title,
    intro, used skills, contributions label); themes set sensible defaults that the
    user can override."""

    id: str = "classic"
    label: str = "Classic"
    # Layout
    header_layout: ExperienceHeaderLayout = "inline"
    date_position: ExperienceDatePosition = "right"
    surface: ExperienceSurface = "none"
    accent_target: ExperienceAccentTarget = "company"
    # Item styling
    project_style: ExperienceProjectStyle = "label"
    intro_style: ExperienceIntroStyle = "plain"
    marker: ExperienceMarker = "dot"
    label_style: ExperienceLabelStyle = "plain"
    used_skills_style: ExperienceSkillsStyle = "inline"
    badge_style: ExperienceBadgeStyle = "inline"
    # Control board: optional item visibility
    show_employment_type: bool = True
    show_arrangement: bool = False
    show_project_title: bool = True
    show_intro: bool = True
    show_used_skills: bool = True
    show_contributions_label: bool = True
    # Geometry
    radius_pt: float = Field(default=0, ge=0, le=24)
    pad_pt: float = Field(default=0, ge=0, le=28)
    entry_gap_pt: float = Field(default=8, ge=0, le=28)


class EducationStyle(BaseModel):
    """Control board for the Education section (no theme gallery). Drives both the
    live preview and the generated .docx so entries render identically."""

    header_layout: EducationHeaderLayout = "inline"
    date_position: EducationDatePosition = "right"
    surface: EducationSurface = "none"
    accent_target: EducationAccentTarget = "university"
    show_period: bool = True
    show_location: bool = True
    show_mark: bool = True
    show_description: bool = True
    radius_pt: float = Field(default=0, ge=0, le=24)
    pad_pt: float = Field(default=0, ge=0, le=28)
    entry_gap_pt: float = Field(default=6, ge=0, le=28)


class CertificatesStyle(BaseModel):
    """Control board for the Certifications section (no theme gallery)."""

    layout: CertificatesLayout = "list"
    marker: CertificatesMarker = "dot"
    columns: Literal[1, 2] = 1
    accent_chips: bool = False
    surface: CertificatesSurface = "none"
    radius_pt: float = Field(default=0, ge=0, le=24)
    pad_pt: float = Field(default=6, ge=0, le=24)


class SectionOptions(BaseModel):
    skills_layout: SkillsLayout = "categories"
    show_period: bool = True
    show_location: bool = True
    summary_style: SummaryStyle = Field(default_factory=SummaryStyle)
    skills_style: SkillsStyle = Field(default_factory=SkillsStyle)
    experience_style: ExperienceStyle = Field(default_factory=ExperienceStyle)
    education_style: EducationStyle = Field(default_factory=EducationStyle)
    certificates_style: CertificatesStyle = Field(default_factory=CertificatesStyle)


class ContentSkill(BaseModel):
    category: str = ""
    skills: str = ""


class ContentWork(BaseModel):
    company_name: str = ""
    job_title: str = ""
    period_start: str = ""
    period_end: str = ""
    location: str = ""
    job_type: str = ""
    employment_type: str = ""
    project_title: str = ""
    project_intro: str = ""
    contributions: list[str] = Field(default_factory=list)
    used_skills: str = ""
    description: str = ""


class ContentEducation(BaseModel):
    university_name: str = ""
    degree: str = ""
    mark: str = ""
    period_start: str = ""
    period_end: str = ""
    location: str = ""
    description: str = ""


class ContentCertificate(BaseModel):
    name: str = ""
    issued_at: str = ""
    url: str = ""


class ResumeContent(BaseModel):
    """Per-design manual content override.

    When present, the builder's live preview, PDF preview and downloadable working
    template render from THIS content instead of the user's master profile. Free-text
    fields may carry inline markup (``**bold**`` / ``*italic*`` / ``__underline__``) which
    is rendered as real runs in the DOCX and as styled spans in the preview. Per-job
    AI-tailored builds intentionally ignore this override and keep using the profile."""

    name_first: str = ""
    name_middle: str = ""
    name_last: str = ""
    title: str = ""
    email: str = ""
    phone_country_code: str = ""
    phone_number: str = ""
    linkedin_url: str = ""
    github_url: str = ""
    profile_summary: str = ""
    technical_skills: list[ContentSkill] = Field(default_factory=list)
    work_experience: list[ContentWork] = Field(default_factory=list)
    education: list[ContentEducation] = Field(default_factory=list)
    certificates: list[ContentCertificate] = Field(default_factory=list)


class ResumeDesign(BaseModel):
    theme_id: str = "classic"
    typography: Typography = Field(default_factory=Typography)
    colors: Colors = Field(default_factory=Colors)
    layout: LayoutConfig = Field(default_factory=LayoutConfig)
    sections: SectionOptions = Field(default_factory=SectionOptions)
    # Optional manual content override authored in the builder's Content panel.
    content: ResumeContent | None = None


class ThemePreset(BaseModel):
    id: str
    label: str
    description: str
    accent_swatch: str
    design: ResumeDesign
    is_custom: bool = False
    is_loved: bool = False


class SaveCustomThemeRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    design: ResumeDesign


class ToggleThemeLoveResponse(BaseModel):
    theme_id: str
    is_loved: bool


class CustomThemeMutationResponse(BaseModel):
    theme: ThemePreset
    themes: list[ThemePreset] = Field(default_factory=list)


class FontOption(BaseModel):
    id: str
    label: str
    family: str
    category: Literal["sans", "serif"]


class ColorPreset(BaseModel):
    id: str
    label: str
    colors: Colors


class SectionMeta(BaseModel):
    id: SectionId
    label: str
    description: str = ""


class ResumeThemeCatalogResponse(BaseModel):
    themes: list[ThemePreset] = Field(default_factory=list)
    fonts: list[FontOption] = Field(default_factory=list)
    color_presets: list[ColorPreset] = Field(default_factory=list)
    sections: list[SectionMeta] = Field(default_factory=list)
    summary_styles: list[SummaryStyle] = Field(default_factory=list)
    skills_styles: list[SkillsStyle] = Field(default_factory=list)
    experience_styles: list[ExperienceStyle] = Field(default_factory=list)


class ResumeDesignResponse(BaseModel):
    has_design: bool = False
    design: ResumeDesign
    profile_work_count: int = 0
    resume_template_status: str = "missing"
    resume_template_ready: bool = False


class ResumeDesignSaveRequest(BaseModel):
    design: ResumeDesign
