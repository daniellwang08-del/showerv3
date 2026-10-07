import { ChevronDown, Droplet } from 'lucide-react';
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
    <ControlCard icon={Droplet} title="Color">
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
                active ? 'border-brand' : 'border-transparent hover:border-border'
              }`}
              style={{ backgroundColor: p.colors.accent }}
            >
              <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: p.colors.heading }} />
            </button>
          );
        })}
      </div>
      <details className="group border-t pt-2">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded py-1 text-xs font-medium text-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          Custom colors
          <ChevronDown className="size-3.5 text-muted-foreground transition group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="mt-2 space-y-2">
          <ColorField label="Accent" value={c.accent} onChange={(v) => onChange({ accent: v })} />
          <ColorField label="Headings" value={c.heading} onChange={(v) => onChange({ heading: v })} />
          <ColorField label="Body text" value={c.text} onChange={(v) => onChange({ text: v })} />
          <ColorField label="Dates and details" value={c.muted} onChange={(v) => onChange({ muted: v })} />
        </div>
      </details>
    </ControlCard>
  );
}
