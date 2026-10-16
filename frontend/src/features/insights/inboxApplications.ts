import type { MailApplicationsOverview } from '@/types/interviews';

export type ApplicationsRow = { day: string; date: string; applications: number; average: number };

export const APPLICATION_RANGES = [7, 14, 30] as const;
export type ApplicationRange = (typeof APPLICATION_RANGES)[number];

const AVERAGE_WINDOW = 7;

/** Daily confirmations plus a trailing 7-day average (shorter at the start of the range). */
export function buildApplicationRows(data: MailApplicationsOverview | undefined): ApplicationsRow[] {
  const series = data?.series ?? [];
  return series.map((point, i) => {
    const window = series.slice(Math.max(0, i - AVERAGE_WINDOW + 1), i + 1);
    const avg = window.reduce((s, p) => s + p.count, 0) / window.length;
    return { day: point.label, date: point.date, applications: point.count, average: Math.round(avg * 10) / 10 };
  });
}

/** Busiest day in the range, or null when nothing was sent. */
export function busiestDay(rows: ApplicationsRow[]): ApplicationsRow | null {
  let best: ApplicationsRow | null = null;
  for (const row of rows) if (row.applications > (best?.applications ?? 0)) best = row;
  return best;
}

export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function exactDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
