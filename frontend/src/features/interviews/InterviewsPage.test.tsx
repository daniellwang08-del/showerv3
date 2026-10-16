import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as api from '@/api/interviewsApi';
import { TooltipProvider } from '@/components/ui/tooltip';
import { stubLayout } from '../integrations/testUtils';
import { makeEvent, makeOverview, makeProcess } from './interviewsFixtures';
import { InterviewsPage } from './InterviewsPage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/api/interviewsApi', () => ({
  fetchInterviews: vi.fn(),
  startMailConnect: vi.fn(),
  disconnectMail: vi.fn(async () => undefined),
  syncInterviews: vi.fn(async () => ({ started: true })),
  createInterview: vi.fn(async () => ({ id: 'new' })),
  updateInterview: vi.fn(async () => undefined),
  deleteInterview: vi.fn(async () => undefined),
  addInterviewEvent: vi.fn(async () => ({ id: 'ev' })),
  updateInterviewEvent: vi.fn(async () => undefined),
  deleteInterviewEvent: vi.fn(async () => undefined),
}));
const mocked = vi.mocked(api);

function renderPage(path = '/app/interviews') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <InterviewsPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();

const pipeline = makeOverview({
  processes: [
    makeProcess({
      id: 'p1',
      company: 'Acme',
      stage: 'interviewing',
      events: [makeEvent({ id: 'e1', title: 'System design', scheduled_at: inTwoDays, duration_minutes: 60 })],
      next_event: makeEvent({ id: 'e1', title: 'System design', scheduled_at: inTwoDays }),
    }),
    makeProcess({
      id: 'p2',
      company: 'Globex',
      stage: 'screening',
      needs_action: true,
      events: [
        makeEvent({
          id: 'e2',
          kind: 'scheduling',
          status: 'needs_scheduling',
          title: 'Book recruiter call',
          email_date: new Date(Date.now() - 2 * 86_400_000 - 60_000).toISOString(),
        }),
      ],
    }),
    makeProcess({ id: 'p3', company: 'Initech', stage: 'rejected', status: 'closed' }),
  ],
  summary: { active: 2, upcoming_week: 1, needs_action: 1, offers: 0, closed: 1 },
});

beforeAll(stubLayout);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InterviewsPage', () => {
  it('locks the page behind the email connection', async () => {
    mocked.fetchInterviews.mockResolvedValue(makeOverview({ connection: { connected: false } }));
    const user = userEvent.setup();
    renderPage();

    const gate = await screen.findByRole('region', { name: 'Connect your email' });
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pipeline' })).not.toBeInTheDocument();

    await user.click(within(gate).getByRole('button', { name: 'Connect email' }));
    expect(mocked.startMailConnect).toHaveBeenCalled();
    expect(mocked.syncInterviews).not.toHaveBeenCalled();
  });

  it('disables connecting when the server has no mail credentials', async () => {
    mocked.fetchInterviews.mockResolvedValue(
      makeOverview({ server: { server_configured: false, providers: [] }, connection: { connected: false } }),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: 'Connect email' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/isn't configured/);
  });

  it('asks to reconnect when access was revoked', async () => {
    mocked.fetchInterviews.mockResolvedValue(
      makeOverview({ connection: { connected: true, email: 'me@example.com', status: 'needs_reauth' } }),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: 'Reconnect email' })).toBeEnabled();
  });

  it('shows upcoming interviews, actions and the board once connected', async () => {
    mocked.fetchInterviews.mockResolvedValue(pipeline);
    renderPage();

    const board = await screen.findByRole('region', { name: 'Pipeline' });
    expect(within(board).getByRole('region', { name: 'Interviewing column' })).toHaveTextContent('Acme');
    expect(within(board).getByRole('region', { name: 'Screening column' })).toHaveTextContent('Globex');
    expect(within(board).getByRole('button', { name: /closed processes \(1\)/i })).toBeInTheDocument();

    expect(screen.getByRole('region', { name: 'Upcoming interviews' })).toHaveTextContent('Acme · System design');
    const actions = screen.getByRole('region', { name: 'Needs your action' });
    expect(actions).toHaveTextContent('Pick a time');
    expect(actions).toHaveTextContent('2 days ago');
    const syncButton = screen.getByRole('button', { name: 'Sync now, last synced just now' });
    expect(syncButton).toHaveTextContent('Sync now· synced just now');
    expect(screen.getByText('Interviews this week')).toBeInTheDocument();
    expect(mocked.syncInterviews).not.toHaveBeenCalled();
  });

  it('syncs automatically when the last sync is stale and on demand', async () => {
    mocked.fetchInterviews.mockResolvedValue(
      makeOverview({
        ...pipeline,
        connection: { ...pipeline.connection, last_synced_at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(mocked.syncInterviews).toHaveBeenCalledTimes(1));
    expect(mocked.syncInterviews.mock.calls[0][0]).toEqual(expect.any(String));
    await user.click(await screen.findByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(mocked.syncInterviews).toHaveBeenCalledTimes(2));
  });

  it('starts the first sync after returning from the provider', async () => {
    mocked.fetchInterviews.mockResolvedValue(makeOverview({ connection: { ...makeOverview().connection, last_synced_at: null } }));
    renderPage('/app/interviews?mail=connected');
    await waitFor(() => expect(mocked.syncInterviews).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/email connected/i));
  });

  it('reports a failed connection', async () => {
    mocked.fetchInterviews.mockResolvedValue(makeOverview({ connection: { connected: false } }));
    renderPage('/app/interviews?mail=error&reason=invalid_state');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/expired/)));
    expect(mocked.syncInterviews).not.toHaveBeenCalled();
  });

  it('opens a process and updates its stage and steps', async () => {
    mocked.fetchInterviews.mockResolvedValue(pipeline);
    const user = userEvent.setup();
    renderPage();

    const board = await screen.findByRole('region', { name: 'Pipeline' });
    await user.click(within(board).getByRole('button', { name: 'Acme, Engineer' }));

    const stage = await screen.findByLabelText('Stage');
    await user.selectOptions(stage, 'final');
    await waitFor(() => expect(mocked.updateInterview).toHaveBeenCalledWith('p1', { stage: 'final' }));

    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(mocked.updateInterviewEvent).toHaveBeenCalledWith('e1', { status: 'completed' }));
  });

  it('adds a process manually', async () => {
    mocked.fetchInterviews.mockResolvedValue(pipeline);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add process' }));
    await user.type(screen.getByRole('textbox', { name: 'Company' }), 'Umbrella');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add process' }));
    await waitFor(() =>
      expect(mocked.createInterview).toHaveBeenCalledWith({
        company: 'Umbrella',
        role_title: null,
        stage: 'screening',
        notes: null,
      }),
    );
  });
});
