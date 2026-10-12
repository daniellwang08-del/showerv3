import { describe, expect, it } from 'vitest';
import type { JobSiteSyncActivity } from '@/api/jobSitesApi';
import { newJobsBadgeText } from '@/features/jobs/useNewJobsBadge';
import { summarizeSyncActivity } from './syncActivity';

const act = (over: Partial<JobSiteSyncActivity>): JobSiteSyncActivity => ({
  plugin_slug: 'rrs',
  plugin_name: 'RemoteRocketship',
  phase: 'fetching',
  total: 0,
  done: 0,
  started_at: null,
  ...over,
});

describe('summarizeSyncActivity', () => {
  it('is null when nothing runs', () => {
    expect(summarizeSyncActivity([])).toBeNull();
    expect(summarizeSyncActivity(undefined)).toBeNull();
  });

  it('is indeterminate while queued or fetching', () => {
    expect(summarizeSyncActivity([act({ phase: 'queued' })])).toEqual({
      label: 'Starting sync with RemoteRocketship',
      detail: '',
      percent: null,
    });
    expect(summarizeSyncActivity([act({ phase: 'queued' }), act({ plugin_name: 'Jobicy' })])?.label).toBe(
      'Fetching new jobs from RemoteRocketship and Jobicy',
    );
  });

  it('sums scoring progress across sites and notes sites still fetching', () => {
    const summary = summarizeSyncActivity([
      act({ phase: 'analyzing', total: 10, done: 4 }),
      act({ plugin_name: 'Jobicy', phase: 'analyzing', total: 6, done: 4 }),
      act({ plugin_name: 'Reed', phase: 'fetching' }),
    ]);
    expect(summary).toEqual({
      label: 'Scoring new jobs from RemoteRocketship and Jobicy, fetching more',
      detail: '8 of 16',
      percent: 50,
    });
  });

  it('shortens long site lists', () => {
    const names = ['A', 'B', 'C', 'D'].map((n) => act({ plugin_name: n }));
    expect(summarizeSyncActivity(names)?.label).toBe('Fetching new jobs from A, B and 2 more');
  });
});

describe('newJobsBadgeText', () => {
  it('caps at 99+', () => {
    expect(newJobsBadgeText(7)).toBe('7');
    expect(newJobsBadgeText(99)).toBe('99');
    expect(newJobsBadgeText(140)).toBe('99+');
  });
});
