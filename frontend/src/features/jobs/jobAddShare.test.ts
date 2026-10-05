import { describe, expect, it } from 'vitest';
import type { JobAddBatch } from '@/types/jobAdd';
import {
  formatAddedAgo,
  jobAddCountLabel,
  shareScopeLabel,
  shareToastPrompt,
  shareToastTitle,
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
    expect(shareToastTitle(batch({ job_count: 3 }))).toBe('3 jobs added');
  });

  it('labels share scopes', () => {
    expect(shareScopeLabel('private')).toBe('Only you');
    expect(shareScopeLabel('team')).toBe('Team');
    expect(shareScopeLabel('all')).toBe('Everyone');
    expect(shareScopeLabel('users')).toBe('Specific people');
  });

  it('asks to share when the add is still private', () => {
    expect(shareToastPrompt(batch())).toBe('Share these jobs?');
    expect(shareToastPrompt(batch({ share_scope: 'team' }))).toBe(
      'Shared with the team. Change who can see them:',
    );
  });

  it('formats how long ago jobs were added', () => {
    const now = Date.parse('2026-10-05T16:50:00Z');
    expect(formatAddedAgo('2026-10-05T16:50:00Z', now)).toBe('just now');
    expect(formatAddedAgo('2026-10-05T16:00:00Z', now)).toBe('50 minutes ago');
    expect(formatAddedAgo('2026-10-05T15:50:00Z', now)).toBe('1 hour ago');
    expect(formatAddedAgo('2026-10-04T16:50:00Z', now)).toBe('yesterday');
  });
});
