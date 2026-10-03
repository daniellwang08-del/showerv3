import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useScraperStore } from '@/stores/scraperStore';
import { useJobsStore } from '@/stores/jobsStore';
import { makeJob, readyJob } from '@/test/jobFixtures';
import type { DashboardJob } from '@/types/scraper';
import { JobsPage } from './JobsPage';

vi.mock('@/api/googleSheetsApi', () => ({
  fetchSheetsConfig: vi.fn(async () => ({ configured: true })),
  postJobsToSheet: vi.fn(),
}));
vi.mock('@/api/pumbleApi', () => ({
  fetchPumbleConfig: vi.fn(async () => ({ configured: false, integrations: [] })),
  postJobsToPumble: vi.fn(),
}));
vi.mock('@/api/client', () => ({
  apiClient: { post: vi.fn(async () => ({ data: {} })), get: vi.fn(async () => ({ data: {} })) },
}));
beforeAll(() => {
  // jsdom has no layout: give every element a desktop-sized box so the virtualizer renders rows.
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
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => W });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => H });
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, width: W, height: H, toJSON() {} }) as DOMRect;
  Element.prototype.scrollTo = function scrollTo() {};
});

let actions: Record<string, ReturnType<typeof vi.fn>>;

function seed(jobs: DashboardJob[], extra: Partial<ReturnType<typeof useScraperStore.getState>> = {}) {
  actions = {
    loadJobs: vi.fn(async () => {}),
    loadStats: vi.fn(async () => {}),
    bgRefreshJobs: vi.fn(async () => {}),
    loadCounts: vi.fn(async () => {}),
    setView: vi.fn(),
    setSort: vi.fn(),
    setPage: vi.fn(),
    setSearchQuery: vi.fn(),
    setRemoteOnly: vi.fn(),
    markJobsApplied: vi.fn(async () => ({ ok: true, message: 'Marked applied' })),
    markJobsUnapplied: vi.fn(async () => ({ ok: true, message: 'Unmarked' })),
    optimisticMarkJobsApplied: vi.fn(),
    deleteJob: vi.fn(async () => ({ ok: true, message: 'Deleted' })),
    batchDeleteJobs: vi.fn(async () => ({ ok: true, message: 'Deleted 2 jobs' })),
    rerunJob: vi.fn(async () => ({ ok: true, message: 'Queued' })),
    batchRerunJobs: vi.fn(async () => ({ ok: true, message: 'Queued 2' })),
  };
  useScraperStore.setState({
    jobs,
    total: jobs.length,
    page: 1,
    pages: 1,
    perPage: 50,
    loading: false,
    view: 'all',
    sortField: 'created_at',
    sortOrder: 'desc',
    searchQuery: '',
    titleFilter: '',
    companyFilter: '',
    sourceFilter: '',
    remoteOnly: false,
    minScore: 0,
    counts: { all: jobs.length, today: 1, mine: 0, available: 2 },
    stats: null,
    ...actions,
    ...extra,
  } as never);
  useJobsStore.setState({ refreshLists: vi.fn(async () => {}) } as never);
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/app/jobs']}>
          <JobsPage />
          <LocationProbe />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const rows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-job-id'));

describe('JobsPage', () => {
  beforeEach(() => {
    sessionStorage.setItem('company_policy_reconciled_v1', 'done');
    sessionStorage.setItem('location_reconciled_v2', 'done');
  });

  it('loads on mount and renders rows with scores and stages', async () => {
    seed([readyJob({ title: 'Staff Engineer', company: 'Acme' }), makeJob({ title: 'Data Engineer', match_in_progress: true })]);
    renderPage();
    expect(actions.loadJobs).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(2);
    expect(screen.getByText('Staff Engineer')).toBeInTheDocument();
    expect(screen.getByText('Ready to apply', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getAllByText('Matching').length).toBeGreaterThan(0);
    expect(screen.getByText('1–2 of 2')).toBeInTheDocument();
  });

  it('hides dismissed duplicates', () => {
    seed([makeJob({ title: 'Visible' }), makeJob({ title: 'Dismissed', user_status: 'duplicated' })]);
    renderPage();
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText('Dismissed')).not.toBeInTheDocument();
  });

  it('opens the detail panel on row click and Enter', async () => {
    const user = userEvent.setup();
    const [a, b] = [makeJob({ id: 'a', title: 'Alpha' }), makeJob({ id: 'b', title: 'Beta' })];
    seed([a, b]);
    renderPage();
    await user.click(screen.getByText('Alpha'));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/jobs?job=a');
    rows()[1].focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('job=b');
  });

  it('selects with checkboxes and shift-range, then bulk marks applied', async () => {
    const user = userEvent.setup();
    const jobs = [makeJob({ id: 'a' }), makeJob({ id: 'b' }), makeJob({ id: 'c' }), makeJob({ id: 'd' })];
    seed(jobs);
    renderPage();
    const boxes = screen.getAllByRole('checkbox', { name: /^Select Engineer/ });
    await user.click(boxes[0]);
    await user.keyboard('{Shift>}');
    await user.click(boxes[2]);
    await user.keyboard('{/Shift}');
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: /Mark applied/ }));
    expect(actions.optimisticMarkJobsApplied).toHaveBeenCalledWith(['a', 'b', 'c'], true);
    expect(actions.markJobsApplied).toHaveBeenCalledWith(['a', 'b', 'c']);
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument());
    await waitFor(() => expect(actions.bgRefreshJobs).toHaveBeenCalled());
    expect(actions.loadCounts).toHaveBeenCalled();
  });

  it('select-all toggles every row and Escape clears', async () => {
    const user = userEvent.setup();
    seed([makeJob(), makeJob(), makeJob()]);
    renderPage();
    await user.click(screen.getByRole('checkbox', { name: 'Select all jobs on this page' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
  });

  it('confirms before deleting selected jobs', async () => {
    const user = userEvent.setup();
    seed([makeJob({ id: 'a' }), makeJob({ id: 'b' })]);
    renderPage();
    await user.click(screen.getByRole('checkbox', { name: 'Select all jobs on this page' }));
    await user.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete 2 jobs?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(actions.batchDeleteJobs).toHaveBeenCalledWith(['a', 'b']));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('toggles applied from the row and offers Sheets when configured', async () => {
    const user = userEvent.setup();
    seed([makeJob({ id: 'a', title: 'Alpha' })]);
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Mark as applied' }));
    expect(actions.markJobsApplied).toHaveBeenCalledWith(['a']);
    expect(screen.getByTestId('location')).toHaveTextContent('/app/jobs');
    expect(screen.getByTestId('location')).not.toHaveTextContent('job=');
    expect(await screen.findByRole('button', { name: 'Post to Google Sheet' })).toBeInTheDocument();
  });

  it('opens the row menu with job actions', async () => {
    const user = userEvent.setup();
    seed([readyJob({ id: 'a' })]);
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Job actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Apply with Assistant/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /Re-analyze/ }));
    await waitFor(() => expect(actions.rerunJob).toHaveBeenCalledWith('a', { forceRescrape: false }));
    // Menu items live in a portal; their clicks must not bubble into the row and open details.
    expect(screen.getByTestId('location')).not.toHaveTextContent('job=');
  });

  it('right-click opens a menu scoped to the whole selection', async () => {
    const user = userEvent.setup();
    seed([makeJob({ id: 'a', title: 'Alpha' }), makeJob({ id: 'b', title: 'Beta' }), makeJob({ id: 'c', title: 'Gamma' })]);
    renderPage();
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    fireEvent.contextMenu(screen.getByText('Beta'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('2 selected jobs')).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /Delete 2 jobs/ }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete 2 jobs?');
  });

  it('right-click on an unselected row targets only that row', async () => {
    seed([makeJob({ id: 'a', title: 'Alpha' }), makeJob({ id: 'b', title: 'Beta' })]);
    renderPage();
    fireEvent.contextMenu(screen.getByText('Alpha'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Alpha')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Open details/ })).toBeInTheDocument();
  });

  it('sorts from headers, switches views, and searches with debounce', async () => {
    const user = userEvent.setup();
    seed([makeJob()]);
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Match' }));
    expect(actions.setSort).toHaveBeenCalledWith('match_score');
    await user.click(screen.getByRole('tab', { name: /Upcoming/ }));
    expect(actions.setView).toHaveBeenCalledWith('available');
    await user.type(screen.getByRole('searchbox', { name: 'Search jobs' }), 'acme');
    await waitFor(() => expect(actions.setSearchQuery).toHaveBeenCalledWith('acme'));
    await user.click(screen.getByRole('button', { name: 'Remote' }));
    expect(actions.setRemoteOnly).toHaveBeenCalledWith(true);
  });

  it('shows a filtered empty state with a reset', async () => {
    const user = userEvent.setup();
    const applyAgentDashboard = vi.fn();
    seed([], { searchQuery: 'zzz', applyAgentDashboard } as never);
    renderPage();
    expect(screen.getByText('No jobs match these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(applyAgentDashboard).toHaveBeenCalledWith(expect.objectContaining({ reset: true, view: 'all' }));
  });

  it('paginates', async () => {
    const user = userEvent.setup();
    seed([makeJob()], { total: 120, pages: 3, page: 2 } as never);
    renderPage();
    expect(screen.getByText('51–100 of 120')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(actions.setPage).toHaveBeenCalledWith(3);
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(actions.setPage).toHaveBeenCalledWith(1);
  });
});
