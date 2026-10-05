import type { JobAddBatch } from '@/types/jobAdd';
import type { JobShareDefault, JobShareScope } from '@/types/settings';

export const JOB_SHARE_SCOPE_LABELS: Record<JobShareScope, string> = {
  private: 'Only you',
  team: 'Team',
  all: 'Everyone',
  users: 'Specific people',
};

export const JOB_SHARE_DEFAULT_OPTIONS: {
  value: JobShareDefault;
  label: string;
  hint: string;
}[] = [
  {
    value: 'private',
    label: 'Keep them private',
    hint: 'Only you can see jobs you add until you share them.',
  },
  {
    value: 'team',
    label: 'Share with the team',
    hint: 'Other applicants on this workspace can see them right away.',
  },
  {
    value: 'all',
    label: 'Share with everyone',
    hint: 'Every approved account, including admins, can see them.',
  },
  {
    value: 'ask',
    label: 'Ask me each time',
    hint: 'Start private, then choose from the 5-second notice after each add.',
  },
];

export function jobAddCountLabel(count: number): string {
  return `${count} job${count === 1 ? '' : 's'} added`;
}

export function shareScopeLabel(scope: JobShareScope | string): string {
  return JOB_SHARE_SCOPE_LABELS[scope as JobShareScope] ?? 'Only you';
}

export function shareToastTitle(batch: JobAddBatch): string {
  return jobAddCountLabel(batch.job_count);
}

export function shareToastPrompt(batch: JobAddBatch): string {
  if (batch.share_scope === 'team') return 'Shared with the team. Change who can see them:';
  if (batch.share_scope === 'all') return 'Shared with everyone. Change who can see them:';
  if (batch.share_scope === 'users') {
    const n = batch.share_users.length;
    return n
      ? `Shared with ${n} ${n === 1 ? 'person' : 'people'}. Change who can see them:`
      : 'Share these jobs?';
  }
  return 'Share these jobs?';
}

export function formatAddedAgo(dateStr: string | null | undefined, now = Date.now()): string {
  if (!dateStr) return '';
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs === 1) return '1 hour ago';
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}
