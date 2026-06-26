import { GraduationCap } from 'lucide-react';
import type { EducationStyle } from '../../types/resumeDesign';
import { ControlCard, Segmented, Toggle } from './controls';

export function EducationControls({
  style,
  onChange,
}: {
  style: EducationStyle;
  onChange: (patch: Partial<EducationStyle>) => void;
}) {
  return (
    <ControlCard icon={GraduationCap} title="Education">
      <Segmented<EducationStyle['header_layout']>
        label="Header layout"
        value={style.header_layout}
        onChange={(v) => onChange({ header_layout: v })}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'stacked', label: 'Stacked' },
        ]}
      />
      <Segmented<EducationStyle['date_position']>
        label="Date position"
        value={style.date_position}
        onChange={(v) => onChange({ date_position: v })}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'right', label: 'Right' },
          { value: 'below', label: 'Below' },
        ]}
      />
      <Segmented<EducationStyle['surface']>
        label="Surface"
        value={style.surface}
        onChange={(v) => onChange({ surface: v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'divider', label: 'Divider' },
          { value: 'left_bar', label: 'Bar' },
          { value: 'tint', label: 'Tint' },
          { value: 'card', label: 'Card' },
        ]}
      />
      <Segmented<EducationStyle['accent_target']>
        label="Accent"
        value={style.accent_target}
        onChange={(v) => onChange({ accent_target: v })}
        options={[
          { value: 'university', label: 'School' },
          { value: 'degree', label: 'Degree' },
          { value: 'none', label: 'None' },
        ]}
      />

      <div className="space-y-2 border-t border-slate-100 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Show items</p>
        <Toggle label="Dates" checked={style.show_period} onChange={(v) => onChange({ show_period: v })} />
        <Toggle label="Grade / GPA" checked={style.show_mark} onChange={(v) => onChange({ show_mark: v })} />
        <Toggle label="Location" checked={style.show_location} onChange={(v) => onChange({ show_location: v })} />
        <Toggle label="Description" checked={style.show_description} onChange={(v) => onChange({ show_description: v })} />
      </div>
    </ControlCard>
  );
}
