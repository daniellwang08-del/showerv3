import { useState } from 'react';
import { Ban, Globe, X } from 'lucide-react';
import {
  AUTO_POST_WORK_MODE_OPTIONS,
  type AutoPostFilters,
  type AutoPostWorkMode,
} from '../../types/autoPostFilters';

interface AutoPostFiltersEditorProps {
  value: AutoPostFilters;
  onChange: (next: AutoPostFilters) => void;
  disabled?: boolean;
  /** Accent for focus rings / active chips (sheets=teal, pumble=violet). */
  accent?: 'teal' | 'violet';
}

function ExcludeCompanyList({
  values,
  disabled,
  focusRing,
  onChange,
}: {
  values: string[];
  disabled?: boolean;
  focusRing: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    if (disabled) return;
    const name = draft.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (values.some((v) => v.toLowerCase() === key)) {
      setDraft('');
      return;
    }
    onChange([...values, name]);
    setDraft('');
  };

  return (
    <div>
      <label className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
        <Ban size={12} />
        Exclude companies
      </label>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
        Skip auto-post when the company name contains any of these (e.g. former employers).
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="e.g. Acme Corp"
          className={`min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:ring-2 ${focusRing} disabled:opacity-50`}
        />
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={add}
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
      </div>
      {values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-900"
            >
              {name}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${name}`}
                onClick={() => onChange(values.filter((v) => v !== name))}
                className="rounded-full p-0.5 hover:bg-black/5 disabled:opacity-40"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Auto-post filters: work mode + exclude companies. */
export function AutoPostFiltersEditor({
  value,
  onChange,
  disabled = false,
  accent = 'teal',
}: AutoPostFiltersEditorProps) {
  const accentActive =
    accent === 'violet'
      ? 'border-violet-400 bg-violet-50 text-violet-800'
      : 'border-emerald-400 bg-emerald-50 text-emerald-800';
  const focusRing =
    accent === 'violet'
      ? 'focus:border-violet-400 focus:ring-violet-200'
      : 'focus:border-teal-400 focus:ring-teal-200';

  const toggleMode = (mode: AutoPostWorkMode) => {
    if (disabled) return;
    const set = new Set(value.work_modes);
    if (set.has(mode)) set.delete(mode);
    else set.add(mode);
    onChange({ ...value, work_modes: [...set] as AutoPostWorkMode[] });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <Globe size={12} />
            Work mode
          </span>
          <button
            type="button"
            disabled={disabled || value.work_modes.length === 0}
            onClick={() => onChange({ ...value, work_modes: [] })}
            className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-40"
          >
            Allow all
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {AUTO_POST_WORK_MODE_OPTIONS.map(({ value: mode, label }) => {
            const active = value.work_modes.includes(mode);
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                onClick={() => toggleMode(mode)}
                className={[
                  'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                  active
                    ? accentActive
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
                  disabled ? 'cursor-not-allowed opacity-50' : '',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {value.work_modes.length === 0
            ? 'Any work mode (remote, hybrid, or onsite)'
            : `Only: ${value.work_modes.join(', ')}`}
        </p>
      </div>

      <ExcludeCompanyList
        values={value.exclude_companies}
        disabled={disabled}
        focusRing={focusRing}
        onChange={(exclude_companies) => onChange({ ...value, exclude_companies })}
      />
    </div>
  );
}
