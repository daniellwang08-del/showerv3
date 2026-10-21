import { useQueries } from '@tanstack/react-query';
import { fetchTeamSpace } from '@/api/teamApi';
import { teamSpaceKey } from '@/features/team/teamModel';
import { useTeamOverview } from '@/features/team/useTeamOverview';
import type { TeamMemberRow, TeamSpaceSummary } from '@/types/team';

/** Whose numbers the Insights page shows. Kept in `?view=` so a view can be linked. */
export type InsightsSubject =
  | { kind: 'me' }
  | { kind: 'teams' }
  | { kind: 'team'; spaceId: string }
  | { kind: 'member'; memberId: string };

export const SUBJECT_PARAM = 'view';
export const ME: InsightsSubject = { kind: 'me' };
export const ALL_TEAMS: InsightsSubject = { kind: 'teams' };

export function parseSubject(raw: string | null): InsightsSubject {
  const [kind, id] = (raw ?? '').split(':', 2);
  if (kind === 'teams') return ALL_TEAMS;
  if (kind === 'team' && id) return { kind: 'team', spaceId: id };
  if (kind === 'member' && id) return { kind: 'member', memberId: id };
  return ME;
}

export function subjectValue(subject: InsightsSubject): string {
  if (subject.kind === 'teams') return 'teams';
  if (subject.kind === 'team') return `team:${subject.spaceId}`;
  if (subject.kind === 'member') return `member:${subject.memberId}`;
  return 'me';
}

/** Where a lead lands without a ``?view=``: their teams, not their own search. */
export function defaultSubject(spaces: RosterSpace[]): InsightsSubject {
  if (spaces.length > 1) return ALL_TEAMS;
  if (spaces.length === 1) return { kind: 'team', spaceId: spaces[0].space.id };
  return ME;
}

export function memberInsightsPath(memberId: string): string {
  return `/app/analysis?${SUBJECT_PARAM}=${encodeURIComponent(`member:${memberId}`)}`;
}

export type RosterSpace = { space: TeamSpaceSummary; members: TeamMemberRow[]; loading: boolean };
export type RosterMember = { member: TeamMemberRow; space: TeamSpaceSummary };

/** Every space the user leads with its members, for the Insights picker. */
export function useLeadRoster() {
  const overview = useTeamOverview();
  const owned = overview.data?.owned ?? [];
  const details = useQueries({
    queries: owned.map((space) => ({
      queryKey: teamSpaceKey(space.id),
      queryFn: () => fetchTeamSpace(space.id),
      staleTime: 60_000,
    })),
  });
  const spaces: RosterSpace[] = owned.map((space, i) => ({
    space,
    members: details[i]?.data?.members ?? [],
    loading: details[i]?.isPending ?? true,
  }));
  return {
    isLead: owned.length > 0,
    spaces,
    overviewLoading: overview.isPending,
    loading: overview.isPending || details.some((d) => d.isPending),
  };
}

export function findMember(spaces: RosterSpace[], memberId: string): RosterMember | null {
  for (const { space, members } of spaces) {
    const member = members.find((m) => m.id === memberId);
    if (member) return { member, space };
  }
  return null;
}

/**
 * The subject the page can actually show: a team or member the user leads, or
 * themselves while the roster loads or when the link points somewhere they
 * cannot see.
 */
export function resolveSubject(
  subject: InsightsSubject,
  roster: { spaces: RosterSpace[]; loading: boolean },
): { subject: InsightsSubject; member: RosterMember | null; space: TeamSpaceSummary | null; pending: boolean } {
  if (subject.kind === 'teams') {
    if (roster.spaces.length) return { subject, member: null, space: null, pending: false };
  } else if (subject.kind === 'team') {
    const space = roster.spaces.find((s) => s.space.id === subject.spaceId)?.space ?? null;
    if (space) return { subject, member: null, space, pending: false };
  } else if (subject.kind === 'member') {
    const member = findMember(roster.spaces, subject.memberId);
    if (member) return { subject, member, space: member.space, pending: false };
  } else {
    return { subject: ME, member: null, space: null, pending: false };
  }
  return { subject: ME, member: null, space: null, pending: roster.loading };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
