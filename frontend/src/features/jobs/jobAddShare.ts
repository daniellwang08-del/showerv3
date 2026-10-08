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
    hint: 'Only you can see jobs you add.',
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
];

export function jobAddCountLabel(count: number): string {
  return `${count} job${count === 1 ? '' : 's'} added`;
}

export function shareScopeLabel(scope: JobShareScope | string): string {
  return JOB_SHARE_SCOPE_LABELS[scope as JobShareScope] ?? 'Only you';
}

export function addNoticeTitle(batch: JobAddBatch): string {
  return jobAddCountLabel(batch.job_count);
}

function peopleLabel(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** How a fresh add was stored, from the user's default. Informational only. */
export function addNoticeDescription(batch: JobAddBatch): string {
  const them = batch.job_count === 1 ? 'it' : 'them';
  switch (batch.share_scope) {
    case 'team':
      return `Shared with the team. Teammates can see ${them} in their jobs list.`;
    case 'all':
      return `Shared with everyone. Every approved account can see ${them}.`;
    case 'users':
      return `Shared with ${peopleLabel(batch.share_users.length)}.`;
    default:
      return `Private. Only you can see ${them}.`;
  }
}

export interface JobVisibility {
  scope: JobShareScope;
  label: string;
  hint: string;
}

/** Who besides the owner can see a jobs-table row. */
export function jobVisibility(
  visibility: string | null | undefined,
  userCount = 0,
  fromMe = false,
): JobVisibility {
  switch (visibility) {
    case 'private':
      return {
        scope: 'private',
        label: fromMe ? 'Only you' : 'Private',
        hint: fromMe ? 'Hidden from everyone else.' : 'Only the person who added it can see it.',
      };
    case 'team':
      return { scope: 'team', label: 'Team', hint: 'Visible to every applicant on this workspace.' };
    case 'users':
      return {
        scope: 'users',
        label: userCount ? peopleLabel(userCount) : 'Specific people',
        hint: fromMe
          ? `You shared it with ${userCount ? peopleLabel(userCount) : 'specific people'}.`
          : 'Shared with specific people, including you.',
      };
    default:
      return { scope: 'all', label: 'Everyone', hint: 'Visible to every approved account.' };
  }
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
