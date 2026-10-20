import { apiClient } from './client';
import type { JobShareDefault } from '../types/settings';
import type {
  InviteResult,
  TeamActivity,
  TeamMemberReport,
  TeamOverview,
  TeamSpaceDetail,
  TeamSpaceSummary,
} from '../types/team';

const space = (id: string) => `/teams/${encodeURIComponent(id)}`;
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function fetchTeamOverview(): Promise<TeamOverview> {
  const { data } = await apiClient.get<TeamOverview>('/teams');
  return data;
}

export async function createTeamSpace(packageId: string, name: string): Promise<TeamSpaceSummary> {
  const { data } = await apiClient.post<TeamSpaceSummary>('/teams', { package_id: packageId, name });
  return data;
}

export async function fetchTeamSpace(id: string): Promise<TeamSpaceDetail> {
  const { data } = await apiClient.get<TeamSpaceDetail>(space(id));
  return data;
}

export async function updateTeamSpace(
  id: string,
  changes: { name?: string; default_share_scope?: JobShareDefault | ''; default_share_locked?: boolean },
): Promise<TeamSpaceSummary> {
  const { data } = await apiClient.patch<TeamSpaceSummary>(space(id), changes);
  return data;
}

export async function deleteTeamSpace(id: string): Promise<void> {
  await apiClient.delete(space(id));
}

export async function fetchTeamActivity(id: string): Promise<TeamActivity> {
  const { data } = await apiClient.get<TeamActivity>(`${space(id)}/activity`);
  return data;
}

export async function inviteToTeam(id: string, emails: string[]): Promise<InviteResult> {
  const { data } = await apiClient.post<InviteResult>(`${space(id)}/invites`, { emails });
  return data;
}

export async function revokeTeamInvite(id: string, inviteId: string): Promise<void> {
  await apiClient.delete(`${space(id)}/invites/${encodeURIComponent(inviteId)}`);
}

export async function updateTeamMember(
  id: string,
  userId: string,
  changes: { share_default?: JobShareDefault; share_locked?: boolean },
): Promise<{ user_id: string; share_default: JobShareDefault; share_locked: boolean }> {
  const { data } = await apiClient.patch<{ user_id: string; share_default: JobShareDefault; share_locked: boolean }>(
    `${space(id)}/members/${encodeURIComponent(userId)}`,
    changes,
  );
  return data;
}

export async function removeTeamMember(id: string, userId: string): Promise<void> {
  await apiClient.delete(`${space(id)}/members/${encodeURIComponent(userId)}`);
}

export async function fetchTeamMemberReport(id: string, userId: string): Promise<TeamMemberReport> {
  const { data } = await apiClient.get<TeamMemberReport>(`${space(id)}/members/${encodeURIComponent(userId)}/report`, {
    params: { timezone: timezone() },
  });
  return data;
}

export async function respondToTeamInvite(inviteId: string, accept: boolean): Promise<{ status: string }> {
  const { data } = await apiClient.post<{ status: string }>(`/teams/invites/${encodeURIComponent(inviteId)}/respond`, {
    accept,
  });
  return data;
}

export async function leaveTeam(): Promise<void> {
  await apiClient.post('/teams/leave');
}
