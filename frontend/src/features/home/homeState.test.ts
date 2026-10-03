import { describe, expect, it } from 'vitest';
import { completeProfile, emptyProfile } from '@/test/profileFixtures';
import { makeJob } from '@/test/jobFixtures';
import type { ScraperStats } from '@/types/scraper';
import type { UserSettings } from '@/types/settings';
import { appliedWithin, buildChecklist, nextStep } from './homeState';

const stats = (over: Partial<ScraperStats> = {}) =>
  ({ total_jobs: 0, ready_jobs: 0, applied_jobs: 0, sources: [], recent_runs: [], ...over }) as ScraperStats;
const settings = (over: Partial<UserSettings> = {}) =>
  ({ country_preferences: [], job_match_preferences: '', ...over }) as UserSettings;

describe('buildChecklist', () => {
  it('marks nothing done for a brand-new account', () => {
    const items = buildChecklist({ profile: null, settings: settings(), stats: stats() });
    expect(items.map((i) => i.done)).toEqual([false, false, false, false]);
    expect(items[0].hint).toMatch(/import your résumé/i);
  });

  it('tracks each step independently', () => {
    const items = buildChecklist({
      profile: completeProfile,
      settings: settings({ country_preferences: ['US'] }),
      stats: stats({ total_jobs: 3, applied_jobs: 1 }),
    });
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('counts missing required profile fields', () => {
    const [profile] = buildChecklist({ profile: emptyProfile, settings: settings(), stats: stats() });
    expect(profile.done).toBe(false);
    expect(profile.hint).toMatch(/\d+ required fields left/);
  });
});

describe('nextStep', () => {
  it('sends new users to onboarding first', () => {
    expect(nextStep({ profile: null, settings: undefined, stats: stats() }, true)).toEqual({ kind: 'onboarding' });
  });

  it('asks to finish the profile when required fields are missing', () => {
    expect(nextStep({ profile: emptyProfile, settings: undefined, stats: stats() }, false)?.kind).toBe('profile');
  });

  it('then adds jobs, then reviews ready jobs, then good matches', () => {
    const base = { profile: completeProfile, settings: undefined };
    expect(nextStep({ ...base, stats: stats() }, false)).toEqual({ kind: 'add-jobs' });
    expect(nextStep({ ...base, stats: stats({ total_jobs: 4, ready_jobs: 2 }) }, false)).toEqual({
      kind: 'review-ready',
      count: 2,
    });
    expect(nextStep({ ...base, stats: stats({ total_jobs: 4, best_jobs: 1, good_jobs: 2 }) }, false)).toEqual({
      kind: 'review-matches',
      count: 3,
    });
    expect(nextStep({ ...base, stats: stats({ total_jobs: 4 }) }, false)).toBeNull();
  });
});

describe('appliedWithin', () => {
  it('counts jobs applied inside the window', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const jobs = [
      makeJob({ id: 'a', applied_at: '2026-10-02T12:00:00Z' }),
      makeJob({ id: 'b', applied_at: '2026-09-20T12:00:00Z' }),
      makeJob({ id: 'c', applied_at: null }),
    ];
    expect(appliedWithin(jobs, 7, now)).toBe(1);
  });
});
