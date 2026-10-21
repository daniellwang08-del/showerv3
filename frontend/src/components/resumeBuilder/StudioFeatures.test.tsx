import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  DEFAULT_CERTIFICATES_STYLE,
  DEFAULT_EDUCATION_STYLE,
  DEFAULT_EXPERIENCE_STYLE,
  DEFAULT_SKILLS_STYLE,
  DEFAULT_SUMMARY_STYLE,
  emptyExtraItem,
  sectionTitle,
  type ExtraSection,
  type ResumeDesign,
  type ThemePreset,
} from '@/types/resumeDesign';
import { formatFlexibleDate, formatFlexiblePeriod } from '@/utils/flexibleDate';
import { themeDesignFor, useResumeBuilderStore } from '@/stores/resumeBuilderStore';
import { ResumePreview, sectionHeadingStyle } from './ResumePreview';
import { reviewResume, reviewScore, tightenDesign } from './ResumeReview';

function design(patch: Partial<ResumeDesign> = {}, layout: Partial<ResumeDesign['layout']> = {}): ResumeDesign {
  return {
    theme_id: 'classic',
    typography: {
      font_family: 'Arial',
      base_font_pt: 10.5,
      heading_scale: 1.2,
      name_scale: 2,
      line_spacing: 1.15,
      uppercase_headings: false,
    },
    colors: { text: '#111111', heading: '#111111', accent: '#2563eb', muted: '#555555' },
    layout: {
      columns: 1,
      margin_pt: 54,
      section_gap_pt: 10,
      header_align: 'left',
      header_background: 'none',
      header_padding_pt: 16,
      contact_layout: 'inline',
      contact_icons: 'none',
      accent_rule: true,
      section_order: ['summary', 'experience'],
      hidden_sections: [],
      ...layout,
    },
    sections: {
      skills_layout: 'categories',
      show_period: true,
      show_location: true,
      summary_style: DEFAULT_SUMMARY_STYLE,
      skills_style: DEFAULT_SKILLS_STYLE,
      experience_style: DEFAULT_EXPERIENCE_STYLE,
      education_style: DEFAULT_EDUCATION_STYLE,
      certificates_style: DEFAULT_CERTIFICATES_STYLE,
    },
    extra_sections: [],
    ...patch,
  } as ResumeDesign;
}

const PROJECTS: ExtraSection = {
  id: 'x-proj01',
  kind: 'projects',
  title: '',
  layout: 'entries',
  items: [
    { ...emptyExtraItem(), title: 'Compiler', subtitle: 'Rust', date_start: '2022-01', date_end: '2022-06', bullets: ['Wrote it.', '  '] },
  ],
};

const PROFILE = {
  name_first: 'Ada',
  name_last: 'Lovelace',
  email: 'ada@example.com',
  work_experience: [
    { company_name: 'Acme', job_title: 'Engineer', period_start: '2021-03', period_end: '', contributions: ['Responsible for builds'] },
  ],
} as never;

describe('date styles', () => {
  it('formats every option and the ongoing label', () => {
    expect(formatFlexiblePeriod('2021-03', '')).toBe('Mar 2021 - Present');
    expect(formatFlexiblePeriod('2021-03', '', { format: 'month_yyyy', present: 'Now' })).toBe('March 2021 - Now');
    expect(formatFlexiblePeriod('2021-03', '2022-11', { format: 'mm_yyyy', present: 'Present' })).toBe('03/2021 - 11/2022');
    expect(formatFlexiblePeriod('2021-01', '2021-09', { format: 'yyyy', present: 'Present' })).toBe('2021');
    expect(formatFlexibleDate('current', '', { format: 'yyyy', present: 'Today' })).toBe('Today');
  });
});

describe('section titles and extra sections in the preview', () => {
  it('uses renamed headings and prints filled extra sections in order', () => {
    const d = design(
      { extra_sections: [PROJECTS, { id: 'x-empty1', kind: 'awards', title: '', layout: 'list', items: [] }] },
      { section_order: ['summary', 'experience', 'x-proj01', 'x-empty1'] },
    );
    d.sections.titles = { experience: 'Professional Experience' };
    d.sections.date_format = 'month_yyyy';
    render(<ResumePreview design={d} profile={PROFILE} />);
    expect(screen.getByText('Professional Experience')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Compiler')).toBeInTheDocument();
    expect(screen.getByText('January 2022 - June 2022')).toBeInTheDocument();
    expect(screen.getByText(/March 2021 - Present/)).toBeInTheDocument();
    expect(screen.queryByText('Awards & Honors')).toBeNull();
    expect(sectionTitle(d, 'x-empty1')).toBe('Awards & Honors');
  });

  it('never prints blank bullets', () => {
    const d = design({ extra_sections: [PROJECTS] }, { section_order: ['x-proj01'] });
    render(<ResumePreview design={d} profile={PROFILE} />);
    expect(screen.getByText('Wrote it.')).toBeInTheDocument();
    expect(screen.getAllByText('\u2022')).toHaveLength(1);
  });

  it('maps heading styles to the same treatments as the Word file', () => {
    const solid = sectionHeadingStyle(design({}, { heading_style: 'solid' }));
    expect(solid.background).toBe('#2563eb');
    expect(solid.color).toBe('#ffffff');
    const bar = sectionHeadingStyle(design({}, { heading_style: 'left_bar', heading_align: 'center' }));
    expect(String(bar.borderLeft)).toContain('solid');
    expect(bar.textAlign).toBe('center');
    // Legacy designs without a style keep the accent underline.
    expect(sectionHeadingStyle(design()).borderBottom).toContain('#2563eb');
    expect(sectionHeadingStyle(design({}, { accent_rule: false })).borderBottom).toBeUndefined();
  });
});

describe('review', () => {
  it('flags missing contacts, odd headings and weak bullets', () => {
    const d = design();
    d.sections.titles = { experience: 'My Journey' };
    const checks = reviewResume(d, PROFILE, 1);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.contact.level).toBe('warn');
    expect(byId.headings.level).toBe('warn');
    expect(byId.summary.level).toBe('error');
    expect(byId.bullets.level).toBe('warn');
    expect(byId.verbs.level).toBe('tip');
    expect(byId.pages.level).toBe('pass');
    expect(reviewScore(checks)).toBeLessThan(80);
  });

  it('tightens step by step and then stops', () => {
    let d: ResumeDesign | null = design();
    let steps = 0;
    while (d && steps < 100) {
      d = tightenDesign(d) ?? null;
      if (d) {
        expect(d.typography.base_font_pt).toBeGreaterThanOrEqual(9.5);
        expect(d.typography.line_spacing).toBeGreaterThanOrEqual(1.05);
        expect(d.layout.margin_top_pt ?? d.layout.margin_pt).toBeGreaterThanOrEqual(36);
      }
      steps += 1;
    }
    expect(steps).toBeLessThan(100);
  });
});

describe('store', () => {
  afterEach(() => {
    useResumeBuilderStore.setState({ design: null, baseline: '', saving: false });
  });

  it('adds, renames and removes extra sections', () => {
    const d = design();
    useResumeBuilderStore.setState({ design: d, baseline: JSON.stringify(d) });
    const id = useResumeBuilderStore.getState().addExtraSection('languages');
    expect(id).toMatch(/^x-[a-z0-9]{4,24}$/);
    let cur = useResumeBuilderStore.getState().design!;
    expect(cur.layout.section_order).toContain(id);
    expect(cur.extra_sections?.[0].layout).toBe('inline');

    useResumeBuilderStore.getState().setSectionTitle(id!, '  Spoken   languages ');
    cur = useResumeBuilderStore.getState().design!;
    expect(cur.extra_sections?.[0].title).toBe('Spoken languages');
    expect(cur.sections.titles?.[id!]).toBeUndefined();

    useResumeBuilderStore.getState().setSectionTitle('skills', 'Core Skills');
    useResumeBuilderStore.getState().removeExtraSection(id!);
    cur = useResumeBuilderStore.getState().design!;
    expect(cur.extra_sections).toEqual([]);
    expect(cur.layout.section_order).not.toContain(id);
    expect(cur.sections.titles).toEqual({ skills: 'Core Skills' });
  });

  it('keeps extra sections, names and date format when a theme is applied', () => {
    const current = design({ extra_sections: [PROJECTS] }, { section_order: ['summary', 'experience', 'x-proj01'] });
    current.sections.titles = { experience: 'Work' };
    current.sections.date_format = 'yyyy';
    const theme: ThemePreset = {
      id: 'engineer',
      label: 'Engineer',
      description: '',
      accent_swatch: '#0891b2',
      category: 'technical',
      design: design({}, { heading_style: 'left_bar' }),
    };
    const next = themeDesignFor(theme, current);
    expect(next.extra_sections).toEqual([PROJECTS]);
    expect(next.layout.section_order).toContain('x-proj01');
    expect(next.sections.titles).toEqual({ experience: 'Work' });
    expect(next.sections.date_format).toBe('yyyy');
    expect(next.layout.heading_style).toBe('left_bar');
  });
});
