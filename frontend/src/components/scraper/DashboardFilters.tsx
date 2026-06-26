import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe, Target } from 'lucide-react';

const FILTER_CONTROL_BASE =
  'inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/25';

interface RemoteFilterToggleProps {
  active: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}

export function RemoteFilterToggle({ active, onChange, className = '' }: RemoteFilterToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={() => onChange(!active)}
      title={active ? 'Showing remote jobs only' : 'Filter to remote jobs'}
      className={[
        FILTER_CONTROL_BASE,
        active
          ? 'border-emerald-400 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
          : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-800',
        className,
      ].join(' ')}
    >
      <Globe size={16} className={active ? 'text-emerald-600' : 'text-slate-500'} />
      <span>Remote</span>
      <span
        className={[
          'ml-0.5 h-2 w-2 shrink-0 rounded-full transition-colors',
          active ? 'bg-emerald-500' : 'bg-slate-300',
        ].join(' ')}
      />
    </button>
  );
}

const SCORE_PRESETS: { value: number; label: string; hint: string }[] = [
  { value: 0, label: 'Any score', hint: 'No match-score filter' },
  { value: 50, label: '50 or higher', hint: 'Fair matches and up' },
  { value: 60, label: '60 or higher', hint: 'Decent matches and up' },
  { value: 70, label: '70 or higher', hint: 'Good matches and up' },
  { value: 80, label: '80 or higher', hint: 'Strong matches and up' },
  { value: 90, label: '90 or higher', hint: 'Excellent matches only' },
];

interface MatchScoreFilterProps {
  value: number;
  onChange: (next: number) => void;
  className?: string;
}

export function MatchScoreFilter({ value, onChange, className = '' }: MatchScoreFilterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = value > 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const handleSelect = (next: number) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Filter by minimum match score"
        className={[
          FILTER_CONTROL_BASE,
          'w-full justify-between',
          active
            ? 'border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100'
            : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-800',
        ].join(' ')}
      >
        <span className="flex items-center gap-2">
          <Target size={16} className={active ? 'text-amber-600' : 'text-slate-500'} />
          <span>{active ? `Match ≥ ${value}` : 'Match score'}</span>
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <div
            role="listbox"
            className="absolute right-0 top-full z-20 mt-2 w-64 origin-top-right overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl ring-1 ring-black/5"
          >
            {SCORE_PRESETS.map((preset) => {
              const isActive = preset.value === value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleSelect(preset.value)}
                  className={[
                    'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
                    isActive ? 'bg-amber-50' : 'hover:bg-slate-50/70',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'flex h-8 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold tabular-nums',
                      isActive ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500',
                    ].join(' ')}
                  >
                    {preset.value === 0 ? 'Any' : `${preset.value}+`}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-sm font-semibold ${isActive ? 'text-amber-700' : 'text-slate-700'}`}>
                        {preset.label}
                      </span>
                      {isActive && <Check size={14} className="shrink-0 text-amber-500" />}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-400">{preset.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
