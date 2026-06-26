import { Droplet } from 'lucide-react';
import type { ColorPreset, DesignColors, ResumeDesign } from '../../types/resumeDesign';
import { ColorField, ControlCard } from './controls';

export function ColorControls({
  design,
  presets,
  onChange,
  onApplyPreset,
}: {
  design: ResumeDesign;
  presets: ColorPreset[];
  onChange: (patch: Partial<DesignColors>) => void;
  onApplyPreset: (preset: ColorPreset) => void;
}) {
  const c = design.colors;
  return (
    <ControlCard icon={Droplet} title="Colors">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => {
          const active =
            p.colors.accent === c.accent && p.colors.heading === c.heading && p.colors.text === c.text;
          return (
            <button
              key={p.id}
              type="button"
              title={p.label}
              onClick={() => onApplyPreset(p)}
              className={`flex h-8 w-8 items-center justify-center rounded-full border-2 transition ${
                active ? 'border-slate-800' : 'border-transparent hover:border-slate-300'
              }`}
              style={{ backgroundColor: p.colors.accent }}
            >
              <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: p.colors.heading }} />
            </button>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-slate-100 pt-2">
        <ColorField label="Accent" value={c.accent} onChange={(v) => onChange({ accent: v })} />
        <ColorField label="Heading" value={c.heading} onChange={(v) => onChange({ heading: v })} />
        <ColorField label="Body text" value={c.text} onChange={(v) => onChange({ text: v })} />
        <ColorField label="Muted" value={c.muted} onChange={(v) => onChange({ muted: v })} />
      </div>
    </ControlCard>
  );
}
