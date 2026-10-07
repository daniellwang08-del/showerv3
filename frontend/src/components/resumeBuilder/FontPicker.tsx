import { Check, Type } from 'lucide-react';
import type { FontOption, ResumeDesign, Typography } from '../../types/resumeDesign';
import { ControlCard } from './controls';
import { RESUME_FONT_RENDER } from './ResumePreview';

const GROUPS: { id: FontOption['category']; label: string }[] = [
  { id: 'sans', label: 'Sans serif' },
  { id: 'serif', label: 'Serif' },
];

/** Font tiles rendered in their own face, so the choice is visual, not a name list. */
export function FontPicker({
  design,
  fonts,
  onChange,
}: {
  design: ResumeDesign;
  fonts: FontOption[];
  onChange: (patch: Partial<Typography>) => void;
}) {
  const current = design.typography.font_family;
  return (
    <ControlCard icon={Type} title="Font">
      {GROUPS.map((g) => {
        const list = fonts.filter((f) => f.category === g.id);
        if (list.length === 0) return null;
        return (
          <div key={g.id} className="min-w-0">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</div>
            <div role="radiogroup" aria-label={`${g.label} fonts`} className="grid grid-cols-2 gap-1.5">
              {list.map((f) => {
                const active = f.family === current;
                const face = RESUME_FONT_RENDER[f.family] ?? f.family;
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onChange({ font_family: f.family })}
                    className={`relative flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                      active ? 'border-brand bg-brand-soft ring-1 ring-brand/40' : 'bg-card hover:border-foreground/20 hover:bg-muted/60'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-lg leading-none text-foreground"
                      style={{ fontFamily: `"${face}", ${g.id === 'serif' ? 'serif' : 'sans-serif'}` }}
                    >
                      Aa
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                      style={{ fontFamily: `"${face}", ${g.id === 'serif' ? 'serif' : 'sans-serif'}` }}
                    >
                      {f.label}
                    </span>
                    {active && <Check className="size-3.5 shrink-0 text-brand" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </ControlCard>
  );
}
