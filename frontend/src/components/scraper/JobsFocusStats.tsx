import type { LucideIcon } from 'lucide-react';
import {
  CalendarDays,
  CirclePlay,
  ClipboardCheck,
  Loader2,
  Rocket,
  Wifi,
} from 'lucide-react';
import type { ScraperStats } from '../../types/scraper';
import { card, mutedText } from '../../ui/tokens';

function safe(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return safe(n).toLocaleString();
}

type FocusKey = 'today' | 'today_remote' | 'today_ready' | 'applied_today' | 'in_progress';

interface FocusTile {
  key: FocusKey;
  label: string;
  hint: string;
  value: number;
  icon: LucideIcon;
  accent: string;
  chip: string;
}

interface JobsFocusStatsProps {
  stats: ScraperStats | null;
  loading?: boolean;
  onSelect: (key: FocusKey) => void;
}

/**
 * Compact Jobs-page pulse: today-scoped intake + applied today + in-progress pipeline.
 * Full analytics live on Job Analysis.
 */
export function JobsFocusStats({ stats, loading, onSelect }: JobsFocusStatsProps) {
  if (!stats && loading) {
    return (
      <div className={`${card} flex items-center justify-center gap-2 px-4 py-8 ${mutedText}`}>
        <Loader2 size={16} className="animate-spin" />
        Loading today’s pulse…
      </div>
    );
  }

  const today = safe(stats?.today_scraped);
  const todayRemote = safe(stats?.today_remote);
  const todayReady = safe(stats?.today_ready_jobs);
  const appliedToday = safe(stats?.applied_today);
  const inProgress = safe(stats?.available_jobs ?? stats?.today_available_jobs);

  const tiles: FocusTile[] = [
    {
      key: 'today',
      label: "Today's new jobs",
      hint: 'Added to your pool today',
      value: today,
      icon: CalendarDays,
      accent: 'from-sky-500 to-blue-600',
      chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    },
    {
      key: 'today_remote',
      label: 'Remote today',
      hint: `Of ${fmt(today)} new today`,
      value: todayRemote,
      icon: Wifi,
      accent: 'from-cyan-500 to-teal-600',
      chip: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
    },
    {
      key: 'today_ready',
      label: 'Ready today',
      hint: 'Resume built · not applied',
      value: todayReady,
      icon: Rocket,
      accent: 'from-emerald-500 to-teal-600',
      chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    },
    {
      key: 'applied_today',
      label: 'Applied today',
      hint: 'Marked applied today',
      value: appliedToday,
      icon: ClipboardCheck,
      accent: 'from-violet-500 to-indigo-600',
      chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    },
    {
      key: 'in_progress',
      label: 'In progress',
      hint: 'Match / tailor / build underway',
      value: inProgress,
      icon: CirclePlay,
      accent: 'from-amber-500 to-orange-600',
      chip: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
    },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 lg:gap-3">
      {tiles.map((tile) => {
        const Icon = tile.icon;
        return (
          <button
            key={tile.key}
            type="button"
            onClick={() => onSelect(tile.key)}
            title={tile.hint}
            className={`${card} group relative overflow-hidden px-3.5 py-3 text-left transition hover:-translate-y-0.5 hover:border-sky-300/60 hover:shadow-md dark:hover:border-sky-400/30`}
          >
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${tile.accent}`}
            />
            <div className="flex items-start justify-between gap-2 pl-1.5">
              <div className="min-w-0">
                <p className={`text-[11px] font-semibold uppercase tracking-wide ${mutedText}`}>
                  {tile.label}
                </p>
                <p className="mt-1 text-2xl font-black tabular-nums tracking-tight text-slate-900 dark:text-white">
                  {fmt(tile.value)}
                </p>
                <p className={`mt-0.5 truncate text-[11px] ${mutedText}`}>{tile.hint}</p>
              </div>
              <span
                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tile.chip}`}
              >
                <Icon size={16} strokeWidth={2.4} />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export type { FocusKey };
