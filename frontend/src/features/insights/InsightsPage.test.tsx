import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fetchMailApplications, syncInterviews } from '@/api/interviewsApi';
import { fetchScraperStats, fetchWeeklyProgress } from '@/api/scraperApi';
import type { MailApplicationsOverview } from '@/types/interviews';
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
    MatchDonut: ({ avg }: { avg: number }) => <div data-testid="match-donut">{avg}</div>,
  };
});

vi.mock('@/api/interviewsApi', () => ({
  fetchMailApplications: vi.fn(),
  syncInterviews: vi.fn(async () => ({ started: true })),
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn() }) }));

const fetchStats = vi.mocked(fetchScraperStats);
const fetchProgress = vi.mocked(fetchWeeklyProgress);
const fetchInbox = vi.mocked(fetchMailApplications);
const startSync = vi.mocked(syncInterviews);

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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/app/insights']}>
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
});
