import type { WeeklyProgress } from '@/api/scraperApi';
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

/** One slice of the visible pool. Slices never overlap and add up to the pool. */
export type PipelineStage = {
  key: 'applied' | 'ready' | 'scored' | 'unscored';
  label: string;
  hint: string;
  value: number;
  /** Share of the visible pool, 0-100. */
  ofPool: number;
  /** Null when no board view lists exactly this slice. */
  filters: BoardFilters | null;
};

export type MatchSlice = { key: 'strong' | 'good' | 'low'; label: string; value: number; ofScored: number; filters: BoardFilters | null };

export type TrendRow = { day: string; ready: number; available: number; remote: number; best: number; applied: number };

export type ActivityRow = { day: string; date: string; posted: number; recommended: number; applied: number };

export type SourceRow = { source: string; label: string; count: number; width: number; share: number; latest: string | null };

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

/** ``inboxToday`` is today's confirmation emails; when given it replaces the marked-applied count. */
export function buildTodayTiles(stats: ScraperStats, inboxToday?: number | null): InsightTile[] {
  const todayAvailable = safe(stats.today_available_jobs);
  const todayNew = safe(stats.today_scraped);
  return [
    tile('today', "Today's new", todayNew, { view: 'today' }, 'Added to your pool since midnight'),
    tile(
      'today_remote',
      'Remote among them',
      safe(stats.today_remote),
      { view: 'today', remote_only: true },
      todayNew > 0 ? `${pct(safe(stats.today_remote), todayNew)}% of today's new` : undefined,
    ),
    tile(
      'today_ready',
      'Ready among them',
      safe(stats.today_ready_jobs),
      { view: 'ready' },
      todayAvailable > 0 ? `${fmt(todayAvailable)} scored, not ready yet` : `${fmt(stats.ready_jobs)} ready in total`,
    ),
    inboxToday != null
      ? tile('applied_today', 'Applied today', safe(inboxToday), { view: 'applied_today' }, 'Confirmation emails since midnight')
      : tile('applied_today', 'Applied today', safe(stats.applied_today), { view: 'applied_today' }, 'Marked applied since midnight'),
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
      'Above your minimum',
      safe(stats.qualified_jobs ?? stats.good_jobs),
      { view: 'suggested', min_match_score: 0 },
      'Scored at or above your saved limit',
    ),
    tile('strong', 'Strong (≥75)', safe(stats.best_jobs), { view: 'suggested', min_match_score: 75 }, 'Score 75 or higher'),
    tile('avg', 'Avg match score', safe(stats.avg_match_score), { view: 'suggested' }, `Across ${fmt(scored)} scored jobs`),
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

export function buildPipeline(stats: ScraperStats): PipelineStage[] {
  const total = safe(stats.total_jobs);
  const applied = safe(stats.applied_jobs);
  const ready = safe(stats.ready_jobs);
  const scored = safe(stats.available_jobs);
  const unscored = Math.max(0, total - applied - ready - scored);
  const stage = (
    key: PipelineStage['key'],
    label: string,
    hint: string,
    value: number,
    filters: BoardFilters | null,
  ): PipelineStage => ({ key, label, hint, value, ofPool: pct(value, total), filters });
  return [
    stage('applied', 'Applied', 'Marked applied or confirmed by email', applied, { view: 'applied' }),
    stage('ready', 'Ready', 'Documents built, not applied', ready, { view: 'ready' }),
    stage('scored', 'Scored', 'Match scored, documents not built', scored, { view: 'available' }),
    stage('unscored', 'Not scored yet', 'Still reading or waiting for a score', unscored, null),
  ];
}

export function buildMatchQuality(stats: ScraperStats): MatchSlice[] {
  const scored = safe(stats.scored_jobs);
  const strong = safe(stats.best_jobs);
  const good = safe(stats.good_jobs);
  const low = Math.max(0, scored - strong - good);
  return [
    { key: 'strong', label: 'Strong (75+)', value: strong, ofScored: pct(strong, scored), filters: { view: 'suggested', min_match_score: 75 } },
    { key: 'good', label: 'Good (50-74)', value: good, ofScored: pct(good, scored), filters: { view: 'suggested', min_match_score: 50 } },
    { key: 'low', label: 'Below 50', value: low, ofScored: pct(low, scored), filters: null },
  ];
}

/** ISO dates become "Oct 3"; anything else (e.g. "Mon") passes through. */
export function formatTrendLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (!m) return label;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function buildTrendRows(stats: ScraperStats): TrendRow[] {
  const t = stats.trends;
  const labels = t?.labels ?? [];
  return labels.map((day, i) => ({
    day: formatTrendLabel(t?.dates?.[i] ?? day),
    ready: safe(t?.ready?.[i]),
    available: safe(t?.available?.[i]),
    remote: safe(t?.remote?.[i]),
    best: safe(t?.best?.[i]),
    applied: safe(t?.applied?.[i]),
  }));
}

export function buildActivityRows(progress: WeeklyProgress | undefined): ActivityRow[] {
  return (progress?.series ?? []).map((d) => ({
    day: formatTrendLabel(d.date),
    date: d.date,
    posted: safe(d.posted),
    recommended: safe(d.recommended),
    applied: safe(d.applied),
  }));
}

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Added by you',
  admin_manual: 'Added by admin',
  unknown: 'Other',
  jobright: 'Jobright',
  linkedin: 'LinkedIn',
  remote_ok: 'Remote OK',
  remoteok: 'Remote OK',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  indeed: 'Indeed',
};

export function sourceLabel(source: string): string {
  const key = source.toLowerCase();
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  const words = source.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other';
}

export function topSources(stats: ScraperStats, limit = 8): SourceRow[] {
  const all = stats.sources ?? [];
  const totalCount = all.reduce((sum, s) => sum + safe(s.count), 0);
  const sources = all.slice(0, limit);
  const max = Math.max(...sources.map((s) => safe(s.count)), 1);
  return sources.map((s) => ({
    source: s.source,
    label: sourceLabel(s.source),
    count: safe(s.count),
    width: pct(safe(s.count), max),
    share: pct(safe(s.count), totalCount),
    latest: s.latest_scraped ?? null,
  }));
}

export function sumBy<T>(rows: T[], key: keyof T): number {
  return rows.reduce((sum, r) => sum + safe(r[key] as unknown as number), 0);
}
