import { describe, expect, it } from 'vitest';
import { makeStats } from './insightsFixtures';
import {
  buildFunnel,
  buildOverviewTiles,
  buildTodayTiles,
  buildTrendRows,
  formatTrendLabel,
  isEmptyPool,
  pct,
  safe,
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
    expect(
      isEmptyPool(makeStats({ total_jobs: 0, today_scraped: 0, applied_jobs: 0, my_jobs: 0 })),
    ).toBe(true);
    expect(isEmptyPool(makeStats({ total_jobs: 0, today_scraped: 0, applied_jobs: 0, my_jobs: 1 }))).toBe(false);
  });

  it('builds today tiles with legacy filter mapping', () => {
    const tiles = buildTodayTiles(makeStats());
    expect(tiles.map((t) => [t.label, t.value, t.filters])).toEqual([
      ["Today's new", 12, { view: 'today' }],
      ['Remote among them', 5, { view: 'today', remote_only: true }],
      ['Ready among them', 3, { view: 'ready' }],
      ['Applied today', 2, { view: 'applied_today' }],
    ]);
  });

  it('builds overview tiles and only shows Sheets/Pumble when > 0', () => {
    const tiles = buildOverviewTiles(makeStats());
    expect(tiles.map((t) => t.key)).toEqual(['total', 'applied', 'good', 'strong', 'avg', 'remote', 'mine']);
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.good.value).toBe(70);
    expect(byKey.good.filters).toEqual({ view: 'suggested', min_match_score: 0 });
    expect(byKey.strong.filters).toEqual({ view: 'suggested', min_match_score: 75 });
    expect(byKey.avg.filters).toEqual({ view: 'suggested' });
    expect(byKey.remote.value).toBe(60);
    expect(byKey.remote.filters).toEqual({ view: 'all', remote_only: true });
    expect(byKey.mine.filters).toEqual({ view: 'mine' });
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

  it('computes funnel widths relative to the largest step and share of pool', () => {
    const steps = buildFunnel(makeStats());
    expect(steps.map((s) => [s.key, s.value, s.width, s.ofPool, s.filters.view])).toEqual([
      ['pool', 200, 100, 100, 'all'],
      ['in_progress', 90, 45, 45, 'available'],
      ['ready', 40, 20, 20, 'ready'],
      ['applied', 30, 15, 15, 'applied'],
    ]);
  });

  it('keeps a minimum visible bar for small non-zero steps', () => {
    const steps = buildFunnel(makeStats({ total_jobs: 1000, applied_jobs: 1, ready_jobs: 0 }));
    expect(steps[3].width).toBe(4);
    expect(steps[2].width).toBe(0);
  });

  it('shapes trend rows and fills missing values with 0', () => {
    const rows = buildTrendRows(makeStats());
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ready: 2, available: 4, remote: 0, best: 8 });
    expect(rows[0].day).toBe(formatTrendLabel('2026-09-27'));
    expect(buildTrendRows(makeStats({ trends: undefined }))).toEqual([]);
  });

  it('formats ISO trend labels and passes through others', () => {
    expect(formatTrendLabel('Mon')).toBe('Mon');
    expect(formatTrendLabel('2026-09-27')).toMatch(/27/);
  });

  it('returns top 8 sources with relative widths', () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({
      source: `src_${i}`,
      count: 100 - i * 10,
      latest_scraped: null,
    }));
    const rows = topSources(makeStats({ sources }));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ source: 'src_0', label: 'src 0', count: 100, width: 100 });
    expect(rows[1].width).toBe(90);
  });
});
