import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTeamActivity,
  fetchTeamOverview,
  fetchTeamSpace,
  inviteToTeam,
  leaveTeam,
  respondToTeamInvite,
  updateTeamMember,
} from '@/api/teamApi';
import type { TeamOverview, TeamSpaceDetail, TeamSpaceSummary } from '@/types/team';
import { TeamPage } from './TeamPage';
import { parseEmails } from './teamModel';

vi.mock('@/api/teamApi', () => ({
  fetchTeamOverview: vi.fn(),
  fetchTeamSpace: vi.fn(),
  fetchTeamActivity: vi.fn(),
  inviteToTeam: vi.fn(),
  revokeTeamInvite: vi.fn(),
  updateTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  updateTeamSpace: vi.fn(),
  deleteTeamSpace: vi.fn(),
  respondToTeamInvite: vi.fn(),
  leaveTeam: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const lead = { id: 'lead', name: 'Lena Lead', email: 'lena@x.io' };
const space: TeamSpaceSummary = {
  id: 's1',
  public_id: 'nao-48203917',
  name: 'Backend squad',
  lead,
  member_count: 1,
  pending_invites: 1,
  default_share_scope: null,
  default_share_locked: false,
  created_at: '2026-10-01T00:00:00Z',
};

const overview = (over: Partial<TeamOverview> = {}): TeamOverview => ({
  owned: [],
  membership: null,
  invites: [],
  team_packages_held: 0,
  ...over,
});

const detail: TeamSpaceDetail = {
  space,
  stats_days: 30,
  members: [
    {
      id: 'm1',
      name: 'Max Member',
      email: 'max@x.io',
      headline: 'Backend engineer',
      joined_at: '2026-10-02T00:00:00Z',
      share_default: 'private',
      share_locked: false,
      stats: { jobs_added: 12, applied: 7, active_interviews: 2, upcoming_interviews: 1, last_active_at: null },
    },
  ],
  invites: [{ id: 'i1', email: 'new@x.io', status: 'pending', created_at: null, space: null, has_account: false }],
};

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TeamPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(fetchTeamSpace).mockResolvedValue(detail);
  vi.mocked(fetchTeamActivity).mockResolvedValue({ days: 14, items: [] });
});

describe('TeamPage', () => {
  it('explains team spaces when the user has none', async () => {
    vi.mocked(fetchTeamOverview).mockResolvedValue(overview());
    renderPage();
    expect(await screen.findByText('You are not on a team')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the TEAM plan' })).toHaveAttribute('href', '/app/plans');
  });

  it('points to unused TEAM packages', async () => {
    vi.mocked(fetchTeamOverview).mockResolvedValue(overview({ team_packages_held: 2 }));
    renderPage();
    expect(await screen.findByText('You have 2 unused TEAM packages')).toBeInTheDocument();
  });

  it('shows the lead the team ID, member stats, and pending invites', async () => {
    vi.mocked(fetchTeamOverview).mockResolvedValue(overview({ owned: [space] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /Team ID nao-48203917/ })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Team members' });
    const row = within(list).getByText('Max Member').closest('li')!;
    expect(within(row).getByText('12')).toBeInTheDocument();
    expect(within(row).getByText('1 upcoming')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: "Open Max Member's report" })).toHaveAttribute(
      'href',
      '/app/team/s1/members/m1',
    );
    expect(screen.getByText('new@x.io')).toBeInTheDocument();
  });

  it('locks a member sharing default', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchTeamOverview).mockResolvedValue(overview({ owned: [space] }));
    vi.mocked(updateTeamMember).mockResolvedValue({ user_id: 'm1', share_default: 'private', share_locked: true });
    renderPage();
    await user.click(await screen.findByRole('switch', { name: /Lock sharing for Max Member/ }));
    await waitFor(() => expect(updateTeamMember).toHaveBeenCalledWith('s1', 'm1', { share_locked: true }));
  });

  it('invites a pasted list of emails', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchTeamOverview).mockResolvedValue(overview({ owned: [space] }));
    vi.mocked(inviteToTeam).mockResolvedValue({ invites: [], skipped: [] });
    renderPage();
    await user.type(await screen.findByLabelText('Emails to invite'), 'a@x.io, B@x.io a@x.io');
    await user.click(screen.getByRole('button', { name: 'Invite 2' }));
    await waitFor(() => expect(inviteToTeam).toHaveBeenCalledWith('s1', ['a@x.io', 'b@x.io']));
  });

  it('lets an invitee accept', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchTeamOverview).mockResolvedValue(
      overview({ invites: [{ id: 'i9', email: 'me@x.io', status: 'pending', created_at: null, space }] }),
    );
    vi.mocked(respondToTeamInvite).mockResolvedValue({ status: 'accepted' });
    renderPage();
    expect(await screen.findByText(/Led by Lena Lead/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Accept/ }));
    await waitFor(() => expect(respondToTeamInvite).toHaveBeenCalledWith('i9', true));
  });

  it('blocks accepting while already on a team', async () => {
    vi.mocked(fetchTeamOverview).mockResolvedValue(
      overview({
        membership: { ...space, id: 's0', name: 'Current team', joined_at: null, share_locked: true },
        invites: [{ id: 'i9', email: 'me@x.io', status: 'pending', created_at: null, space }],
      }),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: /Accept/ })).toBeDisabled();
    expect(screen.getByText(/Your lead set how the jobs you add are shared/)).toBeInTheDocument();
  });

  it('lets a member leave after confirming', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchTeamOverview).mockResolvedValue(
      overview({ membership: { ...space, joined_at: null, share_locked: false } }),
    );
    vi.mocked(leaveTeam).mockResolvedValue();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Leave team/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Leave team' }));
    await waitFor(() => expect(leaveTeam).toHaveBeenCalled());
  });
});

describe('parseEmails', () => {
  it('splits, trims, lowercases, and dedupes', () => {
    expect(parseEmails(' A@x.io,b@x.io;\n<c@x.io>  a@x.io ')).toEqual(['a@x.io', 'b@x.io', 'c@x.io']);
  });
});
