import type { DashboardView } from '@/api/scraperApi';

/** Colour identity per job view, shared by the summary cards and the view tabs. */
export interface ViewTone {
  dot: string;
  /** Tinted pill for counts and icon chips. */
  soft: string;
  ring: string;
}

const NEUTRAL: ViewTone = {
  dot: 'bg-muted-foreground/60',
  soft: 'bg-foreground/[0.07] text-foreground',
  ring: 'ring-foreground/20',
};

const TONES: Partial<Record<DashboardView, ViewTone>> = {
  today: {
    dot: 'bg-status-new',
    soft: 'bg-status-new/15 text-sky-700 dark:text-sky-300',
    ring: 'ring-status-new/45',
  },
  available: {
    dot: 'bg-status-preparing',
    soft: 'bg-status-preparing/20 text-amber-800 dark:text-amber-300',
    ring: 'ring-status-preparing/55',
  },
  ready: {
    dot: 'bg-status-ready',
    soft: 'bg-status-ready/15 text-emerald-700 dark:text-emerald-300',
    ring: 'ring-status-ready/45',
  },
  all: NEUTRAL,
  mine: {
    dot: 'bg-brand',
    soft: 'bg-brand/15 text-brand',
    ring: 'ring-brand/45',
  },
  applied: {
    dot: 'bg-status-applied',
    soft: 'bg-status-applied/15 text-indigo-700 dark:text-indigo-300',
    ring: 'ring-status-applied/45',
  },
  applied_today: {
    dot: 'bg-status-applied',
    soft: 'bg-status-applied/15 text-indigo-700 dark:text-indigo-300',
    ring: 'ring-status-applied/45',
  },
  sheet_posted: {
    dot: 'bg-chart-2',
    soft: 'bg-chart-2/15 text-teal-700 dark:text-teal-300',
    ring: 'ring-chart-2/45',
  },
  pumble_posted: {
    dot: 'bg-chart-4',
    soft: 'bg-chart-4/15 text-cyan-700 dark:text-cyan-300',
    ring: 'ring-chart-4/45',
  },
};

export function viewTone(view: DashboardView): ViewTone {
  return TONES[view] ?? NEUTRAL;
}
