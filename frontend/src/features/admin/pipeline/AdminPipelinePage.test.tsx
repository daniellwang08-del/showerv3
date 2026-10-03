import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useScraperStore } from '@/stores/scraperStore';
import { makeJob } from '@/test/jobFixtures';
import type { AdminScraperStats, DashboardJob, SpiderInfo, SyncTriggerOptions } from '@/types/scraper';
import * as scraperApi from '@/api/scraperApi';
import * as pipelineApi from './pipelineApi';
import { AdminPipelinePage } from './AdminPipelinePage';

vi.mock('@/api/client', () => ({
  apiClient: { post: vi.fn(async () => ({ data: {} })), get: vi.fn(async () => ({ data: {} })), delete: vi.fn() },
}));
vi.mock('@/api/googleSheetsApi', () => ({ fetchSheetsConfig: vi.fn(async () => ({ configured: false })), postJobsToSheet: vi.fn() }));
vi.mock('@/api/pumbleApi', () => ({
  fetchPumbleConfig: vi.fn(async () => ({ configured: false, integrations: [] })),
  postJobsToPumble: vi.fn(),
}));
vi.mock('@/api/settingsApi', () => ({
  fetchUserSettings: vi.fn(async () => ({ active_llm_model: null, default_llm_model: 'gpt-default' })),
  setActiveLlmModel: vi.fn(async () => ({})),
}));
vi.mock('@/api/scraperApi', () => ({
  fetchDashboardJobs: vi.fn(),
  fetchAdminScraperStats: vi.fn(),
  fetchDashboardCounts: vi.fn(async () => ({})),
  fetchScraperStats: vi.fn(async () => ({})),
  fetchJobSyncSchedule: vi.fn(async () => ({ spider_names: null, sync_mode: 'incremental', last_run_at: null })),
  fetchSpiders: vi.fn(async () => [
    { name: 'greenhouse', label: 'Greenhouse', requires_auth: false, auth_configured: false, auth_saved_at: null, auth_setup_command: null },
  ]),
  fetchScrapeRuns: vi.fn(async () => []),
  fetchSyncStatus: vi.fn(async () => ({ status: 'idle', spider_name: null, message: '' })),
  triggerSync: vi.fn(async () => ({ status: 'queued', spider_name: 'all', message: 'Sync queued' })),
  stopJobFetch: vi.fn(async () => ({})),
}));
vi.mock('./pipelineApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pipelineApi')>()),
  prepareJob: vi.fn(async () => ({ ok: true, message: 'Queued.', extractIds: [] })),
  prepareJobs: vi.fn(async (ids: string[]) => ({ ok: true, message: `Queued ${ids.length} jobs.`, extractIds: ids })),
  deleteJobs: vi.fn(async (ids: string[]) => ({ ok: true, deleted: ids, message: 'Deleted.' })),
  fetchAllJobs: vi.fn(async () => []),
  fetchLlmModels: vi.fn(async () => []),
  reconcileOncePerSession: vi.fn(),
}));

beforeAll(() => {
  const W = 1400;
  const H = 900;
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(target: Element) {
      const entry = {
        target,
        contentRect: { width: W, height: H },
        borderBoxSize: [{ inlineSize: W, blockSize: H }],
      } as unknown as ResizeObserverEntry;
      this.cb([entry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

const stats: AdminScraperStats = {
  total_jobs: 4321,
  total_remote: 10,
  today_fetched: 87,
  today_scraped: 87,
  today_remote: 5,
  today_posted: 0,
  extracted_jobs: 3000,
  needs_extraction_jobs: 0,
  extraction_failed_jobs: 12,
  extraction_pending_jobs: 0,
  sheet_posted_jobs: 0,
  pumble_posted_jobs: 0,
  manual_jobs: 7,
  team_applied_today: 0,
  last_sync_items_new: 14,
  last_sync_errors: 0,
  total_users: 9,
  new_users_week: 2,
  platform_sync: [
    { name: 'greenhouse', label: 'Greenhouse', job_count: 900, last_items_new: 3, last_items_scraped: 40, last_errors: 0 },
  ],
  sources: [],
  recent_runs: [],
};

const SPIDERS: SpiderInfo[] = [
  { name: 'greenhouse', label: 'Greenhouse', requires_auth: false, auth_configured: false, auth_saved_at: null, auth_setup_command: null },
];

let jobs: DashboardJob[];
let storeActions: Record<string, ReturnType<typeof vi.fn>>;
const api = vi.mocked(scraperApi);
const pipe = vi.mocked(pipelineApi);

function page(items: DashboardJob[]) {
  return { items, total: items.length, page: 1, per_page: 50, pages: 1 };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <AdminPipelinePage />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const lastListCall = () => api.fetchDashboardJobs.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  jobs = [
    makeJob({ id: 'a1', title: 'Backend Engineer', company: 'Acme' }),
    makeJob({ id: 'b2', title: 'Data Scientist', company: 'Globex', extraction_status: null, extraction_id: null }),
    makeJob({ id: 'c3', title: 'Product Designer', company: 'Initech' }),
  ];
  api.fetchDashboardJobs.mockImplementation(async () => page(jobs) as never);
  api.fetchAdminScraperStats.mockResolvedValue(stats as never);
  // The test setup imports the store graph before these mocks register, so the store keeps the
  // real API module; stub its sync actions and route startSync through the mocked API instead.
  storeActions = {
    loadSpiders: vi.fn(async () => useScraperStore.setState({ spiders: SPIDERS })),
    loadLastSyncRuns: vi.fn(async () => {}),
    checkSyncStatus: vi.fn(async () => {}),
    startSync: vi.fn(async (opts: SyncTriggerOptions) => {
      useScraperStore.setState({
        syncing: true,
        syncProgress: { spiderName: 'all', current: 0, total: 1, itemsScraped: 0, itemsNew: 0, elapsedSeconds: 0, message: 'Queueing sync…' },
      });
      await api.triggerSync(opts);
    }),
  };
  useScraperStore.setState({
    syncing: false,
    syncProgress: null,
    syncNotice: null,
    spiders: [],
    lastSyncRuns: [],
    ...storeActions,
  } as never);
});

describe('AdminPipelinePage', () => {
  it('renders the stats strip and job rows', async () => {
    renderPage();
    expect(await screen.findByText('Backend Engineer')).toBeInTheDocument();
    expect(screen.getByText('Data Scientist')).toBeInTheDocument();
    expect(screen.getByText('Product Designer')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /total jobs/i })).toHaveTextContent('4,321');
    expect(screen.getByRole('button', { name: /today.s fetched/i })).toHaveTextContent('87');
    expect(lastListCall()).toMatchObject({ view: 'today', sort: 'created_at', order: 'desc' });
  });

  it('switching views refetches with the new view', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Backend Engineer');
    await user.click(screen.getByRole('tab', { name: /^all/i }));
    await waitFor(() => expect(lastListCall()).toMatchObject({ view: 'all', page: 1 }));
    expect(screen.getByRole('tab', { name: /^all/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('starting a sync calls the API and shows progress', async () => {
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole('button', { name: /sync all sites/i });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const payload = { spider_name: 'all', spider_names: ['greenhouse'], sync_mode: 'incremental' };
    expect(storeActions.startSync).toHaveBeenCalledWith(expect.objectContaining(payload));
    await waitFor(() => expect(api.triggerSync).toHaveBeenCalledWith(expect.objectContaining(payload)));
    const progress = await screen.findAllByText('Queueing sync…');
    expect(progress.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /sync all sites/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('deleting a row requires confirmation before calling the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Backend Engineer');
    await user.click(screen.getAllByRole('button', { name: 'Delete job' })[0]);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete this job?')).toBeInTheDocument();
    expect(pipe.deleteJobs).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(pipe.deleteJobs).toHaveBeenCalledWith(['a1']));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('bulk extract sends the selected job ids', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Backend Engineer');
    await user.click(screen.getByRole('checkbox', { name: 'Select Backend Engineer' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Product Designer' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: /extract selected/i }));
    await waitFor(() => expect(pipe.prepareJobs).toHaveBeenCalledWith(['a1', 'c3']));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument());
  });

  it('shows an inline error with Retry when the list fails', async () => {
    const user = userEvent.setup();
    api.fetchDashboardJobs.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/couldn.t load jobs/i)).toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByText('Backend Engineer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
