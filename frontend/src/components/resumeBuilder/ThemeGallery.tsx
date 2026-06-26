import { Check, Palette } from 'lucide-react';
import type { ResumeDesign, ThemePreset } from '../../types/resumeDesign';
import { ControlCard } from './controls';

export function ThemeGallery({
  themes,
  design,
  onApply,
}: {
  themes: ThemePreset[];
  design: ResumeDesign;
  onApply: (theme: ThemePreset) => void;
}) {
  return (
    <ControlCard icon={Palette} title="Theme">
      <div className="grid grid-cols-1 gap-2">
        {themes.map((theme) => {
          const active = theme.id === design.theme_id;
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => onApply(theme)}
              className={`flex items-start gap-3 rounded-lg border p-2.5 text-left transition ${
                active
                  ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white"
                style={{ backgroundColor: theme.accent_swatch }}
              >
                {active ? <Check size={16} /> : <span className="text-[10px] font-bold">Aa</span>}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">{theme.label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-slate-500">{theme.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </ControlCard>
  );
}
