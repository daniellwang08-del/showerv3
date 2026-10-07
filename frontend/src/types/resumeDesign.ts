export type SectionId = 'summary' | 'skills' | 'experience' | 'education' | 'certificates';
export type HeaderAlign = 'left' | 'center';
export type ContactLayout = 'inline' | 'stacked';
export type SkillsLayout = 'categories' | 'inline';
export type HeaderBackground = 'none' | 'soft' | 'solid' | 'image';
export type HeaderImageText = 'light' | 'dark';

export interface HeaderImage {
  /** Cropped + overlay-baked + compressed image (only the pixels shown). */
  data_url: string;
  /** band width / band height the crop was produced at (sizes the .docx band). */
  aspect: number;
  /** "preset:<id>" for the built-in library, or "upload" for a user file. */
  source: string;
  /** Baked overlay strength (informational) + text treatment. */
  overlay: number;
  text: HeaderImageText;
}
export type ContactIconStyle = 'brand' | 'outline' | 'none';

export type SummarySurface = 'none' | 'tint' | 'solid' | 'gradient' | 'outline';
export type SummaryBorder = 'none' | 'full' | 'left' | 'top' | 'bottom' | 'x';
export type SummaryTitleMode = 'above' | 'hidden' | 'inline' | 'side' | 'centered' | 'overline' | 'badge';
export type SummaryTitleAccent = 'none' | 'underline' | 'bar' | 'box' | 'dot';
export type SummaryAlign = 'left' | 'center' | 'justify';

export type SkillsLayoutMode = 'inline' | 'stacked' | 'bullets' | 'chips' | 'pipe' | 'grid';
export type SkillsCategoryStyle = 'bold' | 'caps' | 'accent' | 'bar' | 'badge';
export type SkillsSurface = 'none' | 'tint' | 'card';

export type ExperienceHeaderLayout = 'inline' | 'stacked' | 'two_column';
export type ExperienceDatePosition = 'inline' | 'right' | 'below';
export type ExperienceSurface = 'none' | 'divider' | 'left_bar' | 'card' | 'tint';
export type ExperienceAccentTarget = 'company' | 'role' | 'date' | 'none';
export type ExperienceProjectStyle = 'label' | 'bold' | 'italic' | 'accent' | 'hidden';
export type ExperienceIntroStyle = 'plain' | 'italic' | 'indented' | 'hidden';
export type ExperienceMarker = 'dot' | 'dash' | 'arrow' | 'chevron' | 'square' | 'diamond' | 'numbered' | 'none';
export type ExperienceLabelStyle = 'hidden' | 'plain' | 'bold' | 'caps' | 'accent';
export type ExperienceSkillsStyle = 'chips' | 'inline' | 'label' | 'pill' | 'hidden';
export type ExperienceBadgeStyle = 'inline' | 'pill' | 'hidden';

export type EducationHeaderLayout = 'inline' | 'stacked';
export type EducationDatePosition = 'inline' | 'right' | 'below';
export type EducationSurface = 'none' | 'divider' | 'left_bar' | 'card' | 'tint';
export type EducationAccentTarget = 'university' | 'degree' | 'none';

export type CertificatesLayout = 'list' | 'inline' | 'pipe' | 'chips' | 'grid';
export type CertificatesMarker = 'dot' | 'dash' | 'check' | 'arrow' | 'square' | 'none';
export type CertificatesSurface = 'none' | 'tint' | 'card';

export interface EducationStyle {
  header_layout: EducationHeaderLayout;
  date_position: EducationDatePosition;
  surface: EducationSurface;
  accent_target: EducationAccentTarget;
  show_period: boolean;
  show_location: boolean;
  show_mark: boolean;
  show_description: boolean;
  radius_pt: number;
  pad_pt: number;
  entry_gap_pt: number;
}

export interface CertificatesStyle {
  layout: CertificatesLayout;
  marker: CertificatesMarker;
  columns: 1 | 2;
  accent_chips: boolean;
  surface: CertificatesSurface;
  radius_pt: number;
  pad_pt: number;
}

export interface ExperienceStyle {
  id: string;
  label: string;
  header_layout: ExperienceHeaderLayout;
  date_position: ExperienceDatePosition;
  surface: ExperienceSurface;
  accent_target: ExperienceAccentTarget;
  project_style: ExperienceProjectStyle;
  intro_style: ExperienceIntroStyle;
  marker: ExperienceMarker;
  label_style: ExperienceLabelStyle;
  used_skills_style: ExperienceSkillsStyle;
  badge_style: ExperienceBadgeStyle;
  show_employment_type: boolean;
  show_arrangement: boolean;
  show_project_title: boolean;
  show_intro: boolean;
  show_used_skills: boolean;
  show_contributions_label: boolean;
  radius_pt: number;
  pad_pt: number;
  entry_gap_pt: number;
}

export interface SkillsStyle {
  id: string;
  label: string;
  layout: SkillsLayoutMode;
  category: SkillsCategoryStyle;
  surface: SkillsSurface;
  divider: boolean;
  accent_chips: boolean;
  radius_pt: number;
  pad_pt: number;
}

export interface SummaryStyle {
  id: string;
  label: string;
  surface: SummarySurface;
  border: SummaryBorder;
  title: SummaryTitleMode;
  title_accent: SummaryTitleAccent;
  align: SummaryAlign;
  italic: boolean;
  radius_pt: number;
  pad_pt: number;
}

export interface Typography {
  font_family: string;
  base_font_pt: number;
  heading_scale: number;
  name_scale: number;
  line_spacing: number;
  uppercase_headings: boolean;
}

export interface DesignColors {
  text: string;
  heading: string;
  accent: string;
  muted: string;
}

export interface HeaderMetrics {
  /** Total outer band height (top pad + content + bottom pad), in points. */
  band_pt: number | null;
  /** Band-bottom to first-content-block top, in points. */
  gap_pt: number | null;
  /** Reference width (px) the measurement was taken at. */
  measured_at_px: number | null;
}

/** Per-role vertical gaps (pt) measured from the rendered preview, so the .docx can
 *  reproduce the exact spacing the user designed instead of re-deriving it. Every
 *  field is the realized gap *before* a block of that kind. */
export interface LayoutMetrics {
  heading_before_pt: number | null;
  heading_after_pt: number | null;
  exp_lead_pt: number | null;
  exp_label_pt: number | null;
  exp_bullet_pt: number | null;
  exp_used_pt: number | null;
  exp_company_pt: number | null;
  skill_row_pt: number | null;
  edu_entry_pt: number | null;
  cert_row_pt: number | null;
  measured_at_px: number | null;
}

export type PaperSize = 'letter' | 'a4';

export interface LayoutConfig {
  columns: 1 | 2;
  /** Page size for the preview, PDF and .docx. Missing means US Letter. */
  paper?: PaperSize;
  margin_pt: number;
  section_gap_pt: number;
  margin_top_pt?: number | null;
  margin_right_pt?: number | null;
  margin_bottom_pt?: number | null;
  margin_left_pt?: number | null;
  header_align: HeaderAlign;
  header_background: HeaderBackground;
  header_padding_pt: number;
  header_pad_top_pt?: number | null;
  header_pad_right_pt?: number | null;
  header_pad_bottom_pt?: number | null;
  header_pad_left_pt?: number | null;
  header_image?: HeaderImage | null;
  header_metrics?: HeaderMetrics | null;
  layout_metrics?: LayoutMetrics | null;
  contact_layout: ContactLayout;
  contact_icons: ContactIconStyle;
  /** Icon horizontal nudge (pt). Positive moves the icon right relative to the label. */
  contact_icon_offset_x_pt?: number;
  /** Icon vertical nudge (pt). Positive moves the icon down relative to the label. */
  contact_icon_offset_y_pt?: number;
  accent_rule: boolean;
  section_order: SectionId[];
  hidden_sections: SectionId[];
}

export interface BoxSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Effective per-side page margins (pt): per-side override, else the legacy single value. */
export function marginSides(l: LayoutConfig): BoxSides {
  return {
    top: l.margin_top_pt ?? l.margin_pt,
    right: l.margin_right_pt ?? l.margin_pt,
    bottom: l.margin_bottom_pt ?? l.margin_pt,
    left: l.margin_left_pt ?? l.margin_pt,
  };
}

/** Effective per-side header band padding (pt). Left/right default to the page margins
 * so header text aligns with the body unless explicitly overridden. */
export function headerPadSides(l: LayoutConfig): BoxSides {
  const m = marginSides(l);
  return {
    top: l.header_pad_top_pt ?? l.header_padding_pt,
    right: l.header_pad_right_pt ?? m.right,
    bottom: l.header_pad_bottom_pt ?? l.header_padding_pt,
    left: l.header_pad_left_pt ?? m.left,
  };
}

export interface SectionOptions {
  skills_layout: SkillsLayout;
  show_period: boolean;
  show_location: boolean;
  summary_style: SummaryStyle;
  skills_style: SkillsStyle;
  experience_style: ExperienceStyle;
  education_style: EducationStyle;
  certificates_style: CertificatesStyle;
}

/** Per-design manual content override authored in the builder's Content panel.
 *  Mirrors WorkExperienceBlock / EducationBlock / etc. from types/profile.ts. */
export interface ResumeContent {
  name_first: string;
  name_middle: string;
  name_last: string;
  title: string;
  email: string;
  phone_country_code: string;
  phone_number: string;
  location: string;
  linkedin_url: string;
  github_url: string;
  profile_summary: string;
  technical_skills: { category: string; skills: string }[];
  work_experience: {
    company_name: string;
    job_title: string;
    period_start: string;
    period_end: string;
    location: string;
    job_type: string;
    employment_type: string;
    project_title: string;
    project_intro: string;
    contributions: string[];
    used_skills: string;
    description: string;
  }[];
  education: {
    university_name: string;
    degree: string;
    mark: string;
    period_start: string;
    period_end: string;
    location: string;
    description: string;
  }[];
  certificates: { name: string; issued_at: string; url: string }[];
}

export interface ResumeDesign {
  theme_id: string;
  typography: Typography;
  colors: DesignColors;
  layout: LayoutConfig;
  sections: SectionOptions;
  content?: ResumeContent | null;
}

export interface ThemePreset {
  id: string;
  label: string;
  description: string;
  accent_swatch: string;
  design: ResumeDesign;
  is_custom?: boolean;
  is_loved?: boolean;
}

export interface FontOption {
  id: string;
  label: string;
  family: string;
  category: 'sans' | 'serif';
}

export interface ColorPreset {
  id: string;
  label: string;
  colors: DesignColors;
}

export interface SectionMeta {
  id: SectionId;
  label: string;
  description: string;
}

export interface ResumeThemeCatalog {
  themes: ThemePreset[];
  fonts: FontOption[];
  color_presets: ColorPreset[];
  sections: SectionMeta[];
  summary_styles: SummaryStyle[];
  skills_styles: SkillsStyle[];
  experience_styles: ExperienceStyle[];
}

export const DEFAULT_SKILLS_STYLE: SkillsStyle = {
  id: 'inline',
  label: 'Inline',
  layout: 'inline',
  category: 'bold',
  surface: 'none',
  divider: false,
  accent_chips: false,
  radius_pt: 0,
  pad_pt: 6,
};

export const DEFAULT_SUMMARY_STYLE: SummaryStyle = {
  id: 'plain',
  label: 'Plain',
  surface: 'none',
  border: 'none',
  title: 'above',
  title_accent: 'none',
  align: 'left',
  italic: false,
  radius_pt: 0,
  pad_pt: 0,
};

export const DEFAULT_EXPERIENCE_STYLE: ExperienceStyle = {
  id: 'classic',
  label: 'Classic',
  header_layout: 'inline',
  date_position: 'right',
  surface: 'none',
  accent_target: 'company',
  project_style: 'label',
  intro_style: 'plain',
  marker: 'dot',
  label_style: 'bold',
  used_skills_style: 'inline',
  badge_style: 'inline',
  show_employment_type: true,
  show_arrangement: false,
  show_project_title: true,
  show_intro: true,
  show_used_skills: true,
  show_contributions_label: true,
  radius_pt: 0,
  pad_pt: 0,
  entry_gap_pt: 8,
};

export const DEFAULT_EDUCATION_STYLE: EducationStyle = {
  header_layout: 'inline',
  date_position: 'right',
  surface: 'none',
  accent_target: 'university',
  show_period: true,
  show_location: true,
  show_mark: true,
  show_description: true,
  radius_pt: 0,
  pad_pt: 0,
  entry_gap_pt: 6,
};

export const DEFAULT_CERTIFICATES_STYLE: CertificatesStyle = {
  layout: 'list',
  marker: 'dot',
  columns: 1,
  accent_chips: false,
  surface: 'none',
  radius_pt: 0,
  pad_pt: 6,
};

export interface ResumeDesignResponse {
  has_design: boolean;
  design: ResumeDesign;
  profile_work_count: number;
  resume_template_status: string;
  resume_template_ready: boolean;
}

export const SECTION_LABELS: Record<SectionId, string> = {
  summary: 'Professional Summary',
  skills: 'Technical Skills',
  experience: 'Work Experience',
  education: 'Education',
  certificates: 'Certifications',
};
