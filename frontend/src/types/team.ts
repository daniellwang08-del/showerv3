import type { JobShareDefault } from './settings';
import type { SharedReportResponse } from './reportShare';

export interface TeamPerson {
  id: string;
  name: string;
  email: string;
}

export interface TeamSpaceSummary {
  id: string;
  /** "nao-" plus 8 digits. */
  public_id: string;
  name: string;
  lead: TeamPerson | null;
  member_count: number;
  pending_invites: number;
  default_share_scope: JobShareDefault | null;
  default_share_locked: boolean;
  created_at: string | null;
}

export interface TeamMembership extends TeamSpaceSummary {
  joined_at: string | null;
  share_locked: boolean;
}

export interface TeamInvite {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  created_at: string | null;
  space: TeamSpaceSummary | null;
  has_account?: boolean;
  in_other_team?: boolean;
}

export interface TeamOverview {
  owned: TeamSpaceSummary[];
  membership: TeamMembership | null;
  invites: TeamInvite[];
  team_packages_held: number;
}

export interface MemberStats {
  jobs_added: number;
  applied: number;
  active_interviews: number;
  upcoming_interviews: number;
  last_active_at: string | null;
}

export interface TeamMemberRow extends TeamPerson {
  headline: string | null;
  joined_at: string | null;
  share_default: JobShareDefault;
  share_locked: boolean;
  stats: MemberStats;
}

export interface TeamSpaceDetail {
  space: TeamSpaceSummary;
  members: TeamMemberRow[];
  invites: TeamInvite[];
  stats_days: number;
}

export interface TeamActivityItem {
  id: string;
  kind: 'jobs_added' | 'applied' | 'interview';
  at: string | null;
  user_id: string;
  title: string;
  detail: string | null;
  share_scope?: string;
  status?: string;
  scheduled_at?: string | null;
  member: TeamPerson | null;
}

export interface TeamActivity {
  items: TeamActivityItem[];
  days: number;
}

export interface TeamInsightsMember extends TeamPerson {
  headline: string | null;
  joined_at: string | null;
  stats: MemberStats & { interview_updates: number };
  /** One value per entry in `TeamInsights.dates`. */
  series: { added: number[]; applied: number[]; interviews: number[] };
}

export interface TeamInsights {
  space: { id: string; public_id: string; name: string };
  days: number;
  /** Local calendar days, oldest first (YYYY-MM-DD). */
  dates: string[];
  members: TeamInsightsMember[];
  totals: {
    members: number;
    active_members: number;
    jobs_added: number;
    applied: number;
    interview_updates: number;
    active_interviews: number;
    upcoming_interviews: number;
  };
}

export interface InviteResult {
  invites: TeamInvite[];
  skipped: { email: string; reason: string }[];
}

export type TeamMemberReport = SharedReportResponse & {
  team: { id: string; public_id: string; name: string };
};
