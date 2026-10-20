import type { JobShareDefault } from '@/types/settings';
import type { TeamActivityItem, TeamMemberRow } from '@/types/team';

export const TEAM_KEY = ['teams'] as const;
export const teamSpaceKey = (id: string) => [...TEAM_KEY, 'space', id] as const;
export const teamActivityKey = (id: string) => [...TEAM_KEY, 'activity', id] as const;

export const SHARE_OPTIONS: { value: JobShareDefault; label: string; description: string }[] = [
  { value: 'private', label: 'Only them', description: 'Jobs they add stay private' },
  { value: 'team', label: 'Team space', description: 'You and their teammates see them' },
  { value: 'all', label: 'Everyone', description: 'Every approved account sees them' },
];

export const POLICY_NONE = 'member';

export function shareLabel(value: JobShareDefault | null | undefined): string {
  return SHARE_OPTIONS.find((o) => o.value === value)?.label ?? 'Their choice';
}

/** Split a pasted list (commas, spaces, semicolons, new lines) into unique addresses. */
export function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().replace(/^<|>$/g, '').toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

export function teamTotals(members: TeamMemberRow[]) {
  return members.reduce(
    (acc, m) => ({
      jobsAdded: acc.jobsAdded + m.stats.jobs_added,
      applied: acc.applied + m.stats.applied,
      activeInterviews: acc.activeInterviews + m.stats.active_interviews,
      upcoming: acc.upcoming + m.stats.upcoming_interviews,
    }),
    { jobsAdded: 0, applied: 0, activeInterviews: 0, upcoming: 0 },
  );
}

export function activityTone(item: TeamActivityItem): string {
  if (item.kind === 'applied') return 'bg-status-ready/15 text-status-ready';
  if (item.kind === 'interview') return 'bg-chart-2/15 text-chart-2';
  return 'bg-brand/10 text-brand';
}
