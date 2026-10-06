import type { JobCleanupMatchField, JobCleanupResult } from '@/types/admin';
import type { MultiSeriesMeta } from '@/types/dataManagement';

export type ChartSeries = { key: string; label: string; color: string; dash?: string };
export type ChartRow = Record<string, string | number>;

/** Keep in sync with backend UserActivitySeriesRequest.user_ids max_length. */
export const MAX_ACTIVITY_USERS = 25;
export const DEFAULT_ACTIVITY_USERS = 5;

export const chartColor = (n: 1 | 2 | 3 | 4 | 5) => `var(--chart-${n})`;

const DASHES = [undefined, '6 3', '2 3', '10 4 2 4'];

/** Cycle the five chart tokens; vary the dash pattern once colors repeat so lines stay distinguishable. */
export function cycleSeries(index: number, palette: number[] = [1, 2, 3, 4, 5]): Pick<ChartSeries, 'color' | 'dash'> {
  return {
    color: `var(--chart-${palette[index % palette.length]})`,
    dash: DASHES[Math.floor(index / palette.length) % DASHES.length],
  };
}

/** Fixed colors for well-known keys; anything else cycles from `offset`. */
export function toChartSeries(
  meta: MultiSeriesMeta[] | undefined,
  fixed: Record<string, string> = {},
  offset = 0,
): ChartSeries[] {
  if (!meta) return [];
  let free = offset;
  return meta.map((s) => {
    const color = fixed[s.key];
    if (color) return { key: s.key, label: s.label, color };
    return { key: s.key, label: s.label, ...cycleSeries(free++) };
  });
}

export function fmt(n: number | undefined | null): string {
  return Number(n || 0).toLocaleString();
}

export type ChartValueFormat = 'number' | 'usd';

/** Sub-dollar amounts keep four decimals so per-call AI costs don't all read as $0.00. */
export function formatUsd(value: number | undefined | null): string {
  const v = Number(value || 0);
  const digits = v !== 0 && Math.abs(v) < 1 ? 4 : 2;
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: digits });
}

const compactTokens = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const fmtTokens = (n: number | undefined | null) => compactTokens.format(Number(n || 0));

export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (typeof d === 'object' && d && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join('; ');
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export const monthKey = (m: { year: number; month: number }) => `${m.year}-${m.month}`;

export function parseMonthKey(key: string | null): { year: number; month: number } | null {
  if (!key) return null;
  const [year, month] = key.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) return null;
  return { year, month };
}

export function formatDayTick(value: unknown): string {
  const parts = String(value ?? '').split('-');
  if (parts.length !== 3) return String(value ?? '');
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export function formatDayLabel(value: unknown): string {
  const parts = String(value ?? '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return String(value ?? '');
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export const MATCH_FIELD_OPTIONS: Array<{ id: JobCleanupMatchField; label: string }> = [
  { id: 'company', label: 'Company' },
  { id: 'domain', label: 'Domain' },
  { id: 'source_url', label: 'Source URL' },
  { id: 'normalized_url', label: 'Normalized URL' },
  { id: 'title', label: 'Title' },
];

export const PATTERN_EXAMPLES = [
  { label: 'LinkedIn', value: String.raw`linkedin\.com` },
  { label: 'Companies', value: 'acme|globex' },
  { label: 'Lever', value: String.raw`jobs\.lever\.co` },
];

export function formatCreated(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function criteriaSummary(preview: {
  older_than_days?: JobCleanupResult['older_than_days'];
  pattern?: JobCleanupResult['pattern'];
  match_fields?: JobCleanupResult['match_fields'];
}): string {
  const parts: string[] = [];
  if (preview.older_than_days != null) parts.push(`older than ${preview.older_than_days} days`);
  if (preview.pattern) {
    const fields = preview.match_fields?.length ? preview.match_fields.join(', ') : 'selected fields';
    parts.push(`pattern /${preview.pattern}/ on ${fields}`);
  }
  return parts.join(' and ') || 'current criteria';
}

export const plural = (n: number, word: string, suffix = 's') => `${fmt(n)} ${word}${n === 1 ? '' : suffix}`;
