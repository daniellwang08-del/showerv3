import { describe, expect, it } from 'vitest';
import type { WeeklyProgress } from '@/api/scraperApi';
import {
  accessLabel,
  activityWindow,
  applicationCounts,
  filterApplications,
  initials,
  parseEmails,
  sharedBase,
  sharedReportPath,
  viewLabel,
} from './shareModel';
import { makeApp } from './sharingFixtures';

const NOW = Date.parse('2026-10-16T12:00:00Z');

describe('shareModel', () => {
  it('parses pasted email lists', () => {
    expect(parseEmails('Sam <sam@x.com>, lee@y.org; SAM@x.com  bad@ nope')).toEqual({
      valid: ['sam@x.com', 'lee@y.org'],
      invalid: ['bad@'],
    });
  });

  it('links to a shared report inside the app', () => {
    expect(sharedReportPath('abc-123')).toBe('/app/shared/abc-123');
    expect(sharedBase('/admin/shared/abc')).toBe('/admin/shared');
    expect(sharedBase('/app/shared')).toBe('/app/shared');
    expect(sharedReportPath('abc-123', sharedBase('/admin/shared'))).toBe('/admin/shared/abc-123');
  });

  it('labels access and views', () => {
    expect(accessLabel({ active: false, expires_at: '2026-10-01T00:00:00Z' })).toBe('Expired');
    expect(accessLabel({ active: true, expires_at: null })).toBe('No end date');
    expect(accessLabel({ active: true, expires_at: '2026-11-15T12:00:00Z' })).toMatch(/^Until /);
    expect(viewLabel({ last_viewed_at: null, view_count: 0 }, NOW)).toBe('Not viewed yet');
    expect(viewLabel({ last_viewed_at: '2026-10-16T10:00:00Z', view_count: 3 }, NOW)).toBe('Viewed 2 hours ago');
    expect(initials('sam.lee@x.com')).toBe('SL');
    expect(initials('Raoyinc')).toBe('R');
  });

  it('cuts the activity series to a window with fresh totals', () => {
    const progress: WeeklyProgress = {
      timezone: 'UTC',
      days: 30,
      min_match_score: 70,
      series: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, label: '', posted: 1, recommended: 0, applied: i >= 23 ? 2 : 0 })),
      totals: { posted: 30, recommended: 0, applied: 14 },
    };
    const week = activityWindow(progress, 7);
    expect(week.series).toHaveLength(7);
    expect(week.totals).toEqual({ posted: 7, recommended: 0, applied: 14 });
  });

  it('counts and filters applications by status', () => {
    const items = [
      makeApp({ id: 'a', company: 'Acme', process_id: 'p1', process_active: true, stage: 'interviewing', applied_at: '2026-10-15T00:00:00Z' }),
      makeApp({ id: 'b', company: 'Globex', process_id: 'p2', stage: 'rejected', applied_at: '2026-09-01T00:00:00Z' }),
      makeApp({ id: 'c', company: 'Initech', title: 'Data Engineer', applied_at: '2026-10-14T00:00:00Z' }),
    ];
    expect(applicationCounts(items, NOW)).toEqual({ all: 3, active: 1, waiting: 1, closed: 1, week: 2 });
    expect(filterApplications(items, 'closed', '').map((a) => a.id)).toEqual(['b']);
    expect(filterApplications(items, 'all', 'data').map((a) => a.id)).toEqual(['c']);
  });
});
