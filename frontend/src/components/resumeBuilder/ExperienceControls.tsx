import { SlidersHorizontal } from 'lucide-react';
import type { ExperienceStyle } from '../../types/resumeDesign';
import { ControlCard, Segmented, Toggle } from './controls';

export function ExperienceControls({
  style,
  onChange,
}: {
  style: ExperienceStyle;
  onChange: (patch: Partial<ExperienceStyle>) => void;
}) {
  return (
    <ControlCard icon={SlidersHorizontal} title="Experience items">
      <Segmented<ExperienceStyle['header_layout']>
        label="Header layout"
        value={style.header_layout}
        onChange={(v) => onChange({ header_layout: v })}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'stacked', label: 'Stacked' },
          { value: 'two_column', label: 'Two col' },
        ]}
      />
      <Segmented<ExperienceStyle['date_position']>
        label="Date position"
        value={style.date_position}
        onChange={(v) => onChange({ date_position: v })}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'right', label: 'Right' },
          { value: 'below', label: 'Below' },
        ]}
      />
      <Segmented<ExperienceStyle['marker']>
        label="Bullet marker"
        value={style.marker}
        onChange={(v) => onChange({ marker: v })}
        options={[
          { value: 'dot', label: '\u2022' },
          { value: 'dash', label: '\u2013' },
          { value: 'arrow', label: '\u2192' },
          { value: 'chevron', label: '\u203A' },
          { value: 'square', label: '\u25AA' },
          { value: 'numbered', label: '1.' },
        ]}
      />
      <Segmented<ExperienceStyle['used_skills_style']>
        label="Used skills"
        value={style.used_skills_style}
        onChange={(v) => onChange({ used_skills_style: v })}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'label', label: 'Label' },
          { value: 'chips', label: 'Chips' },
          { value: 'pill', label: 'Pills' },
        ]}
      />
      <Segmented<ExperienceStyle['badge_style']>
        label="Type badges"
        value={style.badge_style}
        onChange={(v) => onChange({ badge_style: v })}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'pill', label: 'Pills' },
          { value: 'hidden', label: 'Hide' },
        ]}
      />

      <div className="space-y-2 border-t border-slate-100 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Show items</p>
        <Toggle label="Employment type" checked={style.show_employment_type} onChange={(v) => onChange({ show_employment_type: v })} />
        <Toggle label="Work arrangement" checked={style.show_arrangement} onChange={(v) => onChange({ show_arrangement: v })} />
        <Toggle label="Project title" checked={style.show_project_title} onChange={(v) => onChange({ show_project_title: v })} />
        <Toggle label="Project intro" checked={style.show_intro} onChange={(v) => onChange({ show_intro: v })} />
        <Toggle label='"Key Contributions" label' checked={style.show_contributions_label} onChange={(v) => onChange({ show_contributions_label: v })} />
        <Toggle label="Used skills" checked={style.show_used_skills} onChange={(v) => onChange({ show_used_skills: v })} />
      </div>
    </ControlCard>
  );
}
