import { Type } from 'lucide-react';
import type { FontOption, ResumeDesign, Typography } from '../../types/resumeDesign';
import { ControlCard, Slider, Toggle } from './controls';

export function TypographyControls({
  design,
  fonts,
  onChange,
}: {
  design: ResumeDesign;
  fonts: FontOption[];
  onChange: (patch: Partial<Typography>) => void;
}) {
  const t = design.typography;
  return (
    <ControlCard icon={Type} title="Typography">
      <label className="block">
        <div className="mb-1 text-xs font-medium text-slate-600">Font family</div>
        <select
          value={t.font_family}
          onChange={(e) => onChange({ font_family: e.target.value })}
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {fonts.map((f) => (
            <option key={f.id} value={f.family}>
              {f.label} ({f.category})
            </option>
          ))}
        </select>
      </label>
      <Slider label="Body size" value={t.base_font_pt} min={8} max={14} step={0.5} suffix=" pt"
        onChange={(v) => onChange({ base_font_pt: v })} />
      <Slider label="Heading scale" value={t.heading_scale} min={1} max={2.2} step={0.05}
        format={(v) => `${v.toFixed(2)}×`} onChange={(v) => onChange({ heading_scale: v })} />
      <Slider label="Name scale" value={t.name_scale} min={1.4} max={3.5} step={0.1}
        format={(v) => `${v.toFixed(1)}×`} onChange={(v) => onChange({ name_scale: v })} />
      <Slider label="Line spacing" value={t.line_spacing} min={1} max={2} step={0.02}
        format={(v) => v.toFixed(2)} onChange={(v) => onChange({ line_spacing: v })} />
      <Toggle label="Uppercase headings" checked={t.uppercase_headings}
        onChange={(v) => onChange({ uppercase_headings: v })} />
    </ControlCard>
  );
}
