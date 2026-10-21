import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fetchMailApplications, syncInterviews } from '@/api/interviewsApi';
import { fetchScraperStats, fetchWeeklyProgress } from '@/api/scraperApi';
import { fetchTeamInsights, fetchTeamOverview, fetchTeamSpace } from '@/api/teamApi';
import type { MailApplicationsOverview } from '@/types/interviews';
import type { TeamInsights, TeamMemberRow, TeamSpaceSummary } from '@/types/team';
import { useScraperStore } from '@/stores/scraperStore';
import { useShellStore } from '@/stores/shellStore';
import { emptyStats, makeStats } from './insightsFixtures';
import { InsightsPage } from './InsightsPage';

vi.mock('@/api/scraperApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/scraperApi')>()),
  fetchScraperStats: vi.fn(),
  fetchWeeklyProgress: vi.fn(),
}));

vi.mock('./InsightsCharts', () => {
  const chart =
    (name: string) =>
    ({ data, series }: { data: unknown[]; series: { label: string }[] }) => (
      <div data-testid={name} data-points={data.length}>
        {series.map((s) => s.label).join(' / ')}
      </div>
    );
  return {
    ActivityChart: chart('activity-chart'),
    TrendChart: chart('trend-chart'),
    ApplicationsChart: chart('applications-chart'),
    TeamChart: chart('team-chart'),
    MatchDonut: ({ avg }: { avg: number }) => <div data-testid="match-donut">{avg}</div>,
  };
});

vi.mock('@/api/interviewsApi', () => ({
  fetchMailApplications: vi.fn(),
  syncInterviews: vi.fn(async () => ({ started: true })),
}));

vi.mock('@/api/teamApi', () => ({
  fetchTeamOverview: vi.fn(),
  fetchTeamSpace: vi.fn(),
  fetchTeamInsights: vi.fn(),
  fetchTeamActivity: vi.fn(async () => ({ items: [], days: 14 })),
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn() }) }));

const fetchStats = vi.mocked(fetchScraperStats);
const fetchProgress = vi.mocked(fetchWeeklyProgress);
const fetchInbox = vi.mocked(fetchMailApplications);
const startSync = vi.mocked(syncInterviews);
const fetchOverview = vi.mocked(fetchTeamOverview);
const fetchSpace = vi.mocked(fetchTeamSpace);
const fetchInsights = vi.mocked(fetchTeamInsights);

const SPACE: TeamSpaceSummary = {
  id: 's1',
  public_id: 'nao-12345678',
  name: 'Growth squad',
  lead: { id: 'lead', name: 'Lee Lead', email: 'lead@example.com' },
  member_count: 2,
  pending_invites: 0,
  default_share_scope: null,
  default_share_locked: false,
  created_at: '2026-10-01T00:00:00Z',
};

const memberStats = (applied: number, added: number) => ({
  jobs_added: added,
  applied,
  active_interviews: 1,
  upcoming_interviews: 0,
  last_active_at: '2026-10-19T12:00:00Z',
});

const MEMBERS: TeamMemberRow[] = [
  {
    id: 'u2',
    name: 'Pat Lee',
    email: 'pat@example.com',
    headline: 'Data Engineer',
    joined_at: '2026-10-02T00:00:00Z',
    share_default: 'team',
    share_locked: false,
    stats: memberStats(6, 20),
  },
  {
    id: 'u3',
    name: 'Sam Roe',
    email: 'sam@example.com',
    headline: null,
    joined_at: '2026-10-03T00:00:00Z',
    share_default: 'private',
    share_locked: false,
    stats: memberStats(2, 5),
  },
];

function leadOf(members: TeamMemberRow[] = MEMBERS) {
  fetchOverview.mockResolvedValue({ owned: [SPACE], memberships: [], invites: [], team_packages_held: 0 });
  fetchSpace.mockResolvedValue({ space: SPACE, members, invites: [], stats_days: 30 });
}

function teamInsights(): TeamInsights {
  const dates = ['2026-10-18', '2026-10-19', '2026-10-20'];
  return {
    space: { id: 's1', public_id: SPACE.public_id, name: SPACE.name },
    days: 30,
    dates,
    members: MEMBERS.map((m, i) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      headline: m.headline,
      joined_at: m.joined_at,
      stats: { ...m.stats, interview_updates: i + 1 },
      series: { added: [1, 2, 3], applied: i === 0 ? [1, 2, 3] : [0, 1, 1], interviews: [0, 0, i + 1] },
    })),
    totals: {
      members: 2,
      active_members: 2,
      jobs_added: 25,
      applied: 8,
      interview_updates: 3,
      active_interviews: 2,
      upcoming_interviews: 0,
    },
  };
}

function inbox(overrides: Partial<MailApplicationsOverview> = {}): MailApplicationsOverview {
  return {
    connected: true,
    connection: {
      email: 'me@gmail.com',
      provider: 'google',
      sync_status: 'idle',
      last_synced_at: '2026-10-16T14:05:00Z',
      last_sync_error: null,
      last_sync_stats: null,
      status: 'connected',
    },
    server: { server_configured: true, providers: ['google'] },
    timezone: 'UTC',
    days: 30,
    series: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, label: String(i + 1), count: i === 29 ? 3 : 1 })),
    totals: { range: 32, today: 3, week: 9, companies: 21, linked_jobs: 4, all_time: 40 },
    top_companies: [{ company: 'Acme', count: 3 }],
    recent: [
      {
        id: 'a1',
        company: 'Acme',
        role_title: 'Data Engineer',
        applied_at: '2026-10-16T09:00:00Z',
        email_subject: 'Thanks for applying',
        email_from: 'jobs@acme.com',
        email_url: 'https://mail.google.com/mail/?authuser=me@gmail.com#all/abc',
        job: { id: 'j1', title: 'Data Engineer' },
      },
    ],
    ...overrides,
  };
}
let applyAgentDashboard: ReturnType<typeof vi.fn>;

function progress(days: number) {
  return {
    timezone: 'UTC',
    days,
    min_match_score: 60,
    series: Array.from({ length: days }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      label: String(i + 1),
      posted: 10,
      recommended: 4,
      applied: 2,
    })),
    totals: { posted: 10 * days, recommended: 4 * days, applied: 2 * days },
  };
}

function renderPage(entry = '/app/insights') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/app/insights" element={<InsightsPage />} />
          <Route path="/app/jobs" element={<div>Jobs page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InsightsPage', () => {
  beforeEach(() => {
    fetchStats.mockReset();
    fetchProgress.mockReset();
    fetchProgress.mockImplementation(async (days: number) => progress(days));
    fetchInbox.mockReset();
    fetchInbox.mockResolvedValue(inbox({ connected: false, connection: null }));
    startSync.mockClear();
    fetchOverview.mockReset();
    fetchOverview.mockResolvedValue({ owned: [], memberships: [], invites: [], team_packages_held: 0 });
    fetchSpace.mockReset();
    fetchInsights.mockReset();
    fetchInsights.mockResolvedValue(teamInsights());
    applyAgentDashboard = vi.fn();
    useScraperStore.setState({ applyAgentDashboard } as never);
  });

  it('shows skeletons while loading, then renders tiles, pipeline, match quality and sources', async () => {
    fetchStats.mockResolvedValue(
      makeStats({
        sheet_posted_jobs: 4,
        sources: [
          { source: 'remote_ok', count: 30, latest_scraped: null },
          { source: 'manual', count: 10, latest_scraped: null },
        ],
      }),
    );
    renderPage();
    expect(screen.getByLabelText('Loading insights')).toBeInTheDocument();

    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getByRole('button', { name: /Today's new\s*12/ })).toBeInTheDocument();
    expect(within(today).getByRole('button', { name: /Ready among them\s*3/ })).toBeInTheDocument();

    const overview = screen.getByRole('region', { name: 'Overview' });
    expect(within(overview).getByRole('button', { name: /Total visible pool\s*200/ })).toBeInTheDocument();
    expect(within(overview).getByRole('button', { name: /Above your minimum\s*70/ })).toBeInTheDocument();
    expect(within(overview).getByRole('button', { name: /In Sheets\s*4/ })).toBeInTheDocument();
    expect(within(overview).queryByRole('button', { name: /In Pumble/ })).not.toBeInTheDocument();

    const pipeline = screen.getByRole('region', { name: 'Apply pipeline' });
    expect(within(pipeline).getByRole('button', { name: /Scored\s*90\s*45% of pool/ })).toBeInTheDocument();
    expect(within(pipeline).getByText('Not scored yet')).toBeInTheDocument();

    const quality = screen.getByRole('region', { name: 'Match quality' });
    expect(within(quality).getByRole('button', { name: /Strong \(75\+\)\s*21%\s*25/ })).toBeInTheDocument();
    expect(await within(quality).findByTestId('match-donut')).toHaveTextContent('64');

    const sources = screen.getByRole('region', { name: 'Sources' });
    expect(within(sources).getByText('Remote OK')).toBeInTheDocument();
    expect(within(sources).getByText('Added by you')).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it('charts activity for 7 days and switches to 30 days', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    const activity = await screen.findByRole('region', { name: 'Activity' });
    expect(await within(activity).findByTestId('activity-chart')).toHaveAttribute('data-points', '7');
    expect(activity).toHaveTextContent(/Applied\s*14/);
    expect(activity).toHaveTextContent('scoring 60+');
    await user.click(within(activity).getByRole('tab', { name: '30 days' }));
    await waitFor(() => expect(within(activity).getByTestId('activity-chart')).toHaveAttribute('data-points', '30'));
    expect(fetchProgress).toHaveBeenLastCalledWith(30);
  });

  it('renders both daily trend charts with the right series', async () => {
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    const charts = await screen.findAllByTestId('trend-chart');
    expect(charts.map((c) => c.textContent)).toEqual([
      'Documents ready / Applied',
      'Remote jobs added / Strong matches',
    ]);
    expect(charts[0]).toHaveAttribute('data-points', '2');
  });

  it('tile clicks apply board filters and open Jobs', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Remote among them/ }));
    expect(applyAgentDashboard).toHaveBeenCalledWith({ reset: true, view: 'today', remote_only: true });
    expect(screen.getByText('Jobs page')).toBeInTheDocument();
  });

  it('strong matches tile filters by score 75', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Strong \(≥75\)/ }));
    expect(applyAgentDashboard).toHaveBeenCalledWith({ reset: true, view: 'suggested', min_match_score: 75 });
  });

  it('pipeline stage opens the matching view', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    const pipeline = await screen.findByRole('region', { name: 'Apply pipeline' });
    await user.click(within(pipeline).getByRole('button', { name: /^Ready/ }));
    expect(applyAgentDashboard).toHaveBeenCalledWith({ reset: true, view: 'ready' });
  });

  it('refresh refetches stats and activity', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    await screen.findByRole('region', { name: 'Today' });
    await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(1));
    expect(fetchStats).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchStats).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(2));
  });

  it('shows the empty state when the user has no jobs', async () => {
    const user = userEvent.setup();
    useShellStore.setState({ assistantDocked: false });
    fetchStats.mockResolvedValue(emptyStats());
    renderPage();
    expect(await screen.findByText('No insights yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Today' })).not.toBeInTheDocument();
    expect(fetchProgress).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(useShellStore.getState().assistantDocked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Add jobs' }));
    expect(screen.getByText('Jobs page')).toBeInTheDocument();
  });

  it('asks to connect email when no mailbox is linked', async () => {
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    const card = await screen.findByRole('region', { name: 'Applications from your inbox' });
    expect(await within(card).findByRole('button', { name: 'Connect email' })).toHaveAttribute('href', '/app/interviews');
    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getByRole('button', { name: /Applied today\s*2\s*Marked applied/ })).toBeInTheDocument();
  });

  it('charts applications from email with the exact sync time and opens each email', async () => {
    fetchStats.mockResolvedValue(makeStats());
    fetchInbox.mockResolvedValue(inbox());
    renderPage();
    const card = await screen.findByRole('region', { name: 'Applications from your inbox' });
    expect(await within(card).findByTestId('applications-chart')).toHaveAttribute('data-points', '30');
    expect(within(card).getByTestId('applications-chart')).toHaveTextContent('Applications / 7-day average');
    expect(within(card).getByText('Last 30 days').nextSibling).toHaveTextContent('32');
    expect(within(card).getByText('Companies').nextSibling).toHaveTextContent('21');
    expect(within(card).getByRole('status')).toHaveTextContent(/Last synced Oct 16, 2026/);
    expect(within(card).getByRole('link', { name: 'Acme, Data Engineer. Open email' })).toHaveAttribute(
      'href',
      'https://mail.google.com/mail/?authuser=me@gmail.com#all/abc',
    );
    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getByRole('button', { name: /Applied today\s*3\s*Confirmation emails/ })).toBeInTheDocument();
    expect(fetchInbox).toHaveBeenCalledWith(30, expect.any(String));
  });

  it('Sync now starts an inbox sync and the range tabs refetch', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    fetchInbox.mockResolvedValue(inbox());
    renderPage();
    const card = await screen.findByRole('region', { name: 'Applications from your inbox' });
    await user.click(await within(card).findByRole('button', { name: 'Sync inbox now' }));
    expect(startSync).toHaveBeenCalledTimes(1);
    await user.click(within(card).getByRole('tab', { name: '7 days' }));
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledWith(7, expect.any(String)));
  });

  it('shows an error with Retry that refetches', async () => {
    const user = userEvent.setup();
    fetchStats.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(makeStats());
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load your insights.");
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Today' })).toBeInTheDocument();
    expect(fetchStats).toHaveBeenCalledTimes(2);
  });

  describe('team lead views', () => {
    it('hides the team navigation for anyone who leads no team', async () => {
      fetchStats.mockResolvedValue(makeStats());
      renderPage();
      await screen.findByRole('region', { name: 'Today' });
      await waitFor(() => expect(fetchOverview).toHaveBeenCalled());
      expect(screen.queryByRole('tablist', { name: 'Insights for' })).not.toBeInTheDocument();
    });

    it('opens a lead on their team, not their own search', async () => {
      leadOf();
      fetchStats.mockResolvedValue(makeStats());
      renderPage();
      expect(await screen.findByRole('region', { name: 'Team totals' })).toBeInTheDocument();
      const tabs = screen.getByRole('tablist', { name: 'Insights for' });
      expect(within(tabs).getByRole('tab', { name: new RegExp(SPACE.name) })).toHaveAttribute('aria-selected', 'true');
      const chips = screen.getByRole('tablist', { name: `Members of ${SPACE.name}` });
      expect(within(chips).getByRole('tab', { name: /Whole team/ })).toHaveAttribute('aria-selected', 'true');
      expect(within(chips).getByRole('tab', { name: /Pat Lee/ })).toBeInTheDocument();
    });

    it('shows every team side by side for a lead of several', async () => {
      const user = userEvent.setup();
      const other = { ...SPACE, id: 's2', public_id: 'nao-87654321', name: 'Design crew', member_count: 1 };
      fetchOverview.mockResolvedValue({ owned: [SPACE, other], memberships: [], invites: [], team_packages_held: 0 });
      fetchSpace.mockImplementation(async (id: string) =>
        id === 's2'
          ? { space: other, members: [{ ...MEMBERS[0], id: 'u9', name: 'Dana Designer' }], invites: [], stats_days: 30 }
          : { space: SPACE, members: MEMBERS, invites: [], stats_days: 30 },
      );
      fetchStats.mockResolvedValue(makeStats());
      renderPage();

      const teams = await screen.findByRole('region', { name: 'Teams' });
      expect(within(teams).getByRole('article', { name: SPACE.name })).toBeInTheDocument();
      expect(within(teams).getByRole('article', { name: 'Design crew' })).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Design crew members' })).toHaveTextContent('Dana Designer');
      expect(within(screen.getByRole('tablist', { name: 'Insights for' })).getByRole('tab', { name: /All teams/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      await user.click(screen.getByRole('button', { name: "View Dana Designer's insights" }));
      expect(await screen.findByRole('group', { name: 'Viewing Dana Designer' })).toBeInTheDocument();
      await waitFor(() => expect(fetchStats).toHaveBeenCalledWith('u9'));
      const chips = screen.getByRole('tablist', { name: 'Members of Design crew' });
      expect(within(chips).getByRole('tab', { name: /Dana Designer/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('lets a lead pick a member and shows their numbers read only', async () => {
      const user = userEvent.setup();
      leadOf();
      fetchStats.mockResolvedValue(makeStats());
      fetchInbox.mockResolvedValue(
        inbox({
          connection: { ...inbox().connection!, email: 'pat@gmail.com' },
          recent: inbox().recent.map((r) => ({ ...r, email_url: null })),
        }),
      );
      renderPage();
      const chips = await screen.findByRole('tablist', { name: `Members of ${SPACE.name}` });
      await user.click(within(chips).getByRole('tab', { name: /Pat Lee/ }));

      expect(await screen.findByRole('group', { name: 'Viewing Pat Lee' })).toBeInTheDocument();
      await waitFor(() => expect(fetchStats).toHaveBeenCalledWith('u2'));
      expect(fetchProgress).toHaveBeenLastCalledWith(7, 'u2');
      expect(fetchInbox).toHaveBeenCalledWith(30, expect.any(String), 'u2');

      const today = await screen.findByRole('region', { name: 'Today' });
      expect(within(today).queryAllByRole('button')).toHaveLength(0);
      const card = await screen.findByRole('region', { name: "Applications from Pat Lee's inbox" });
      await within(card).findByTestId('applications-chart');
      expect(within(card).queryByRole('button', { name: 'Sync inbox now' })).not.toBeInTheDocument();
      expect(within(card).queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Full report/ })).toHaveAttribute('href', '/app/team/s1/members/u2');

      await user.click(screen.getByRole('button', { name: `Back to ${SPACE.name}` }));
      expect(screen.queryByRole('group', { name: 'Viewing Pat Lee' })).not.toBeInTheDocument();
      expect(await screen.findByRole('region', { name: 'Team totals' })).toBeInTheDocument();
    });

    it('opens the whole-team view from the link and drills into a member', async () => {
      const user = userEvent.setup();
      leadOf();
      fetchStats.mockResolvedValue(makeStats());
      renderPage('/app/insights?view=team:s1');

      const totals = await screen.findByRole('region', { name: 'Team totals' });
      expect(within(totals).getByText('2 of 2')).toBeInTheDocument();
      expect(within(totals).getByText('25')).toBeInTheDocument();
      expect(fetchInsights).toHaveBeenCalledWith('s1', 30);

      const progressCard = screen.getByRole('region', { name: 'Team progress' });
      expect(await within(progressCard).findByTestId('team-chart')).toHaveTextContent('Pat Lee / Sam Roe');
      await user.click(within(progressCard).getByRole('tab', { name: '90 days' }));
      await waitFor(() => expect(fetchInsights).toHaveBeenLastCalledWith('s1', 90));

      const rows = within(screen.getByRole('region', { name: 'Member comparison' })).getAllByRole('listitem');
      expect(rows[0]).toHaveTextContent('Pat Lee');
      await user.click(screen.getByRole('button', { name: "View Sam Roe's insights" }));
      expect(await screen.findByRole('group', { name: 'Viewing Sam Roe' })).toBeInTheDocument();
      await waitFor(() => expect(fetchStats).toHaveBeenCalledWith('u3'));
    });

    it('switches between your search and each team space from the team tabs', async () => {
      const user = userEvent.setup();
      leadOf();
      fetchStats.mockResolvedValue(makeStats());
      renderPage();

      const tabs = await screen.findByRole('tablist', { name: 'Insights for' });
      await user.click(within(tabs).getByRole('tab', { name: /You/ }));
      expect(await screen.findByRole('region', { name: 'Today' })).toBeInTheDocument();
      expect(within(tabs).getByRole('tab', { name: /You/ })).toHaveAttribute('aria-selected', 'true');

      await user.click(within(tabs).getByRole('tab', { name: new RegExp(SPACE.name) }));
      expect(await screen.findByRole('region', { name: 'Team totals' })).toBeInTheDocument();
    });

    it('falls back to your own insights for a member you do not lead', async () => {
      leadOf();
      fetchStats.mockResolvedValue(makeStats());
      renderPage('/app/insights?view=member:stranger');
      expect(await screen.findByRole('region', { name: 'Today' })).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: /Viewing/ })).not.toBeInTheDocument();
      expect(fetchStats).not.toHaveBeenCalledWith('stranger');
    });
  });
});
