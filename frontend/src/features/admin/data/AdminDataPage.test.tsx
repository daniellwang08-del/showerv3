import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as dm from '@/api/dataManagementApi';
import { cleanupJobs } from '@/api/adminApi';
import type { JobCleanupResult } from '@/types/admin';
import type { MultiSeriesResult } from '@/types/dataManagement';
import { AdminDataPage } from './AdminDataPage';

vi.mock('@/api/dataManagementApi', () => ({
  getClientTimezone: () => 'UTC',
  fetchDataManagementMonths: vi.fn(),
  fetchAnalysisUsers: vi.fn(),
  fetchAnalysisPlatforms: vi.fn(),
  fetchAppliedVsFetchedSeries: vi.fn(),
  fetchRemoteVsFetchedSeries: vi.fn(),
  fetchPipelineSeries: vi.fn(),
  fetchDistributionSeries: vi.fn(),
  fetchGrowthSeries: vi.fn(),
  fetchScrapeHealthSeries: vi.fn(),
  fetchUserActivitySeries: vi.fn(),
  fetchPlatformVsAppliedSeries: vi.fn(),
}));
vi.mock('@/api/adminApi', () => ({ cleanupJobs: vi.fn() }));
vi.mock('./DataCharts', () => ({
  default: ({ data, series }: { data: unknown[]; series: { label: string }[] }) => (
    <div data-testid="line-chart" data-points={data.length}>
      {series.map((s) => s.label).join(' / ')}
    </div>
  ),
}));

const api = vi.mocked(dm);
const cleanup = vi.mocked(cleanupJobs);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const days = [
  { date: '2026-10-01', a: 1, b: 2 },
  { date: '2026-10-02', a: 3, b: 4 },
];
const multi = (series: Array<[string, string]>, totals: Record<string, number> = {}): MultiSeriesResult => ({
  year: 2026,
  month: 10,
  timezone: 'UTC',
  days,
  series: series.map(([key, label]) => ({ key, label })),
  totals,
});
const users = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, name: `User ${i}`, email: `u${i}@x.io` }));

function seedAnalytics() {
  api.fetchDataManagementMonths.mockResolvedValue({
    timezone: 'UTC',
    months: [
      { year: 2026, month: 10, label: 'October 2026' },
      { year: 2026, month: 9, label: 'September 2026' },
    ],
  });
  api.fetchAnalysisUsers.mockResolvedValue(users);
  api.fetchAnalysisPlatforms.mockResolvedValue(['linkedin', 'lever']);
  api.fetchAppliedVsFetchedSeries.mockResolvedValue({
    year: 2026,
    month: 10,
    timezone: 'UTC',
    days: [{ date: '2026-10-01', applied_count: 4, fetched_count: 90 }],
    totals: { applied_count: 4, fetched_count: 90 },
  });
  api.fetchRemoteVsFetchedSeries.mockResolvedValue({
    year: 2026,
    month: 10,
    timezone: 'UTC',
    days: [{ date: '2026-10-01', remote_count: 30, fetched_count: 90 }],
    totals: { remote_count: 30, fetched_count: 90 },
  });
  api.fetchPipelineSeries.mockResolvedValue(
    multi([['fetched_count', 'Fetched'], ['jd_ready_count', 'JD ready'], ['extraction_failed_count', 'Failed']], {
      fetched_count: 12345,
      jd_ready_count: 800,
      extraction_failed_count: 7,
      backlog_now: 42,
    }),
  );
  api.fetchDistributionSeries.mockResolvedValue(
    multi([['sheet_posted_count', 'Sheet'], ['pumble_posted_count', 'Pumble']], { sheet_posted_count: 5, pumble_posted_count: 6 }),
  );
  api.fetchGrowthSeries.mockResolvedValue(
    multi([['new_users_count', 'New users'], ['team_applied_count', 'Team applied']], { new_users_count: 2, team_applied_count: 77 }),
  );
  api.fetchScrapeHealthSeries.mockResolvedValue(
    multi([['items_new', 'Items new'], ['errors', 'Errors']], { items_new: 321, errors: 1, runs: 9 }),
  );
  api.fetchUserActivitySeries.mockResolvedValue(multi([['u0_applied', 'User 0 · Applied']]));
  api.fetchPlatformVsAppliedSeries.mockResolvedValue(multi([['linkedin', 'linkedin fetched'], ['applied', 'Applied']]));
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage(path = '/admin/data') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AdminDataPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

const previewResult = (over: Partial<JobCleanupResult> = {}): JobCleanupResult => ({
  preview: true,
  mode: 'age',
  older_than_days: 60,
  pattern: null,
  match_fields: [],
  case_insensitive: null,
  cutoff: '2026-08-04T00:00:00Z',
  matching_jobs: 3,
  deleted: 0,
  sample: [
    { job_id: 'j1', title: 'Old Engineer', company: 'Acme', domain: 'acme.com', source_url: '', created_at: null },
  ],
  ...over,
});

const baseCriteria = {
  older_than_days: 60,
  pattern: null,
  match_fields: [],
  case_insensitive: true,
  sample_limit: 20,
};

describe('AdminDataPage, analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAnalytics();
  });

  it('renders metrics and charts for the latest month, then refetches when the month changes', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('321')).toBeInTheDocument();
    expect(screen.getByText('4 applied · 90 fetched')).toBeInTheDocument();
    expect(screen.getByText('800 ready · 7 failed · backlog 42')).toBeInTheDocument();
    expect((await screen.findAllByTestId('line-chart')).length).toBeGreaterThanOrEqual(6);
    expect(api.fetchPipelineSeries).toHaveBeenCalledWith(2026, 10, 'UTC');
    await waitFor(() =>
      expect(api.fetchUserActivitySeries).toHaveBeenCalledWith({
        year: 2026,
        month: 10,
        timezone: 'UTC',
        user_ids: ['u0', 'u1', 'u2', 'u3', 'u4'],
        metrics: ['board_added', 'applied'],
      }),
    );
    expect(api.fetchPlatformVsAppliedSeries).toHaveBeenCalledWith({
      year: 2026,
      month: 10,
      timezone: 'UTC',
      platforms: ['linkedin', 'lever'],
    });

    await user.click(screen.getByRole('combobox', { name: 'Month period' }));
    await user.click(await screen.findByRole('option', { name: 'September 2026' }));

    await waitFor(() => expect(api.fetchPipelineSeries).toHaveBeenCalledWith(2026, 9, 'UTC'));
    for (const fn of [
      api.fetchAppliedVsFetchedSeries,
      api.fetchRemoteVsFetchedSeries,
      api.fetchDistributionSeries,
      api.fetchGrowthSeries,
      api.fetchScrapeHealthSeries,
    ]) {
      expect(fn).toHaveBeenCalledWith(2026, 9, 'UTC');
    }
    await waitFor(() =>
      expect(api.fetchUserActivitySeries).toHaveBeenCalledWith(expect.objectContaining({ year: 2026, month: 9 })),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('month=2026-9');
  });

  it('stops requesting user activity when every metric is deselected', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('12,345');
    await waitFor(() => expect(api.fetchUserActivitySeries).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('checkbox', { name: 'Board added' }));
    await waitFor(() =>
      expect(api.fetchUserActivitySeries).toHaveBeenLastCalledWith(expect.objectContaining({ metrics: ['applied'] })),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Applied' }));
    expect(await screen.findByText('Select at least one metric for this month.')).toBeInTheDocument();
    expect(api.fetchUserActivitySeries).toHaveBeenCalledTimes(2);
  });

  it('filters the platform series to the selected platforms', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(api.fetchPlatformVsAppliedSeries).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Platforms' }));
    await user.click(await screen.findByRole('checkbox', { name: 'lever' }));

    await waitFor(() =>
      expect(api.fetchPlatformVsAppliedSeries).toHaveBeenLastCalledWith(
        expect.objectContaining({ year: 2026, month: 10, platforms: ['linkedin'] }),
      ),
    );
  });

  it('shows a skeleton while loading', () => {
    api.fetchDataManagementMonths.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText('Loading analytics')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an inline error with Retry when months fail to load', async () => {
    const user = userEvent.setup();
    api.fetchDataManagementMonths.mockRejectedValueOnce({ response: { data: { detail: 'Analytics offline' } } });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Analytics offline');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('12,345')).toBeInTheDocument();
    expect(api.fetchDataManagementMonths).toHaveBeenCalledTimes(2);
  });

  it('shows a per-chart error with Retry', async () => {
    const user = userEvent.setup();
    api.fetchScrapeHealthSeries.mockRejectedValueOnce(new Error('scrape down'));
    renderPage();

    const chart = await screen.findByRole('figure', { name: 'Scrape health' });
    await waitFor(() => expect(within(chart).getByRole('alert')).toHaveTextContent('scrape down'));
    await user.click(within(chart).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(chart).getByTestId('line-chart')).toBeInTheDocument());
  });
});

describe('AdminDataPage, cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAnalytics();
  });

  it('syncs the active tab to ?tab=', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Cleanup' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/data?tab=cleanup');
    expect(screen.getByRole('button', { name: 'Preview matches' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Analytics' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/data$/);
  });

  it('previews counts, then deletes after confirming with the exact criteria', async () => {
    const user = userEvent.setup();
    cleanup.mockResolvedValueOnce(previewResult());
    cleanup.mockResolvedValueOnce(previewResult({ preview: false, deleted: 3, sample: [] }));
    const { invalidate } = renderPage('/admin/data?tab=cleanup');

    const del = screen.getByRole('button', { name: 'Delete matching jobs' });
    expect(del).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview matches' }));

    expect(cleanup).toHaveBeenCalledWith({ ...baseCriteria, preview_only: true });
    expect(await screen.findByText('Matched 3 jobs.')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Matching jobs sample' })).toHaveTextContent('Old Engineer');

    await user.click(del);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete 3 jobs?');
    expect(dialog).toHaveTextContent(
      'Permanently delete 3 jobs matching older than 60 days, including related match, application, and extraction rows.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    expect(cleanup).toHaveBeenLastCalledWith({ ...baseCriteria, confirm: true });
    expect(await screen.findByText('Deleted 3 of 3 matching jobs.')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['jobs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-data'] });
    expect(screen.getByRole('button', { name: 'Delete matching jobs' })).toBeDisabled();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    cleanup.mockResolvedValueOnce(previewResult());
    renderPage('/admin/data?tab=cleanup');

    await user.click(screen.getByRole('button', { name: 'Preview matches' }));
    await screen.findByText('Matched 3 jobs.');
    await user.click(screen.getByRole('button', { name: 'Delete matching jobs' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Delete matching jobs' })).toBeEnabled();
  });

  it('validates criteria and sends pattern options in the preview payload', async () => {
    const user = userEvent.setup();
    cleanup.mockResolvedValueOnce(previewResult({ mode: 'pattern', matching_jobs: 0, sample: [] }));
    renderPage('/admin/data?tab=cleanup');
    const previewBtn = screen.getByRole('button', { name: 'Preview matches' });

    const days = screen.getByLabelText('Older than (days)');
    await user.clear(days);
    expect(screen.getByText(/whole number of days/)).toBeInTheDocument();
    expect(previewBtn).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Age-based cleanup' }));

    await user.click(screen.getByRole('switch', { name: 'Pattern-based cleanup' }));
    expect(screen.getByText('Enter a pattern to match.')).toBeInTheDocument();
    expect(previewBtn).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'LinkedIn' }));
    await user.click(screen.getByRole('button', { name: 'Title' }));
    await user.click(screen.getByRole('checkbox', { name: 'Case-insensitive' }));
    await user.click(previewBtn);

    expect(cleanup).toHaveBeenCalledWith({
      older_than_days: null,
      pattern: String.raw`linkedin\.com`,
      match_fields: ['company', 'domain', 'title'],
      case_insensitive: false,
      sample_limit: 20,
      preview_only: true,
    });
    expect(await screen.findByText('No jobs matched these criteria.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete matching jobs' })).toBeDisabled();
  });
});
