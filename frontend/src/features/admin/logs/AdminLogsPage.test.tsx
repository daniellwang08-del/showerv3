import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SystemLogEvent, SystemLogListResponse, SystemLogStats } from '@/types/systemLogs';
import * as api from '@/api/systemLogsApi';
import { AdminLogsPage } from './AdminLogsPage';

vi.mock('@/api/systemLogsApi', () => ({
  fetchSystemLogs: vi.fn(),
  fetchSystemLogStats: vi.fn(),
  fetchRequestTimeline: vi.fn(),
  fetchJobLogTimeline: vi.fn(),
  purgeSystemLogs: vi.fn(),
}));

const m = vi.mocked(api);

function ev(over: Partial<SystemLogEvent> = {}): SystemLogEvent {
  return {
    id: 'e1',
    created_at: '2026-10-03T10:00:00Z',
    level: 'info',
    event: 'http_request_completed',
    category: 'http',
    service: 'api',
    request_id: 'req-12345678-abcd',
    method: 'GET',
    path: '/api/v1/jobs',
    status_code: 200,
    duration_ms: 42,
    message: null,
    payload: null,
    ...over,
  };
}

function listOf(items: SystemLogEvent[], over: Partial<SystemLogListResponse> = {}): SystemLogListResponse {
  return { items, total: items.length, page: 1, per_page: 50, pages: 1, ...over };
}

const stats: SystemLogStats = {
  window_hours: 24,
  total: 1234,
  by_level: { info: 1200, error: 34 },
  by_category: { http: 1000, worker: 200 },
  by_service: { api: 1000, analysis: 234 },
  error_rate: 2.8,
  top_paths: [],
  retention_days: 14,
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage({ url = '/admin/logs', standalone = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <AdminLogsPage standalone={standalone} />
          <LocationProbe />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const rows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-log-id'));
const lastListCall = () => m.fetchSystemLogs.mock.calls.at(-1)?.[0];

describe('AdminLogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.fetchSystemLogs.mockResolvedValue(
      listOf([
        ev(),
        ev({ id: 'e2', level: 'error', event: 'job_match_failed', service: 'analysis', message: 'LLM timeout', method: null, path: null, status_code: null, request_id: null, job_id: 'job-9' }),
      ]),
    );
    m.fetchSystemLogStats.mockResolvedValue(stats);
    m.fetchRequestTimeline.mockResolvedValue([ev(), ev({ id: 'e3', event: 'http_request_started' })]);
    m.fetchJobLogTimeline.mockResolvedValue([]);
    m.purgeSystemLogs.mockResolvedValue({ deleted: 7 });
  });

  it('renders rows, level badges and stats', async () => {
    renderPage();
    expect(screen.getAllByTestId('log-row-skeleton').length).toBeGreaterThan(0);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByText('http_request_completed')).toBeInTheDocument();
    expect(screen.getByText('GET /api/v1/jobs → 200')).toBeInTheDocument();
    expect(screen.getByText('LLM timeout')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('error')).toHaveAttribute('data-level', 'error');
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('2.8%')).toBeInTheDocument();
    expect(lastListCall()).toEqual(expect.objectContaining({ page: 1, per_page: 50, hours: 24 }));
    expect(m.fetchSystemLogStats).toHaveBeenCalledWith(24);
  });

  it('hydrates filters from the URL', async () => {
    renderPage({ url: '/admin/logs?level=warning&service=api&event=timing&hours=72&page=2&per=20' });
    await waitFor(() =>
      expect(lastListCall()).toEqual(
        expect.objectContaining({ level: 'warning', service: 'api', event_contains: 'timing', hours: 72, page: 2, per_page: 20 }),
      ),
    );
    expect(screen.getByLabelText('Event contains')).toHaveValue('timing');
  });

  it('sends a select filter to the API and mirrors it in the URL', async () => {
    const user = userEvent.setup();
    renderPage({ url: '/admin/logs?page=3' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(screen.getByRole('combobox', { name: 'Level' }));
    await user.click(await screen.findByRole('option', { name: 'error' }));
    await waitFor(() => expect(lastListCall()).toEqual(expect.objectContaining({ level: 'error', page: 1 })));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/logs\?level=error$/);
  });

  it('commits text filters on Enter / Apply and clears them', async () => {
    const user = userEvent.setup();
    renderPage({ url: '/admin/logs?level=error' });
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.type(screen.getByLabelText('Event contains'), 'match{Enter}');
    await waitFor(() => expect(lastListCall()).toEqual(expect.objectContaining({ level: 'error', event_contains: 'match' })));
    await user.type(screen.getByLabelText('User ID'), 'u-1');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(lastListCall()).toEqual(expect.objectContaining({ user_id: 'u-1' })));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/logs?level=error&event=match&user=u-1');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/logs$/));
    expect(screen.getByLabelText('Event contains')).toHaveValue('');
  });

  it('filters by service chip and paginates', async () => {
    const user = userEvent.setup();
    m.fetchSystemLogs.mockResolvedValue(listOf([ev()], { total: 120, pages: 3 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^analysis/ }));
    await waitFor(() => expect(lastListCall()).toEqual(expect.objectContaining({ service: 'analysis' })));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastListCall()).toEqual(expect.objectContaining({ service: 'analysis', page: 2 })));
    expect(screen.getByTestId('location')).toHaveTextContent('page=2');
  });

  it('opens the full record in a sheet with pretty JSON and copy', async () => {
    const user = userEvent.setup();
    m.fetchSystemLogs.mockResolvedValue(listOf([ev({ payload: { attempt: 2, model: 'gpt' } })]));
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(rows()[0]);

    const sheet = await screen.findByRole('dialog');
    const json = within(sheet).getByTestId('log-json');
    expect(json.textContent).toContain('"attempt": 2');
    expect(JSON.parse(json.textContent!)).toEqual(expect.objectContaining({ id: 'e1', path: '/api/v1/jobs' }));

    await user.click(within(sheet).getByRole('button', { name: /Copy JSON/ }));
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual(expect.objectContaining({ id: 'e1' }));
    expect(await within(sheet).findByRole('button', { name: /Copied/ })).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: /View full request timeline/ }));
    expect(m.fetchRequestTimeline).toHaveBeenCalledWith('req-12345678-abcd');
    expect(await within(sheet).findByText('http_request_started')).toBeInTheDocument();
  });

  it('opens a request timeline straight from the row', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: /Open request timeline/ }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Request timeline')).toBeInTheDocument();
    expect(await within(sheet).findByText('http_request_started')).toBeInTheDocument();
  });

  it('confirms before purging old logs', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const before = m.fetchSystemLogs.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /Purge old/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/older than the retention window \(14 days\)/)).toBeInTheDocument();
    expect(m.purgeSystemLogs).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Purge' }));
    await waitFor(() => expect(m.purgeSystemLogs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(m.fetchSystemLogs.mock.calls.length).toBeGreaterThan(before));
  });

  it('cancelling the purge dialog does nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Purge old/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(m.purgeSystemLogs).not.toHaveBeenCalled();
  });

  it('shows a filtered empty state that clears filters', async () => {
    const user = userEvent.setup();
    m.fetchSystemLogs.mockResolvedValue(listOf([]));
    renderPage({ url: '/admin/logs?level=critical' });
    expect(await screen.findByText('No log events match these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/logs$/));
    expect(await screen.findByText('No log events yet')).toBeInTheDocument();
  });

  it('shows an inline error with Retry', async () => {
    const user = userEvent.setup();
    m.fetchSystemLogs.mockRejectedValueOnce({ response: { data: { detail: 'Admin only' } } });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Admin only');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders standalone with its own full-height frame and title', async () => {
    renderPage({ standalone: true });
    const frame = screen.getByTestId('logs-standalone');
    expect(frame).toHaveClass('h-dvh', 'bg-background');
    expect(within(frame).getByRole('heading', { name: 'NAO system logs' })).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});
