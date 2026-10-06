import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as dm from '@/api/dataManagementApi';
import { cleanupJobs } from '@/api/adminApi';
import type { JobCleanupResult } from '@/types/admin';
import type { AiUsageOverview, AiUsageUserRow, MultiSeriesResult } from '@/types/dataManagement';
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
  fetchAiUsageOverview: vi.fn(),
  fetchAiUsageSeries: vi.fn(),
  fetchTailoringRunsSeries: vi.fn(),
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
  api.fetchAiUsageOverview.mockResolvedValue(usageOverview);
  api.fetchAiUsageSeries.mockResolvedValue(multi([['usage_u5', 'User 5']], { usage_u5: 1.5 }));
  api.fetchTailoringRunsSeries.mockResolvedValue(
    multi([['tailor_runs_u5', 'User 5 · runs'], ['tailor_jobs_u5', 'User 5 · unique jobs']]),
  );
}

const usageRow = (over: Partial<AiUsageUserRow>): AiUsageUserRow => ({
  user_id: 'u0',
  name: 'User 0',
  email: 'u0@x.io',
  approval_status: 'approved',
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cost_usd: 0,
  last_used_at: null,
  tailor_runs: 0,
  tailored_jobs: 0,
  reruns: 0,
  max_runs_per_job: 0,
  applied: 0,
  cost_per_application: null,
  features: [],
  ...over,
});

const usageOverview: AiUsageOverview = {
  year: 2026,
  month: 10,
  timezone: 'UTC',
  totals: {
    calls: 316,
    prompt_tokens: 1_900_000,
    completion_tokens: 530_000,
    reasoning_tokens: 0,
    total_tokens: 2_430_000,
    cost_usd: 7.68,
    users: 2,
    unpriced_calls: 0,
  },
  users: [
    usageRow({
      user_id: 'u5',
      name: 'User 5',
      email: 'u5@x.io',
      calls: 300,
      total_tokens: 2_400_000,
      cost_usd: 7.5,
      tailor_runs: 127,
      tailored_jobs: 110,
      reruns: 17,
      max_runs_per_job: 3,
      applied: 10,
      cost_per_application: 0.75,
      features: [{ feature: 'resume_tailoring', total_tokens: 1_800_000, cost_usd: 6 }],
    }),
    usageRow({ user_id: 'u9', name: 'Rejected Person', email: 'r@x.io', approval_status: 'rejected', cost_usd: 0.18 }),
  ],
  by_feature: [{ feature: 'resume_tailoring', total_tokens: 1_800_000, cost_usd: 6 }],
  days,
  series: [{ key: 'feat_resume_tailoring', label: 'resume_tailoring', feature: 'resume_tailoring' }],
};

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
        metrics: ['applied'],
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

  it('charts applications per user only, with no board-added metric', async () => {
    renderPage();
    expect(await screen.findByRole('figure', { name: 'October 2026 applications per user' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Board added' })).not.toBeInTheDocument();
  });

  it('shows AI cost per user with tailoring reruns, top spenders selected first', async () => {
    const user = userEvent.setup();
    renderPage();

    const totals = await screen.findByRole('region', { name: 'AI usage totals' });
    expect(within(totals).getByText('$7.68')).toBeInTheDocument();
    expect(within(totals).getByText('17')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'AI usage per user' });
    const [, top, rejected] = within(table).getAllByRole('row');
    expect(top).toHaveTextContent('User 5');
    expect(top).toHaveTextContent('$7.50');
    expect(top).toHaveTextContent('127');
    expect(top).toHaveTextContent('110');
    expect(top).toHaveTextContent('3×');
    expect(top).toHaveTextContent('Resume tailoring');
    expect(rejected).toHaveTextContent('rejected');

    await waitFor(() =>
      expect(api.fetchTailoringRunsSeries).toHaveBeenCalledWith(
        expect.objectContaining({ year: 2026, month: 10, user_ids: ['u5', 'u9', 'u0', 'u1', 'u2'] }),
      ),
    );
    expect(api.fetchAiUsageSeries).toHaveBeenLastCalledWith(expect.objectContaining({ measure: 'cost' }));

    await user.click(screen.getByRole('button', { name: 'Tokens' }));
    await waitFor(() =>
      expect(api.fetchAiUsageSeries).toHaveBeenLastCalledWith(expect.objectContaining({ measure: 'tokens' })),
    );
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
