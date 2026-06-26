import { create } from 'zustand';
import { apiClient } from '../api/client';
import {
  fetchResumeDesign,
  fetchResumeThemeCatalog,
  saveResumeDesign,
} from '../api/resumeDesignApi';
import {
  DEFAULT_CERTIFICATES_STYLE,
  DEFAULT_EDUCATION_STYLE,
  DEFAULT_EXPERIENCE_STYLE,
  DEFAULT_SKILLS_STYLE,
  DEFAULT_SUMMARY_STYLE,
  type CertificatesStyle,
  type ColorPreset,
  type DesignColors,
  type EducationStyle,
  type ExperienceStyle,
  type HeaderImage,
  type LayoutConfig,
  type ResumeDesign,
  type ResumeThemeCatalog,
  type SectionId,
  type SectionOptions,
  type SkillsStyle,
  type SummaryStyle,
  type ThemePreset,
  type Typography,
} from '../types/resumeDesign';
import type { UserProfile } from '../types/profile';

const ALL_SECTIONS: SectionId[] = ['summary', 'skills', 'experience', 'education', 'certificates'];

function normalizeOrder(order: SectionId[] | undefined): SectionId[] {
  const seen = new Set<SectionId>();
  const result: SectionId[] = [];
  for (const id of order ?? []) {
    if (ALL_SECTIONS.includes(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of ALL_SECTIONS) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

interface ResumeBuilderState {
  catalog: ResumeThemeCatalog | null;
  design: ResumeDesign | null;
  baseline: string;
  profile: UserProfile | null;
  profileWorkCount: number;
  hasDesign: boolean;
  status: string;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  saveError: string | null;
  lastSavedAt: number | null;

  load: () => Promise<void>;
  applyTheme: (theme: ThemePreset) => void;
  updateTypography: (patch: Partial<Typography>) => void;
  updateColors: (patch: Partial<DesignColors>) => void;
  applyColorPreset: (preset: ColorPreset) => void;
  updateLayout: (patch: Partial<LayoutConfig>) => void;
  setHeaderImage: (image: HeaderImage | null) => void;
  updateSectionOptions: (patch: Partial<SectionOptions>) => void;
  applySummaryStyle: (style: SummaryStyle) => void;
  applySkillsStyle: (style: SkillsStyle) => void;
  applyExperienceStyle: (style: ExperienceStyle) => void;
  updateExperienceStyle: (patch: Partial<ExperienceStyle>) => void;
  updateEducationStyle: (patch: Partial<EducationStyle>) => void;
  updateCertificatesStyle: (patch: Partial<CertificatesStyle>) => void;
  toggleSection: (id: SectionId) => void;
  moveSection: (id: SectionId, dir: -1 | 1) => void;
  resetToSaved: () => void;
  save: () => Promise<boolean>;
}

const AUTOSAVE_MS = 900;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced auto-save: every design edit reschedules a save so the user never has
 * to press a button. Skips while a save is in flight and re-checks afterwards so
 * edits made during a save are not lost. */
function scheduleAutoSave(get: () => ResumeBuilderState) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    const s = get();
    if (!s.design) return;
    if (s.saving) {
      scheduleAutoSave(get); // wait for the in-flight save, then retry
      return;
    }
    if (selectIsDirty(s)) {
      void s.save().then(() => {
        // Pick up any edits that landed while saving.
        if (selectIsDirty(get())) scheduleAutoSave(get);
      });
    }
  }, AUTOSAVE_MS);
}

function applyDesign(set: (partial: Partial<ResumeBuilderState>) => void, get: () => ResumeBuilderState, next: ResumeDesign) {
  set({ design: next });
  scheduleAutoSave(get);
}

export const useResumeBuilderStore = create<ResumeBuilderState>((set, get) => ({
  catalog: null,
  design: null,
  baseline: '',
  profile: null,
  profileWorkCount: 0,
  hasDesign: false,
  status: 'missing',
  ready: false,
  loading: false,
  saving: false,
  error: null,
  saveError: null,
  lastSavedAt: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [catalog, designResp, profileResp] = await Promise.all([
        fetchResumeThemeCatalog(),
        fetchResumeDesign(),
        apiClient.get<UserProfile>('/profile').then((r) => r.data).catch(() => null),
      ]);
      const design: ResumeDesign = {
        ...designResp.design,
        layout: {
          ...designResp.design.layout,
          header_background: designResp.design.layout.header_background ?? 'none',
          header_padding_pt: designResp.design.layout.header_padding_pt ?? 16,
          contact_icons: designResp.design.layout.contact_icons ?? 'brand',
          section_order: normalizeOrder(designResp.design.layout.section_order),
          hidden_sections: designResp.design.layout.hidden_sections ?? [],
        },
        sections: {
          ...designResp.design.sections,
          summary_style: designResp.design.sections?.summary_style ?? { ...DEFAULT_SUMMARY_STYLE },
          skills_style: designResp.design.sections?.skills_style ?? { ...DEFAULT_SKILLS_STYLE },
          experience_style: designResp.design.sections?.experience_style
            ? { ...DEFAULT_EXPERIENCE_STYLE, ...designResp.design.sections.experience_style }
            : { ...DEFAULT_EXPERIENCE_STYLE },
          education_style: designResp.design.sections?.education_style
            ? { ...DEFAULT_EDUCATION_STYLE, ...designResp.design.sections.education_style }
            : { ...DEFAULT_EDUCATION_STYLE },
          certificates_style: designResp.design.sections?.certificates_style
            ? { ...DEFAULT_CERTIFICATES_STYLE, ...designResp.design.sections.certificates_style }
            : { ...DEFAULT_CERTIFICATES_STYLE },
        },
      };
      set({
        catalog,
        design,
        baseline: JSON.stringify(design),
        profile: profileResp,
        profileWorkCount: designResp.profile_work_count,
        hasDesign: designResp.has_design,
        status: designResp.resume_template_status,
        ready: designResp.resume_template_ready,
        loading: false,
      });
    } catch {
      set({ loading: false, error: 'Could not load the resume builder. Please retry.' });
    }
  },

  applyTheme: (theme) => {
    const current = get().design;
    if (!current) return;
    const next: ResumeDesign = {
      ...theme.design,
      layout: {
        ...theme.design.layout,
        section_order: current.layout.section_order,
        hidden_sections: current.layout.hidden_sections,
      },
      sections: { ...current.sections },
    };
    applyDesign(set, get, next);
  },

  updateTypography: (patch) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, typography: { ...d.typography, ...patch } });
  },

  updateColors: (patch) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, colors: { ...d.colors, ...patch } });
  },

  applyColorPreset: (preset) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, colors: { ...preset.colors } });
  },

  updateLayout: (patch) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, layout: { ...d.layout, ...patch } });
  },

  setHeaderImage: (image) => {
    const d = get().design;
    if (!d) return;
    // Setting an image selects the image background; clearing it falls back to a soft band.
    applyDesign(set, get, {
      ...d,
      layout: {
        ...d.layout,
        header_image: image,
        header_background: image ? 'image' : d.layout.header_background === 'image' ? 'soft' : d.layout.header_background,
      },
    });
  },

  updateSectionOptions: (patch) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, sections: { ...d.sections, ...patch } });
  },

  applySummaryStyle: (style) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, sections: { ...d.sections, summary_style: { ...style } } });
  },

  applySkillsStyle: (style) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, sections: { ...d.sections, skills_style: { ...style } } });
  },

  applyExperienceStyle: (style) => {
    const d = get().design;
    if (!d) return;
    // Preserve the user's control-board overrides (show_* flags) when switching
    // theme, so they do not lose their visibility choices.
    const cur = d.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE;
    applyDesign(set, get, {
      ...d,
      sections: {
        ...d.sections,
        experience_style: {
          ...style,
          show_employment_type: cur.show_employment_type,
          show_arrangement: cur.show_arrangement,
          show_project_title: cur.show_project_title,
          show_intro: cur.show_intro,
          show_used_skills: cur.show_used_skills,
          show_contributions_label: cur.show_contributions_label,
        },
      },
    });
  },

  updateExperienceStyle: (patch) => {
    const d = get().design;
    if (!d) return;
    const cur = d.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE;
    applyDesign(set, get, {
      ...d,
      sections: { ...d.sections, experience_style: { ...cur, ...patch } },
    });
  },

  updateEducationStyle: (patch) => {
    const d = get().design;
    if (!d) return;
    const cur = d.sections.education_style ?? DEFAULT_EDUCATION_STYLE;
    applyDesign(set, get, {
      ...d,
      sections: { ...d.sections, education_style: { ...cur, ...patch } },
    });
  },

  updateCertificatesStyle: (patch) => {
    const d = get().design;
    if (!d) return;
    const cur = d.sections.certificates_style ?? DEFAULT_CERTIFICATES_STYLE;
    applyDesign(set, get, {
      ...d,
      sections: { ...d.sections, certificates_style: { ...cur, ...patch } },
    });
  },

  toggleSection: (id) => {
    const d = get().design;
    if (!d) return;
    const hidden = new Set(d.layout.hidden_sections);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    applyDesign(set, get, { ...d, layout: { ...d.layout, hidden_sections: Array.from(hidden) } });
  },

  moveSection: (id, dir) => {
    const d = get().design;
    if (!d) return;
    const order = [...d.layout.section_order];
    const idx = order.indexOf(id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    applyDesign(set, get, { ...d, layout: { ...d.layout, section_order: order } });
  },

  resetToSaved: () => {
    const { baseline } = get();
    if (!baseline) return;
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    set({ design: JSON.parse(baseline) as ResumeDesign });
  },

  save: async () => {
    const d = get().design;
    if (!d) return false;
    set({ saving: true, saveError: null });
    try {
      const status = await saveResumeDesign(d);
      set({
        saving: false,
        baseline: JSON.stringify(d),
        status: status.resume_template_status,
        ready: Boolean(status.resume_template_ready),
        hasDesign: true,
        lastSavedAt: Date.now(),
      });
      return true;
    } catch {
      set({ saving: false, saveError: 'Could not save your design. Please retry.' });
      return false;
    }
  },
}));

export function selectIsDirty(s: ResumeBuilderState): boolean {
  return Boolean(s.design) && JSON.stringify(s.design) !== s.baseline;
}
