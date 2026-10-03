import type { AgentDashboardFilters } from '@/stores/scraperStore';
import type { ScraperStats } from '@/types/scraper';

export type BoardFilters = Omit<AgentDashboardFilters, 'reset'>;

export type TileKey =
  | 'today'
  | 'today_remote'
  | 'today_ready'
  | 'applied_today'
  | 'total'
  | 'applied'
  | 'good'
  | 'strong'
  | 'avg'
  | 'remote'
  | 'mine'
  | 'sheets'
  | 'pumble';

export type InsightTile = {
  key: TileKey;
  label: string;
  value: number;
  /** Rendered as-is (e.g. avg score is not a count). */
  display: string;
  hint?: string;
  filters: BoardFilters;
};

export type FunnelStep = {
  key: 'pool' | 'in_progress' | 'ready' | 'applied';
  label: string;
  value: number;
  /** Bar width relative to the largest step, 0-100. */
  width: number;
  /** Share of the visible pool, 0-100. */
  ofPool: number;
  filters: BoardFilters;
};

export type TrendRow = { day: string; ready: number; available: number; remote: number; best: number };

export type SourceRow = { source: string; label: string; count: number; width: number };

export function safe(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function fmt(n: number | null | undefined): string {
  return safe(n).toLocaleString();
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export function isEmptyPool(stats: ScraperStats): boolean {
  return (
    safe(stats.total_jobs) === 0 &&
    safe(stats.today_scraped) === 0 &&
    safe(stats.applied_jobs) === 0 &&
    safe(stats.my_jobs) === 0
  );
}

function tile(key: TileKey, label: string, value: number, filters: BoardFilters, hint?: string): InsightTile {
  return { key, label, value, display: fmt(value), hint, filters };
}

export function buildTodayTiles(stats: ScraperStats): InsightTile[] {
  const todayAvailable = safe(stats.today_available_jobs);
  return [
    tile('today', "Today's new", safe(stats.today_scraped), { view: 'today' }),
    tile('today_remote', 'Remote among them', safe(stats.today_remote), { view: 'today', remote_only: true }),
    tile(
      'today_ready',
      'Ready among them',
      safe(stats.today_ready_jobs),
      { view: 'ready' },
      todayAvailable > 0 ? `${fmt(todayAvailable)} still in progress` : undefined,
    ),
    tile('applied_today', 'Applied today', safe(stats.applied_today), { view: 'applied_today' }),
  ];
}

export function buildOverviewTiles(stats: ScraperStats): InsightTile[] {
  const total = safe(stats.total_jobs);
  const applied = safe(stats.applied_jobs);
  const appliedToday = safe(stats.applied_today);
  const remote = safe(stats.total_remote);
  const scored = safe(stats.scored_jobs);
  const sheets = safe(stats.sheet_posted_jobs);
  const pumble = safe(stats.pumble_posted_jobs);

  const tiles: InsightTile[] = [
    tile('total', 'Total visible pool', total, { view: 'all' }, total > 0 ? `${pct(remote, total)}% remote` : undefined),
    tile(
      'applied',
      'Applied (all time)',
      applied,
      { view: 'applied' },
      appliedToday > 0 ? `${fmt(appliedToday)} today · ${pct(applied, total)}% of pool` : `${pct(applied, total)}% of pool`,
    ),
    tile(
      'good',
      'Good+ matches',
      safe(stats.qualified_jobs ?? stats.good_jobs),
      { view: 'suggested', min_match_score: 0 },
      'At or above your minimum score',
    ),
    tile('strong', 'Strong (≥75)', safe(stats.best_jobs), { view: 'suggested', min_match_score: 75 }, 'Score 75 or higher'),
    tile('avg', 'Avg match score', safe(stats.avg_match_score), { view: 'suggested' }, `${fmt(scored)} scored`),
    tile(
      'remote',
      'Remote open',
      safe(stats.unapplied_remote_jobs ?? stats.total_remote),
      { view: 'all', remote_only: true },
      `${fmt(remote)} remote in pool`,
    ),
    tile('mine', 'Posted by me', safe(stats.my_jobs), { view: 'mine' }, 'Added by URL or attachment'),
  ];
  if (sheets > 0) tiles.push(tile('sheets', 'In Sheets', sheets, { view: 'sheet_posted' }));
  if (pumble > 0) tiles.push(tile('pumble', 'In Pumble', pumble, { view: 'pumble_posted' }));
  return tiles;
}

export function buildFunnel(stats: ScraperStats): FunnelStep[] {
  const total = safe(stats.total_jobs);
  const available = safe(stats.available_jobs);
  const ready = safe(stats.ready_jobs);
  const applied = safe(stats.applied_jobs);
  const max = Math.max(total, available, ready, applied, 1);
  const step = (key: FunnelStep['key'], label: string, value: number, filters: BoardFilters): FunnelStep => ({
    key,
    label,
    value,
    width: value > 0 ? Math.max(pct(value, max), 4) : 0,
    ofPool: pct(value, total),
    filters,
  });
  return [
    step('pool', 'Visible pool', total, { view: 'all' }),
    step('in_progress', 'In progress', available, { view: 'available' }),
    step('ready', 'Ready', ready, { view: 'ready' }),
    step('applied', 'Applied', applied, { view: 'applied' }),
  ];
}

export function buildTrendRows(stats: ScraperStats): TrendRow[] {
  const t = stats.trends;
  const labels = t?.labels ?? [];
  return labels.map((day, i) => ({
    day: formatTrendLabel(day),
    ready: safe(t?.ready?.[i]),
    available: safe(t?.available?.[i]),
    remote: safe(t?.remote?.[i]),
    best: safe(t?.best?.[i]),
  }));
}

/** ISO dates become "Oct 3"; anything else (e.g. "Mon") passes through. */
export function formatTrendLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (!m) return label;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function topSources(stats: ScraperStats, limit = 8): SourceRow[] {
  const sources = (stats.sources ?? []).slice(0, limit);
  const max = Math.max(...sources.map((s) => safe(s.count)), 1);
  return sources.map((s) => ({
    source: s.source,
    label: s.source.replace(/_/g, ' '),
    count: safe(s.count),
    width: pct(safe(s.count), max),
  }));
}
