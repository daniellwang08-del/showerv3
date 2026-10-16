import { describe, expect, it } from 'vitest';
import type { MailApplicationsOverview } from '@/types/interviews';
import { buildApplicationRows, busiestDay } from './inboxApplications';

function overview(counts: number[]): MailApplicationsOverview {
  return {
    series: counts.map((count, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, label: String(i + 1), count })),
  } as MailApplicationsOverview;
}

describe('inboxApplications', () => {
  it('adds a trailing 7-day average to the daily counts', () => {
    const rows = buildApplicationRows(overview([7, 0, 0, 0, 0, 0, 0, 14]));
    expect(rows.map((r) => r.applications)).toEqual([7, 0, 0, 0, 0, 0, 0, 14]);
    expect(rows[0].average).toBe(7);
    expect(rows[1].average).toBe(3.5);
    expect(rows[6].average).toBe(1);
    expect(rows[7].average).toBe(2);
    expect(rows[7]).toMatchObject({ day: '8', date: '2026-10-08' });
  });

  it('finds the busiest day and handles empty data', () => {
    expect(busiestDay(buildApplicationRows(overview([1, 4, 4, 2])))?.date).toBe('2026-10-02');
    expect(busiestDay(buildApplicationRows(overview([0, 0])))).toBeNull();
    expect(buildApplicationRows(undefined)).toEqual([]);
  });
});
