import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  streamAgentChat: vi.fn(),
  listAgentSessions: vi.fn(),
  fetchAgentSession: vi.fn(),
  saveAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
}));
vi.mock('../api/agentApi', () => api);
vi.mock('./scraperStore', () => ({ useScraperStore: { getState: () => ({}) } }));
vi.mock('./jobsStore', () => ({ useJobsStore: { getState: () => ({}) } }));
vi.mock('../lib/agentNavigation', () => ({ agentNavigate: vi.fn() }));

import { useAgentStore, type TimelineItem } from './agentStore';

type Event = { type: string; [k: string]: unknown };

function summary(id: string, title = 'Chat', updated_at = '2026-10-05T10:00:00') {
  return { id, title, item_count: 2, created_at: updated_at, updated_at };
}

/** A turn whose reply is released by calling the returned function. */
function deferredTurn(reply: string) {
  let release!: () => void;
  api.streamAgentChat.mockImplementationOnce(
    (_payload: unknown, onEvent: (e: Event) => void) =>
      new Promise<void>((resolve) => {
        release = () => {
          onEvent({ type: 'message', text: reply });
          onEvent({ type: 'done' });
          resolve();
        };
      }),
  );
  return () => release();
}

const lastSave = (id: string) => {
  const calls = api.saveAgentSession.mock.calls.filter((c) => c[0] === id);
  return calls[calls.length - 1]?.[1] as TimelineItem[] | undefined;
};

describe('agentStore saved chats', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.getState().reset();
    for (const fn of Object.values(api)) fn.mockReset();
    api.listAgentSessions.mockResolvedValue([]);
    api.saveAgentSession.mockImplementation(async (id: string, items: TimelineItem[]) => ({
      ...summary(id, 'Saved'),
      item_count: items.length,
    }));
    api.streamAgentChat.mockImplementation(async (_p: unknown, onEvent: (e: Event) => void) => {
      onEvent({ type: 'message', text: 'Here you go.' });
      onEvent({ type: 'done' });
    });
  });

  afterEach(() => {
    useAgentStore.getState().reset();
  });

  it('saves a new chat to the server once the reply arrives', async () => {
    await useAgentStore.getState().send('Which jobs match me best?');
    const { sessionId, timeline, sessions } = useAgentStore.getState();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(timeline.map((i) => i.kind)).toEqual(['user', 'assistant']);
    const saved = lastSave(sessionId!);
    expect(saved?.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(sessions[0].id).toBe(sessionId);
  });

  it('starting a new chat keeps the earlier one in history', async () => {
    await useAgentStore.getState().send('First question');
    const first = useAgentStore.getState().sessionId;
    useAgentStore.getState().clear();
    expect(useAgentStore.getState().timeline).toEqual([]);
    expect(api.deleteAgentSession).not.toHaveBeenCalled();
    await useAgentStore.getState().send('Second question');
    const second = useAgentStore.getState().sessionId;
    expect(second).not.toBe(first);
    expect(useAgentStore.getState().sessions.map((s) => s.id)).toEqual([second, first]);
  });

  it('startChat returns the new id before the reply streams', async () => {
    const release = deferredTurn('Done.');
    const id = useAgentStore.getState().startChat('Show remote jobs');
    expect(useAgentStore.getState().sessionId).toBe(id);
    expect(useAgentStore.getState().timeline[0]).toMatchObject({ kind: 'user', text: 'Show remote jobs' });
    release();
    await vi.waitFor(() => expect(lastSave(id)?.length).toBe(2));
  });

  it('a reply that finishes after switching chats is saved to its own chat', async () => {
    api.fetchAgentSession.mockResolvedValue({
      ...summary('11111111-1111-4111-8111-111111111111'),
      items: [{ id: 'old', kind: 'user', text: 'Older chat' }],
    });
    const release = deferredTurn('Late answer');
    const id = useAgentStore.getState().startChat('Slow question');
    await useAgentStore.getState().openSession('11111111-1111-4111-8111-111111111111');
    release();
    await vi.waitFor(() => expect(useAgentStore.getState().sending).toBe(false));
    expect(useAgentStore.getState().timeline).toEqual([{ id: 'old', kind: 'user', text: 'Older chat' }]);
    await vi.waitFor(() =>
      expect(lastSave(id)?.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Late answer' }),
    );
  });

  it('uploads the old single local chat once and removes the local copy', async () => {
    localStorage.setItem(
      'job_scraper:agent_timeline:v1',
      JSON.stringify([
        { id: 'a', kind: 'user', text: 'Old question' },
        { id: 'b', kind: 'assistant', text: 'Old answer' },
        { id: 'c', kind: 'tool', tool: 'x', title: 'x', status: 'running' },
      ]),
    );
    await useAgentStore.getState().init('user-1');
    expect(api.saveAgentSession).toHaveBeenCalledTimes(1);
    expect((api.saveAgentSession.mock.calls[0][1] as TimelineItem[]).map((i) => i.id)).toEqual(['a', 'b']);
    expect(localStorage.getItem('job_scraper:agent_timeline:v1')).toBeNull();
    expect(useAgentStore.getState().timeline).toHaveLength(2);
  });

  it('restores the last open chat for the same account', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    localStorage.setItem(`job_scraper:agent_active:v1:user-1`, id);
    api.listAgentSessions.mockResolvedValue([summary(id, 'Remote roles')]);
    api.fetchAgentSession.mockResolvedValue({
      ...summary(id, 'Remote roles'),
      items: [{ id: 'q', kind: 'user', text: 'Remote roles?' }],
    });
    await useAgentStore.getState().init('user-1');
    expect(useAgentStore.getState().sessionId).toBe(id);
    expect(useAgentStore.getState().timeline).toHaveLength(1);
  });

  it('marks a chat that is gone as not found', async () => {
    api.fetchAgentSession.mockRejectedValue({ response: { status: 404 } });
    await useAgentStore.getState().openSession('33333333-3333-4333-8333-333333333333');
    expect(useAgentStore.getState().sessionLoad).toBe('not_found');
  });

  it('deleting the open chat removes it and shows a new chat', async () => {
    await useAgentStore.getState().send('To be deleted');
    const id = useAgentStore.getState().sessionId!;
    api.deleteAgentSession.mockResolvedValue(undefined);
    await useAgentStore.getState().deleteSession(id);
    expect(api.deleteAgentSession).toHaveBeenCalledWith(id);
    expect(useAgentStore.getState().sessionId).toBeNull();
    expect(useAgentStore.getState().sessions.find((s) => s.id === id)).toBeUndefined();
  });

  it('flags a failed save so the page can say so', async () => {
    api.saveAgentSession.mockRejectedValue(new Error('offline'));
    await useAgentStore.getState().send('Hello');
    expect(useAgentStore.getState().saveFailed).toBe(true);
  });
});
