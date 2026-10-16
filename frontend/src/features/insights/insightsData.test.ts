import { describe, expect, it } from 'vitest';
import { makeStats } from './insightsFixtures';
import {
  buildActivityRows,
  buildMatchQuality,
  buildOverviewTiles,
  buildPipeline,
  buildTodayTiles,
  buildTrendRows,
  formatTrendLabel,
  isEmptyPool,
  pct,
  safe,
  sourceLabel,
  sumBy,
  topSources,
} from './insightsData';

describe('insightsData helpers', () => {
  it('safe and pct handle bad input', () => {
    expect(safe(undefined)).toBe(0);
    expect(safe(Number.NaN)).toBe(0);
    expect(pct(1, 0)).toBe(0);
    expect(pct(1, 3)).toBe(33);
  });

  it('detects an empty pool', () => {
    expect(isEmptyPool(makeStats())).toBe(false);
    expect(isEmptyPool(makeStats({ total_jobs: 0, today_scraped: 0, applied_jobs: 0, my_jobs: 0 }))).toBe(true);
    expect(isEmptyPool(makeStats({ total_jobs: 0, today_scraped: 0, applied_jobs: 0, my_jobs: 1 }))).toBe(false);
  });

  it('builds today tiles with board filters', () => {
    const tiles = buildTodayTiles(makeStats());
    expect(tiles.map((t) => [t.label, t.value, t.filters])).toEqual([
      ["Today's new", 12, { view: 'today' }],
      ['Remote among them', 5, { view: 'today', remote_only: true }],
      ['Ready among them', 3, { view: 'ready' }],
      ['Applied today', 2, { view: 'applied_today' }],
    ]);
    expect(tiles[1].hint).toBe("42% of today's new");
  });

  it('builds overview tiles and only shows Sheets/Pumble when > 0', () => {
    const tiles = buildOverviewTiles(makeStats());
    expect(tiles.map((t) => t.key)).toEqual(['total', 'applied', 'good', 'strong', 'avg', 'remote', 'mine']);
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.good.label).toBe('Above your minimum');
    expect(byKey.good.value).toBe(70);
    expect(byKey.strong.filters).toEqual({ view: 'suggested', min_match_score: 75 });
    expect(byKey.remote.value).toBe(60);
    expect(byKey.applied.hint).toBe('2 today · 15% of pool');

    const withPosts = buildOverviewTiles(makeStats({ sheet_posted_jobs: 4, pumble_posted_jobs: 1 }));
    expect(withPosts.slice(-2).map((t) => [t.key, t.value, t.filters.view])).toEqual([
      ['sheets', 4, 'sheet_posted'],
      ['pumble', 1, 'pumble_posted'],
    ]);
  });

  it('falls back to good_jobs and total_remote on older backends', () => {
    const tiles = buildOverviewTiles(makeStats({ qualified_jobs: undefined, unapplied_remote_jobs: undefined }));
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.good.value).toBe(50);
    expect(byKey.remote.value).toBe(80);
  });

  it('splits the pool into stages that add up to the pool', () => {
    const stages = buildPipeline(makeStats());
    expect(stages.map((s) => [s.key, s.value, s.ofPool, s.filters?.view ?? null])).toEqual([
      ['applied', 30, 15, 'applied'],
      ['ready', 40, 20, 'ready'],
      ['scored', 90, 45, 'available'],
      ['unscored', 40, 20, null],
    ]);
    expect(stages.reduce((s, x) => s + x.value, 0)).toBe(200);
    expect(buildPipeline(makeStats({ total_jobs: 10 }))[3].value).toBe(0);
  });

  it('splits scored jobs into strong, good and below 50', () => {
    expect(buildMatchQuality(makeStats()).map((q) => [q.key, q.value, q.ofScored])).toEqual([
      ['strong', 25, 21],
      ['good', 50, 42],
      ['low', 45, 38],
    ]);
  });

  it('labels trend rows by their ISO date and fills missing values with 0', () => {
    const rows = buildTrendRows(makeStats());
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ready: 2, available: 4, remote: 0, best: 8, applied: 6 });
    expect(rows[0].day).toBe(formatTrendLabel('2026-09-27'));
    expect(buildTrendRows(makeStats({ trends: undefined }))).toEqual([]);
  });

  it('shapes activity rows and totals them', () => {
    const rows = buildActivityRows({
      timezone: 'UTC',
      days: 2,
      min_match_score: 60,
      series: [
        { date: '2026-10-15', label: 'Thu', posted: 10, recommended: 4, applied: 2 },
        { date: '2026-10-16', label: 'Fri', posted: 6, recommended: 3, applied: 5 },
      ],
      totals: { posted: 16, recommended: 7, applied: 7 },
    });
    expect(rows[0].day).toBe(formatTrendLabel('2026-10-15'));
    expect(sumBy(rows, 'applied')).toBe(7);
    expect(buildActivityRows(undefined)).toEqual([]);
  });

  it('formats ISO trend labels and passes through others', () => {
    expect(formatTrendLabel('Mon')).toBe('Mon');
    expect(formatTrendLabel('2026-09-27')).toMatch(/27/);
  });

  it('names sources readably', () => {
    expect(sourceLabel('manual')).toBe('Added by you');
    expect(sourceLabel('remote_ok')).toBe('Remote OK');
    expect(sourceLabel('some_board')).toBe('Some board');
  });

  it('returns top 8 sources with relative widths and share of all sources', () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({
      source: `src_${i}`,
      count: 100 - i * 10,
      latest_scraped: null,
    }));
    const rows = topSources(makeStats({ sources }));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ source: 'src_0', label: 'Src 0', count: 100, width: 100, share: 18 });
    expect(rows[1].width).toBe(90);
  });
});
