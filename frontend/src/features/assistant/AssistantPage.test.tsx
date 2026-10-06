import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';

const api = vi.hoisted(() => ({
  streamAgentChat: vi.fn(),
  fetchAgentTools: vi.fn(),
  listAgentSessions: vi.fn(),
  fetchAgentSession: vi.fn(),
  saveAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
}));
vi.mock('@/api/agentApi', () => api);

import { useAgentStore } from '@/stores/agentStore';
import { AssistantPage } from './AssistantPage';
import { groupSessions } from './ChatHistory';

const SAVED = '44444444-4444-4444-8444-444444444444';

function Where() {
  const loc = useLocation();
  return <output data-testid="path">{loc.pathname}</output>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/app/assistant" element={<AssistantPage />} />
            <Route path="/app/assistant/:sessionId" element={<AssistantPage />} />
            <Route path="/app/studio" element={<p>studio page</p>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const JOB_DESCRIPTION = [
  'Software Engineer III at Vaco, working with Meta.',
  'You will build and ship backend services in Python and Go, own features end to end,',
  'partner with product and design, review code, and mentor engineers on the team.',
  'Requirements: 5+ years of professional software engineering experience, strong',
  'distributed systems fundamentals, and experience with large scale data pipelines.',
].join(' ');

describe('AssistantPage', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    useAgentStore.getState().reset();
    for (const fn of Object.values(api)) fn.mockReset();
    api.saveAgentSession.mockImplementation(async (id: string) => ({
      id,
      title: 'Saved',
      item_count: 2,
      created_at: '2026-10-05T10:00:00',
      updated_at: '2026-10-05T10:00:00',
    }));
    api.streamAgentChat.mockImplementation(async (_p: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'message', text: 'Three remote roles today.' });
      onEvent({ type: 'done' });
    });
    api.fetchAgentTools.mockResolvedValue([
      {
        name: 'tailor_resume',
        label: 'Tailor resume',
        category: 'Resume and cover letter',
        description: 'Tailor the resume.',
        example: 'Tailor my resume to this job description:',
        requires_confirmation: false,
      },
      {
        name: 'search_jobs',
        label: 'Find jobs',
        category: 'Jobs',
        description: 'Look up jobs.',
        example: 'Find remote backend jobs',
        requires_confirmation: false,
      },
    ]);
    useAgentStore.setState({
      sessionsLoaded: true,
      sessions: [
        { id: SAVED, title: 'Remote roles', item_count: 2, created_at: '2026-10-05T09:00:00', updated_at: '2026-10-05T09:00:00' },
      ],
    });
  });

  it('opens a saved chat from the URL and lists it in history', async () => {
    api.fetchAgentSession.mockResolvedValue({
      id: SAVED,
      title: 'Remote roles',
      item_count: 2,
      created_at: '2026-10-05T09:00:00',
      updated_at: '2026-10-05T09:00:00',
      items: [
        { id: 'u', kind: 'user', text: 'Any remote roles?' },
        { id: 'a', kind: 'assistant', text: 'Yes, two.' },
      ],
    });
    renderAt(`/app/assistant/${SAVED}`);
    expect(await screen.findByText('Any remote roles?')).toBeInTheDocument();
    expect(screen.getByText('Yes, two.')).toBeInTheDocument();
    expect(api.fetchAgentSession).toHaveBeenCalledWith(SAVED);
    expect(screen.getAllByRole('button', { name: 'Remote roles' }).length).toBeGreaterThan(0);
  });

  it('a first message on a new chat moves the URL to the saved chat', async () => {
    renderAt('/app/assistant');
    await userEvent.type(screen.getByRole('textbox'), 'Show remote jobs{Enter}');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toMatch(/^\/app\/assistant\/[0-9a-f-]{36}$/));
    expect(await screen.findByText('Three remote roles today.')).toBeInTheDocument();
    const id = screen.getByTestId('path').textContent!.split('/').pop()!;
    await waitFor(() => expect(api.saveAgentSession).toHaveBeenCalledWith(id, expect.any(Array)));
  });

  it('New chat goes back to an empty chat without deleting the old one', async () => {
    api.fetchAgentSession.mockResolvedValue({
      id: SAVED,
      title: 'Remote roles',
      item_count: 1,
      created_at: '2026-10-05T09:00:00',
      updated_at: '2026-10-05T09:00:00',
      items: [{ id: 'u', kind: 'user', text: 'Any remote roles?' }],
    });
    renderAt(`/app/assistant/${SAVED}`);
    await screen.findByText('Any remote roles?');
    await userEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0]);
    expect(screen.getByTestId('path').textContent).toBe('/app/assistant');
    expect(screen.getByText('What should we work on?')).toBeInTheDocument();
    expect(api.deleteAgentSession).not.toHaveBeenCalled();
  });

  it('picking a tool pins it to the composer and sends the message to that tool', async () => {
    const user = userEvent.setup();
    renderAt('/app/assistant');
    await user.click(screen.getByRole('button', { name: 'Tools' }));
    expect(await screen.findByText('Jobs')).toBeInTheDocument();
    expect(screen.getAllByText('Tailor resume')).toHaveLength(1);
    await user.click(screen.getByRole('menuitem', { name: /Find jobs/ }));
    expect(screen.getByRole('button', { name: 'Remove Find jobs' })).toBeInTheDocument();
    const box = screen.getByRole('textbox');
    expect(box).toHaveAttribute('placeholder', 'For example: Find remote backend jobs');
    await user.type(box, 'remote python roles{Enter}');
    await waitFor(() => expect(api.streamAgentChat).toHaveBeenCalled());
    const payload = api.streamAgentChat.mock.calls[0][0];
    expect(payload.tool).toBe('search_jobs');
    expect(payload.confirmed).toBeNull();
    expect(payload.message).toBe('remote python roles');
  });

  it('shows a step checklist with elapsed time while tailoring runs', async () => {
    let finish: () => void = () => undefined;
    api.streamAgentChat.mockImplementation(
      (_p: unknown, onEvent: (e: unknown) => void) =>
        new Promise<void>((resolve) => {
          onEvent({ type: 'tool_call', tool: 'tailor_resume', title: 'Tailoring your resume', args: {} });
          onEvent({
            type: 'progress',
            tool: 'tailor_resume',
            label: 'Writing your tailored resume',
            expected_seconds: 90,
            steps: [
              { id: 'read', label: 'Reading the job description', status: 'done' },
              { id: 'resume', label: 'Writing your tailored resume', status: 'active' },
              { id: 'save', label: 'Saving to Documents', status: 'pending' },
            ],
          });
          finish = resolve;
        }),
    );
    renderAt('/app/assistant');
    await userEvent.type(screen.getByRole('textbox'), 'tailor it{Enter}');
    expect(await screen.findByRole('progressbar', { name: '1 of 3 steps done' })).toBeInTheDocument();
    expect(screen.getByText('Saving to Documents')).toBeInTheDocument();
    expect(screen.getByText(/of about 1m 30s/)).toBeInTheDocument();
    finish();
  });

  it('a Tailor resume block runs the tool on a pasted job description and shows the saved resume', async () => {
    api.streamAgentChat.mockImplementation(async (_p: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'tool_call', tool: 'tailor_resume', title: 'Tailoring your resume', args: {} });
      onEvent({ type: 'progress', tool: 'tailor_resume', label: 'Writing tailored content' });
      onEvent({
        type: 'tool_result',
        tool: 'tailor_resume',
        ok: true,
        summary: 'Saved',
        data: {
          document: {
            resume_id: 'r1',
            name: 'Vaco Software Engineer III',
            job_title: 'Software Engineer III',
            company: 'Vaco',
            has_cover_letter: false,
            match_score: 78,
          },
        },
      });
      onEvent({ type: 'message', text: 'Your tailored resume is ready.' });
      onEvent({ type: 'done' });
    });
    const user = userEvent.setup();
    renderAt('/app/assistant');
    await user.click(screen.getByRole('button', { name: 'Tools' }));
    await user.click(await screen.findByRole('menuitem', { name: /Tailor resume/ }));
    expect(screen.getByRole('button', { name: 'Remove Tailor resume' })).toBeInTheDocument();

    const box = screen.getByRole('textbox');
    await user.click(box);
    await user.paste('Too short');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.clear(box);
    await user.paste(JOB_DESCRIPTION);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(api.streamAgentChat).toHaveBeenCalled());
    const payload = api.streamAgentChat.mock.calls[0][0];
    expect(payload.confirmed).toEqual({ tool: 'tailor_resume', args: { include_cover_letter: false } });
    expect(payload.message).toBe(`Tailor my resume to this job description.\n\n${JOB_DESCRIPTION}`);
    expect(await screen.findByText('Vaco Software Engineer III')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume PDF/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cover letter PDF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Tailor resume' })).not.toBeInTheDocument();
  });

  it('Backspace on an empty draft removes the picked block', async () => {
    const user = userEvent.setup();
    renderAt('/app/assistant');
    await user.click(screen.getByRole('button', { name: 'Tools' }));
    await user.click(await screen.findByRole('menuitem', { name: /Resume \+ cover letter/ }));
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('button', { name: /Remove Resume/ })).not.toBeInTheDocument();
  });

  it('says so when a chat no longer exists', async () => {
    api.fetchAgentSession.mockRejectedValue({ response: { status: 404 } });
    renderAt('/app/assistant/55555555-5555-4555-8555-555555555555');
    expect(await screen.findByText('This chat no longer exists')).toBeInTheDocument();
  });
});

describe('groupSessions', () => {
  it('groups chats by how recently they were used', () => {
    const now = new Date(2026, 9, 5, 12, 0, 0);
    const at = (d: Date) => d.toISOString().replace('Z', '');
    const mk = (id: string, d: Date) => ({ id, title: id, item_count: 1, created_at: at(d), updated_at: at(d) });
    const groups = groupSessions(
      [
        mk('today', new Date(2026, 9, 5, 9)),
        mk('yesterday', new Date(2026, 9, 4, 9)),
        mk('week', new Date(2026, 9, 1, 9)),
        mk('old', new Date(2026, 5, 1, 9)),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      ['Previous 7 days', ['week']],
      ['Older', ['old']],
    ]);
  });
});
