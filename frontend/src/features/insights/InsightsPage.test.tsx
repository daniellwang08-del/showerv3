import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fetchScraperStats } from '@/api/scraperApi';
import { useScraperStore } from '@/stores/scraperStore';
import { useShellStore } from '@/stores/shellStore';
import { emptyStats, makeStats } from './insightsFixtures';
import { InsightsPage } from './InsightsPage';

vi.mock('@/api/scraperApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/scraperApi')>()),
  fetchScraperStats: vi.fn(),
}));

vi.mock('./InsightsCharts', () => ({
  default: ({ data, series }: { data: unknown[]; series: { label: string }[] }) => (
    <div data-testid="trend-chart" data-points={data.length}>
      {series.map((s) => s.label).join(' / ')}
    </div>
  ),
}));

const fetchStats = vi.mocked(fetchScraperStats);
let applyAgentDashboard: ReturnType<typeof vi.fn>;

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
    applyAgentDashboard = vi.fn();
    useScraperStore.setState({ applyAgentDashboard } as never);
  });

  it('shows skeletons while loading, then renders tiles, funnel and sources', async () => {
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
    expect(within(overview).getByRole('button', { name: /Avg match score\s*64/ })).toBeInTheDocument();
    expect(within(overview).getByRole('button', { name: /In Sheets\s*4/ })).toBeInTheDocument();
    expect(within(overview).queryByRole('button', { name: /In Pumble/ })).not.toBeInTheDocument();

    const pipeline = screen.getByRole('region', { name: 'Apply pipeline' });
    expect(within(pipeline).getByRole('button', { name: /In progress\s*45% of pool\s*90/ })).toBeInTheDocument();

    const sources = screen.getByRole('region', { name: 'Sources' });
    expect(within(sources).getByText('remote ok')).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it('lazily renders both trend charts with the right series', async () => {
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    const charts = await screen.findAllByTestId('trend-chart');
    expect(charts.map((c) => c.textContent)).toEqual(['Ready / In progress', 'Remote / Strong matches']);
    expect(charts[0]).toHaveAttribute('data-points', '2');
  });

  it('tile and funnel clicks apply board filters and open Jobs', async () => {
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

  it('funnel step opens the matching view', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    const pipeline = await screen.findByRole('region', { name: 'Apply pipeline' });
    await user.click(within(pipeline).getByRole('button', { name: /^Ready/ }));
    expect(applyAgentDashboard).toHaveBeenCalledWith({ reset: true, view: 'ready' });
  });

  it('refresh refetches stats', async () => {
    const user = userEvent.setup();
    fetchStats.mockResolvedValue(makeStats());
    renderPage();
    await screen.findByRole('region', { name: 'Today' });
    expect(fetchStats).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchStats).toHaveBeenCalledTimes(2));
  });

  it('shows the empty state when the user has no jobs', async () => {
    const user = userEvent.setup();
    useShellStore.setState({ assistantDocked: false });
    fetchStats.mockResolvedValue(emptyStats());
    renderPage();
    expect(await screen.findByText('No insights yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Today' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(useShellStore.getState().assistantDocked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Add jobs' }));
    expect(screen.getByText('Jobs page')).toBeInTheDocument();
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
