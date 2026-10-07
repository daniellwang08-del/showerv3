import { FileText, Heading, MoveVertical, Type } from 'lucide-react';
import type { EducationStyle, ExperienceStyle, LayoutConfig, ResumeDesign, Typography } from '../../types/resumeDesign';
import { DEFAULT_EDUCATION_STYLE, DEFAULT_EXPERIENCE_STYLE, marginSides } from '../../types/resumeDesign';
import { BoxSidesField, ControlCard, Segmented, Slider, Toggle } from './controls';

type Density = 'compact' | 'balanced' | 'relaxed';

const TEXT_SIZES = [
  { value: 9.5, label: 'Small' },
  { value: 10.5, label: 'Medium' },
  { value: 11.5, label: 'Large' },
];

const DENSITY: Record<Density, { line: number; section: number; entry: number; edu: number }> = {
  compact: { line: 1.05, section: 7, entry: 6, edu: 4 },
  balanced: { line: 1.12, section: 10, entry: 8, edu: 6 },
  relaxed: { line: 1.25, section: 14, entry: 12, edu: 9 },
};

const MARGINS = [
  { value: 36, label: 'Narrow' },
  { value: 54, label: 'Normal' },
  { value: 72, label: 'Wide' },
];

function currentDensity(d: ResumeDesign): Density | '' {
  const ex = d.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE;
  for (const [id, p] of Object.entries(DENSITY) as [Density, (typeof DENSITY)[Density]][]) {
    if (
      Math.abs(d.typography.line_spacing - p.line) < 0.01 &&
      d.layout.section_gap_pt === p.section &&
      ex.entry_gap_pt === p.entry
    ) {
      return id;
    }
  }
  return '';
}

function uniformMargin(l: LayoutConfig): number | null {
  const m = marginSides(l);
  return m.top === m.right && m.right === m.bottom && m.bottom === m.left ? m.top : null;
}

/** Text, headings, spacing and page setup: a preset row for speed, exact controls below it. */
export function FormatControls({
  design,
  onTypography,
  onLayout,
  onDesign,
}: {
  design: ResumeDesign;
  onTypography: (patch: Partial<Typography>) => void;
  onLayout: (patch: Partial<LayoutConfig>) => void;
  onDesign: (fn: (d: ResumeDesign) => ResumeDesign) => void;
}) {
  const t = design.typography;
  const l = design.layout;
  const ex = design.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE;
  const ed = design.sections.education_style ?? DEFAULT_EDUCATION_STYLE;
  const margin = uniformMargin(l);
  const setMargin = (v: number) =>
    onLayout({ margin_pt: v, margin_top_pt: v, margin_right_pt: v, margin_bottom_pt: v, margin_left_pt: v });

  const setEntryGaps = (patch: { experience?: Partial<ExperienceStyle>; education?: Partial<EducationStyle> }) =>
    onDesign((d) => ({
      ...d,
      layout: { ...d.layout, layout_metrics: null },
      sections: {
        ...d.sections,
        experience_style: { ...(d.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE), ...patch.experience },
        education_style: { ...(d.sections.education_style ?? DEFAULT_EDUCATION_STYLE), ...patch.education },
      },
    }));

  const applyDensity = (id: Density) => {
    const p = DENSITY[id];
    onDesign((d) => ({
      ...d,
      typography: { ...d.typography, line_spacing: p.line },
      layout: { ...d.layout, section_gap_pt: p.section, layout_metrics: null },
      sections: {
        ...d.sections,
        experience_style: { ...(d.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE), entry_gap_pt: p.entry },
        education_style: { ...(d.sections.education_style ?? DEFAULT_EDUCATION_STYLE), entry_gap_pt: p.edu },
      },
    }));
  };

  return (
    <>
      <ControlCard icon={Type} title="Text">
        <Segmented<number | ''>
          label="Text size"
          value={TEXT_SIZES.some((s) => s.value === t.base_font_pt) ? t.base_font_pt : ''}
          options={TEXT_SIZES}
          onChange={(v) => v !== '' && onTypography({ base_font_pt: v })}
        />
        <Slider label="Body text" value={t.base_font_pt} min={8} max={14} step={0.5} suffix=" pt"
          onChange={(v) => onTypography({ base_font_pt: v })} />
        <Slider label="Line height" value={t.line_spacing} min={1} max={2} step={0.02}
          format={(v) => v.toFixed(2)} onChange={(v) => onTypography({ line_spacing: v })} />
        <Slider label="Name size" value={t.name_scale} min={1.4} max={3.5} step={0.1}
          format={(v) => `${v.toFixed(1)}\u00d7 body`} onChange={(v) => onTypography({ name_scale: v })} />
      </ControlCard>

      <ControlCard icon={Heading} title="Section headings">
        <Segmented<'upper' | 'title'>
          label="Case"
          value={t.uppercase_headings ? 'upper' : 'title'}
          options={[
            { value: 'upper', label: 'UPPERCASE' },
            { value: 'title', label: 'Title Case' },
          ]}
          onChange={(v) => onTypography({ uppercase_headings: v === 'upper' })}
        />
        <Slider label="Heading size" value={t.heading_scale} min={1} max={2.2} step={0.05}
          format={(v) => `${v.toFixed(2)}\u00d7 body`} onChange={(v) => onTypography({ heading_scale: v })} />
        <Toggle label="Accent line under headings" checked={l.accent_rule} onChange={(v) => onLayout({ accent_rule: v })} />
      </ControlCard>

      <ControlCard icon={MoveVertical} title="Spacing">
        <Segmented<Density | ''>
          label="Density"
          value={currentDensity(design)}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'relaxed', label: 'Relaxed' },
          ]}
          onChange={(v) => v && applyDensity(v)}
        />
        <Slider label="Between sections" value={l.section_gap_pt} min={2} max={28} step={1} suffix=" pt"
          onChange={(v) => onLayout({ section_gap_pt: v, layout_metrics: null })} />
        <Slider label="Between jobs" value={ex.entry_gap_pt} min={0} max={24} step={1} suffix=" pt"
          onChange={(v) => setEntryGaps({ experience: { entry_gap_pt: v } })} />
        <Slider label="Between education entries" value={ed.entry_gap_pt} min={0} max={20} step={1} suffix=" pt"
          onChange={(v) => setEntryGaps({ education: { entry_gap_pt: v } })} />
      </ControlCard>

      <ControlCard icon={FileText} title="Page">
        <Segmented<'letter' | 'a4'>
          label="Paper size"
          value={l.paper === 'a4' ? 'a4' : 'letter'}
          options={[
            { value: 'letter', label: 'US Letter' },
            { value: 'a4', label: 'A4' },
          ]}
          onChange={(v) => onLayout({ paper: v })}
        />
        <Segmented<number | ''>
          label="Margins"
          value={margin != null && MARGINS.some((m) => m.value === margin) ? margin : ''}
          options={MARGINS}
          onChange={(v) => v !== '' && setMargin(v)}
        />
        <BoxSidesField
          label="Custom margins"
          suffix=" (pt)"
          values={marginSides(l)}
          min={18}
          max={108}
          step={1}
          onChangeSide={(side, v) => onLayout({ [`margin_${side}_pt`]: v } as Partial<LayoutConfig>)}
          onChangeAll={setMargin}
        />
      </ControlCard>
    </>
  );
}
