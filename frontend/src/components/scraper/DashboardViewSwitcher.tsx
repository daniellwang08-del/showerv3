import { useEffect, useRef, useState } from 'react';
import {
  LayoutGrid,
  CalendarClock,
  UserRound,
  Sparkles,
  ChevronDown,
  Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardView, DashboardCounts } from '../../api/scraperApi';

interface ViewMeta {
  id: DashboardView;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tailwind classes for the icon chip (active state). */
  accent: string;
  /** Tailwind ring/text color used on the active trigger + selected row. */
  active: string;
}

export const DASHBOARD_VIEWS: ViewMeta[] = [
  {
    id: 'today',
    label: "Today's new jobs",
    description: 'Jobs added to the system today',
    icon: CalendarClock,
    accent: 'bg-emerald-50 text-emerald-600',
    active: 'text-emerald-700',
  },
  {
    id: 'mine',
    label: 'Jobs from me',
    description: 'Everything you added by URL or attachment',
    icon: UserRound,
    accent: 'bg-violet-50 text-violet-600',
    active: 'text-violet-700',
  },
  {
    id: 'all',
    label: 'All jobs in system',
    description: 'Scraped, shared, and your own jobs',
    icon: LayoutGrid,
    accent: 'bg-blue-50 text-blue-600',
    active: 'text-blue-700',
  },
  {
    id: 'suggested',
    label: 'Suggested jobs',
    description: 'Analysed matches at or above your minimum score',
    icon: Sparkles,
    accent: 'bg-amber-50 text-amber-600',
    active: 'text-amber-700',
  },
];

const VIEW_BY_ID: Record<DashboardView, ViewMeta> = DASHBOARD_VIEWS.reduce(
  (acc, v) => ({ ...acc, [v.id]: v }),
  {} as Record<DashboardView, ViewMeta>,
);

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

interface DashboardViewSwitcherProps {
  view: DashboardView;
  counts: DashboardCounts;
  onChange: (view: DashboardView) => void;
}

export function DashboardViewSwitcher({ view, counts, onChange }: DashboardViewSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const current = VIEW_BY_ID[view] ?? VIEW_BY_ID.all;
  const CurrentIcon = current.icon;
  const currentCount = counts[view] ?? 0;

  const handleSelect = (next: DashboardView) => {
    setOpen(false);
    onChange(next);
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'group inline-flex items-center gap-2.5 rounded-xl border bg-white py-2 pl-2.5 pr-3 text-sm font-semibold shadow-sm transition-all',
          open
            ? 'border-slate-300 ring-2 ring-slate-900/5'
            : 'border-slate-200 hover:border-slate-300 hover:shadow',
        ].join(' ')}
      >
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${current.accent}`}>
          <CurrentIcon size={16} />
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
            Viewing
          </span>
          <span className={current.active}>{current.label}</span>
        </span>
        <span className="ml-1 inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-bold tabular-nums text-slate-600">
          {formatCount(currentCount)}
        </span>
        <ChevronDown
          size={16}
          className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <div
            role="listbox"
            className="absolute left-0 top-full z-20 mt-2 w-[19rem] origin-top-left overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl ring-1 ring-black/5"
          >
            {DASHBOARD_VIEWS.map((v) => {
              const Icon = v.icon;
              const isActive = v.id === view;
              const count = counts[v.id] ?? 0;
              return (
                <button
                  key={v.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleSelect(v.id)}
                  className={[
                    'flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors',
                    isActive ? 'bg-slate-50' : 'hover:bg-slate-50/70',
                  ].join(' ')}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${v.accent}`}
                  >
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-sm font-semibold ${isActive ? v.active : 'text-slate-700'}`}>
                        {v.label}
                      </span>
                      {isActive && <Check size={14} className="shrink-0 text-slate-400" />}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-400">
                      {v.description}
                    </span>
                  </span>
                  <span
                    className={[
                      'inline-flex min-w-[1.75rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums',
                      isActive ? 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200' : 'bg-slate-100 text-slate-500',
                    ].join(' ')}
                  >
                    {formatCount(count)}
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
