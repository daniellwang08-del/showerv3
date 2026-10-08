import { describe, expect, it } from 'vitest';
import type { JobAddBatch } from '@/types/jobAdd';
import {
  addNoticeDescription,
  addNoticeTitle,
  formatAddedAgo,
  JOB_SHARE_DEFAULT_OPTIONS,
  jobAddCountLabel,
  jobVisibility,
  shareScopeLabel,
} from './jobAddShare';

const batch = (overrides: Partial<JobAddBatch> = {}): JobAddBatch => ({
  id: 'b1',
  source: 'paste',
  job_count: 3,
  share_scope: 'private',
  created_at: '2026-10-05T16:00:00Z',
  updated_at: '2026-10-05T16:00:00Z',
  share_users: [],
  ...overrides,
});

describe('job add share copy', () => {
  it('names the add session', () => {
    expect(jobAddCountLabel(1)).toBe('1 job added');
    expect(jobAddCountLabel(3)).toBe('3 jobs added');
    expect(addNoticeTitle(batch({ job_count: 3 }))).toBe('3 jobs added');
  });

  it('labels share scopes', () => {
    expect(shareScopeLabel('private')).toBe('Only you');
    expect(shareScopeLabel('team')).toBe('Team');
    expect(shareScopeLabel('all')).toBe('Everyone');
    expect(shareScopeLabel('users')).toBe('Specific people');
  });

  it('no longer offers "ask me each time" as a default', () => {
    expect(JOB_SHARE_DEFAULT_OPTIONS.map((o) => o.value)).toEqual(['private', 'team', 'all']);
  });

  it('tells the user how a fresh add was stored', () => {
    expect(addNoticeDescription(batch())).toBe('Private. Only you can see them.');
    expect(addNoticeDescription(batch({ job_count: 1 }))).toBe('Private. Only you can see it.');
    expect(addNoticeDescription(batch({ share_scope: 'team' }))).toBe(
      'Shared with the team. Teammates can see them in their jobs list.',
    );
    expect(addNoticeDescription(batch({ share_scope: 'all', job_count: 1 }))).toBe(
      'Shared with everyone. Every approved account can see it.',
    );
    expect(
      addNoticeDescription(
        batch({
          share_scope: 'users',
          share_users: [
            { id: 'u2', name: 'A', email: 'a@x.io' },
            { id: 'u3', name: 'B', email: 'b@x.io' },
          ],
        }),
      ),
    ).toBe('Shared with 2 people.');
  });

  it('describes who can see a jobs-table row', () => {
    expect(jobVisibility('private', 0, true)).toMatchObject({ scope: 'private', label: 'Only you' });
    expect(jobVisibility('private', 0, false)).toMatchObject({ scope: 'private', label: 'Private' });
    expect(jobVisibility('team')).toMatchObject({ scope: 'team', label: 'Team' });
    expect(jobVisibility('users', 1, true)).toMatchObject({ scope: 'users', label: '1 person' });
    expect(jobVisibility('users', 3, true).hint).toBe('You shared it with 3 people.');
    expect(jobVisibility('users', 0)).toMatchObject({ scope: 'users', label: 'Specific people' });
    expect(jobVisibility('all')).toMatchObject({ scope: 'all', label: 'Everyone' });
    expect(jobVisibility(undefined)).toMatchObject({ scope: 'all', label: 'Everyone' });
  });

  it('formats how long ago jobs were added', () => {
    const now = Date.parse('2026-10-05T16:50:00Z');
    expect(formatAddedAgo('2026-10-05T16:50:00Z', now)).toBe('just now');
    expect(formatAddedAgo('2026-10-05T16:00:00Z', now)).toBe('50 minutes ago');
    expect(formatAddedAgo('2026-10-05T15:50:00Z', now)).toBe('1 hour ago');
    expect(formatAddedAgo('2026-10-04T16:50:00Z', now)).toBe('yesterday');
  });
});
