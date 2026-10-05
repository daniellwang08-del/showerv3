import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';

const api = vi.hoisted(() => ({
  streamAgentChat: vi.fn(),
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
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/assistant" element={<AssistantPage />} />
          <Route path="/app/assistant/:sessionId" element={<AssistantPage />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

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
