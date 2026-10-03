import { create } from 'zustand';
import { apiClient } from '../api/client';
import {
  deleteCustomResumeTheme,
  fetchResumeDesign,
  fetchResumeThemeCatalog,
  invalidateResumeDesignPreviewCache,
  saveCustomResumeTheme,
  saveResumeDesign,
  toggleResumeThemeLove,
} from '../api/resumeDesignApi';
import {
  activateResume,
  createResume,
  deleteResume as apiDeleteResume,
  duplicateResume,
  fetchResumeLibrary,
  openJobBuildResume,
  updateResume,
} from '../api/resumeLibraryApi';
import type { ResumeLibraryItem, ResumeSource, ResumeStatus } from '../types/resumeLibrary';
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
  type LayoutMetrics,
  type ResumeContent,
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
import { requestOnce } from '../utils/requestOnce';
import { normalizeResumeContent } from '../utils/resumeContent';

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

/** Fill in defaults on a raw stored design so older / partial designs render cleanly.
 *  Shared by initial load and every library switch/create/delete. */
function hydrateDesign(raw: ResumeDesign): ResumeDesign {
  // Two-column page body (Technical theme) is retired, always coerce to single column.
  const themeId = raw.theme_id === 'technical' ? 'classic' : raw.theme_id;
  return {
    ...raw,
    theme_id: themeId,
    layout: {
      ...raw.layout,
      columns: 1,
      header_background: raw.layout.header_background ?? 'none',
      header_padding_pt: raw.layout.header_padding_pt ?? 16,
      // Product default is brand. One-time migrate: older saves often stuck on
      // `outline` before icon-offset fields existed, flip those to brand. After
      // offsets are present, an explicit Outline choice is preserved.
      contact_icons: (() => {
        const rawIcons = raw.layout.contact_icons;
        if (rawIcons === 'none') return 'none';
        const legacyNoOffsets =
          raw.layout.contact_icon_offset_x_pt == null && raw.layout.contact_icon_offset_y_pt == null;
        if (legacyNoOffsets && rawIcons === 'outline') return 'brand';
        return rawIcons === 'outline' ? 'outline' : 'brand';
      })(),
      contact_icon_offset_x_pt: raw.layout.contact_icon_offset_x_pt ?? 0,
      contact_icon_offset_y_pt: raw.layout.contact_icon_offset_y_pt ?? 0,
      section_order: normalizeOrder(raw.layout.section_order),
      hidden_sections: raw.layout.hidden_sections ?? [],
    },
    sections: {
      ...raw.sections,
      summary_style: raw.sections?.summary_style ?? { ...DEFAULT_SUMMARY_STYLE },
      skills_style: raw.sections?.skills_style ?? { ...DEFAULT_SKILLS_STYLE },
      experience_style: raw.sections?.experience_style
        ? { ...DEFAULT_EXPERIENCE_STYLE, ...raw.sections.experience_style }
        : { ...DEFAULT_EXPERIENCE_STYLE },
      education_style: raw.sections?.education_style
        ? { ...DEFAULT_EDUCATION_STYLE, ...raw.sections.education_style }
        : { ...DEFAULT_EDUCATION_STYLE },
      certificates_style: raw.sections?.certificates_style
        ? { ...DEFAULT_CERTIFICATES_STYLE, ...raw.sections.certificates_style }
        : { ...DEFAULT_CERTIFICATES_STYLE },
    },
    // Expand legacy description blobs into structured contribution fields so the
    // Content editor matches what the live preview already derives.
    content: raw.content ? normalizeResumeContent(raw.content) : raw.content,
  };
}

interface ResumeBuilderState {
  catalog: ResumeThemeCatalog | null;
  design: ResumeDesign | null;
  /** The resume library (multi-resume) + which one is active/edited. */
  resumes: ResumeLibraryItem[];
  activeResumeId: string | null;
  switchingResume: boolean;
  /** Resume id currently being activated (drives the rail loading bar). */
  switchingResumeId: string | null;
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
  setHeaderMetrics: (m: { band_pt: number | null; gap_pt: number | null; measured_at_px: number }) => void;
  setLayoutMetrics: (m: LayoutMetrics) => void;
  setContent: (content: ResumeContent) => void;
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
  /** Cancel any pending auto-save and immediately persist if there are unsaved edits.
   *  Call on unmount so a debounced edit is never dropped (or left to fire after the
   *  builder is gone). */
  flushAutoSave: () => void;

  /** Which left-panel tab is active. Lifted into the store so the OneClick AI center can
   *  jump the user to the Content tab after applying a tailored result. */
  panelTab: 'style' | 'content';
  setPanelTab: (tab: 'style' | 'content') => void;

  /** Resume library actions. */
  loadResumes: () => Promise<void>;
  switchResume: (id: string) => Promise<void>;
  /** Open a completed job-workflow build into the library and activate it. */
  openJobBuild: (buildId: string) => Promise<void>;
  createResumeEntry: (args: {
    name: string;
    design: ResumeDesign;
    source?: ResumeSource;
    status?: ResumeStatus;
    jobTitle?: string | null;
    company?: string | null;
    activate?: boolean;
  }) => Promise<string | null>;
  renameResume: (id: string, name: string) => Promise<void>;
  setResumeStatus: (id: string, status: ResumeStatus) => Promise<void>;
  duplicateResumeEntry: (id: string) => Promise<void>;
  removeResume: (id: string) => Promise<void>;

  /** Custom theme library. */
  savingTheme: boolean;
  themeError: string | null;
  saveCurrentAsTheme: (name: string) => Promise<boolean>;
  toggleThemeLove: (themeId: string) => Promise<void>;
  deleteCustomTheme: (themeId: string) => Promise<void>;
  setCatalogThemes: (themes: ThemePreset[]) => void;
}

const AUTOSAVE_MS = 900;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Equal within ~0.4 pt (or both null). Mirrors the preview's measurement tolerance so
 *  sub-pixel layout jitter does not churn the saved design. */
function nearlyEqualPt(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) < 0.4;
}

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
  resumes: [],
  activeResumeId: null,
  switchingResume: false,
  switchingResumeId: null,
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
  panelTab: 'style',
  savingTheme: false,
  themeError: null,

  setPanelTab: (tab) => set({ panelTab: tab }),

  setCatalogThemes: (themes) => {
    const catalog = get().catalog;
    if (!catalog) return;
    set({ catalog: { ...catalog, themes } });
  },

  saveCurrentAsTheme: async (name) => {
    const design = get().design;
    if (!design) return false;
    set({ savingTheme: true, themeError: null });
    try {
      const res = await saveCustomResumeTheme(name, design);
      const catalog = get().catalog;
      if (catalog) set({ catalog: { ...catalog, themes: res.themes }, panelTab: 'style' });
      set({ savingTheme: false });
      return true;
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } } };
      set({
        savingTheme: false,
        themeError: e?.response?.data?.detail || 'Could not save theme.',
      });
      return false;
    }
  },

  toggleThemeLove: async (themeId) => {
    try {
      const res = await toggleResumeThemeLove(themeId);
      const catalog = get().catalog;
      if (catalog) set({ catalog: { ...catalog, themes: res.themes } });
    } catch {
      /* keep prior order on failure */
    }
  },

  deleteCustomTheme: async (themeId) => {
    try {
      const res = await deleteCustomResumeTheme(themeId);
      const catalog = get().catalog;
      if (catalog) set({ catalog: { ...catalog, themes: res.themes } });
    } catch {
      /* ignore */
    }
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [catalog, designResp, profileResp, library] = await requestOnce('resume-builder:load', () =>
        Promise.all([
          fetchResumeThemeCatalog(),
          fetchResumeDesign(),
          apiClient.get<UserProfile>('/profile').then((r) => r.data).catch(() => null),
          fetchResumeLibrary().catch(() => ({ resumes: [], active_id: null })),
        ]),
      );
      const design = hydrateDesign(designResp.design);
      set({
        catalog,
        design,
        baseline: JSON.stringify(design),
        profile: profileResp,
        profileWorkCount: designResp.profile_work_count,
        hasDesign: designResp.has_design,
        status: designResp.resume_template_status,
        ready: designResp.resume_template_ready,
        resumes: library.resumes,
        activeResumeId: library.active_id,
        loading: false,
      });
    } catch {
      set({ loading: false, error: 'Could not load the resume builder. Please retry.' });
    }
  },

  loadResumes: async () => {
    try {
      const lib = await fetchResumeLibrary();
      set({ resumes: lib.resumes, activeResumeId: lib.active_id });
    } catch {
      /* leave existing list in place */
    }
  },

  switchResume: async (id) => {
    const s = get();
    if (id === s.activeResumeId || s.switchingResume) return;
    // Persist any pending edit to the current resume before switching away.
    s.flushAutoSave();
    set({ switchingResume: true, switchingResumeId: id, saveError: null });
    try {
      const lib = await activateResume(id);
      const active = lib.resume ?? lib.resumes.find((r) => r.id === lib.active_id) ?? null;
      const nextDesign = active ? hydrateDesign(active.design) : get().design;
      invalidateResumeDesignPreviewCache();
      set({
        resumes: lib.resumes,
        activeResumeId: lib.active_id,
        design: nextDesign,
        baseline: nextDesign ? JSON.stringify(nextDesign) : get().baseline,
        hasDesign: true,
        switchingResume: false,
        switchingResumeId: null,
      });
    } catch {
      set({
        switchingResume: false,
        switchingResumeId: null,
        saveError: 'Could not switch resume. Please retry.',
      });
    }
  },

  openJobBuild: async (buildId) => {
    const s = get();
    if (!buildId || s.switchingResume) return;
    s.flushAutoSave();
    set({ switchingResume: true, switchingResumeId: buildId, saveError: null });
    try {
      const lib = await openJobBuildResume(buildId);
      const active = lib.resume ?? lib.resumes.find((r) => r.id === lib.active_id) ?? null;
      const nextDesign = active ? hydrateDesign(active.design) : get().design;
      invalidateResumeDesignPreviewCache();
      set({
        resumes: lib.resumes,
        activeResumeId: lib.active_id,
        design: nextDesign,
        baseline: nextDesign ? JSON.stringify(nextDesign) : get().baseline,
        hasDesign: true,
        switchingResume: false,
        switchingResumeId: null,
        panelTab: 'content',
      });
    } catch {
      set({
        switchingResume: false,
        switchingResumeId: null,
        saveError: 'Could not open job resume. Please retry.',
      });
    }
  },

  createResumeEntry: async ({ name, design, source, status, jobTitle, company, activate = true }) => {
    try {
      const lib = await createResume({
        name,
        design,
        source,
        status,
        job_title: jobTitle ?? null,
        company: company ?? null,
        activate,
      });
      const created = lib.resume ?? null;
      if (activate && created) {
        const nextDesign = hydrateDesign(created.design);
        invalidateResumeDesignPreviewCache();
        set({
          resumes: lib.resumes,
          activeResumeId: lib.active_id,
          design: nextDesign,
          baseline: JSON.stringify(nextDesign),
          hasDesign: true,
        });
      } else {
        set({ resumes: lib.resumes, activeResumeId: lib.active_id });
      }
      return created?.id ?? null;
    } catch {
      set({ saveError: 'Could not create the resume. Please retry.' });
      return null;
    }
  },

  renameResume: async (id, name) => {
    try {
      const lib = await updateResume(id, { name });
      set({ resumes: lib.resumes, activeResumeId: lib.active_id });
    } catch {
      set({ saveError: 'Could not rename the resume. Please retry.' });
    }
  },

  setResumeStatus: async (id, statusVal) => {
    try {
      const lib = await updateResume(id, { status: statusVal });
      set({ resumes: lib.resumes, activeResumeId: lib.active_id });
    } catch {
      set({ saveError: 'Could not update the status. Please retry.' });
    }
  },

  duplicateResumeEntry: async (id) => {
    try {
      const lib = await duplicateResume(id);
      set({ resumes: lib.resumes, activeResumeId: lib.active_id });
    } catch {
      set({ saveError: 'Could not duplicate the resume. Please retry.' });
    }
  },

  removeResume: async (id) => {
    const wasActive = get().activeResumeId === id;
    try {
      const lib = await apiDeleteResume(id);
      const patch: Partial<ResumeBuilderState> = {
        resumes: lib.resumes,
        activeResumeId: lib.active_id,
      };
      // If we deleted the active resume, the backend re-activated another one - load it.
      if (wasActive) {
        const active = lib.resumes.find((r) => r.id === lib.active_id) ?? null;
        if (active) {
          const nextDesign = hydrateDesign(active.design);
          invalidateResumeDesignPreviewCache();
          patch.design = nextDesign;
          patch.baseline = JSON.stringify(nextDesign);
        }
      }
      set(patch);
    } catch {
      set({ saveError: 'Could not delete the resume. Please retry.' });
    }
  },

  applyTheme: (theme) => {
    const current = get().design;
    if (!current) return;
    // Keep user content, section visibility/order, and header image. Drop browser
    // header/layout metrics whenever the theme changes columns or header chrome,
    // Always drop browser metrics on theme apply so measure-only preview re-reports.
    const keepImage = current.layout.header_image ?? null;
    const next: ResumeDesign = {
      ...theme.design,
      content: current.content ?? theme.design.content ?? null,
      layout: {
        ...theme.design.layout,
        columns: 1,
        // Themes always ship brand icons; keep the user's manual icon offsets.
        contact_icons: 'brand',
        contact_icon_offset_x_pt: current.layout.contact_icon_offset_x_pt ?? 0,
        contact_icon_offset_y_pt: current.layout.contact_icon_offset_y_pt ?? 0,
        section_order: current.layout.section_order,
        hidden_sections: current.layout.hidden_sections,
        header_image: keepImage,
        header_background: keepImage ? 'image' : theme.design.layout.header_background,
        header_metrics: null,
        layout_metrics: null,
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
    // Contact layout changes band height. Drop stale browser metrics so measure-only
    // preview re-reports; otherwise the PDF can pin a wrong band/gap.
    const layoutPatch = { ...patch } as Partial<ResumeDesign['layout']>;
    // Two-column page body is retired.
    if (layoutPatch.columns != null) layoutPatch.columns = 1;
    if (patch.contact_layout != null && patch.contact_layout !== d.layout.contact_layout) {
      layoutPatch.header_metrics = null;
      layoutPatch.layout_metrics = null;
    }
    applyDesign(set, get, { ...d, layout: { ...d.layout, ...layoutPatch } });
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

  setHeaderMetrics: (m) => {
    const d = get().design;
    if (!d) return;
    const cur = d.layout.header_metrics ?? null;
    const same =
      cur != null &&
      nearlyEqualPt(cur.band_pt ?? null, m.band_pt) &&
      nearlyEqualPt(cur.gap_pt ?? null, m.gap_pt);
    // Skip no-op updates so re-measuring an unchanged design never marks it dirty
    // (which would trigger an endless measure → save → recompile loop).
    if (same) return;
    applyDesign(set, get, { ...d, layout: { ...d.layout, header_metrics: { ...m } } });
  },

  setLayoutMetrics: (m) => {
    const d = get().design;
    if (!d) return;
    const cur = d.layout.layout_metrics ?? null;
    const keys: (keyof LayoutMetrics)[] = [
      'heading_before_pt',
      'heading_after_pt',
      'exp_lead_pt',
      'exp_label_pt',
      'exp_bullet_pt',
      'exp_used_pt',
      'exp_company_pt',
      'skill_row_pt',
      'edu_entry_pt',
      'cert_row_pt',
    ];
    const same = cur != null && keys.every((k) => nearlyEqualPt(cur[k] ?? null, m[k] ?? null));
    // Skip no-op updates so re-measuring an unchanged design never marks it dirty
    // (which would trigger an endless measure → save → recompile loop).
    if (same) return;
    applyDesign(set, get, { ...d, layout: { ...d.layout, layout_metrics: { ...m } } });
  },

  updateSectionOptions: (patch) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, sections: { ...d.sections, ...patch } });
  },

  setContent: (content) => {
    const d = get().design;
    if (!d) return;
    applyDesign(set, get, { ...d, content: normalizeResumeContent(content) });
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

  flushAutoSave: () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    const s = get();
    if (s.design && !s.saving && selectIsDirty(s)) {
      void s.save();
    }
  },

  save: async () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    const d = get().design;
    if (!d) return false;
    set({ saving: true, saveError: null });
    try {
      const status = await saveResumeDesign(d);
      const activeId = get().activeResumeId;
      set((st) => ({
        saving: false,
        baseline: JSON.stringify(d),
        status: status.resume_template_status,
        ready: Boolean(status.resume_template_ready),
        hasDesign: true,
        lastSavedAt: Date.now(),
        // Keep the active library thumbnail in sync with the just-saved design.
        resumes: activeId
          ? st.resumes.map((r) => (r.id === activeId ? { ...r, design: d } : r))
          : st.resumes,
      }));
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
