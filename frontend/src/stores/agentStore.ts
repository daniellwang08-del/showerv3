import { create } from 'zustand';
import {
  streamAgentChat,
  type AgentEvent,
  type AgentJobCard,
  type AgentTurnInput,
  type ConfirmedAction,
} from '../api/agentApi';
import { useScraperStore } from './scraperStore';
import { useJobsStore } from './jobsStore';
import { agentNavigate } from '../lib/agentNavigation';

// ---------------------------------------------------------------------------
// Timeline model
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'ok' | 'error';

export type TimelineItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; tool: string; title: string; status: ToolStatus; summary?: string; jobs?: AgentJobCard[] }
  | { id: string; kind: 'confirm'; tool: string; title: string; args: Record<string, unknown>; summary: string; resolved?: 'confirmed' | 'cancelled' }
  | { id: string; kind: 'error'; text: string };

interface AgentState {
  open: boolean;
  sending: boolean;
  timeline: TimelineItem[];

  openChat: () => void;
  closeChat: () => void;
  toggleChat: () => void;
  clear: () => void;
  send: (message: string) => Promise<void>;
  confirmAction: (itemId: string) => Promise<void>;
  cancelAction: (itemId: string) => void;
}

const STORAGE_KEY = 'job_scraper:agent_timeline:v1';
const MAX_PERSISTED = 60;

let _counter = 0;
const uid = () => `agent-${Date.now()}-${++_counter}`;

function loadTimeline(): TimelineItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TimelineItem[]) : [];
  } catch {
    return [];
  }
}

function persist(timeline: TimelineItem[]) {
  try {
    // Drop transient "running" tool states before persisting.
    const clean = timeline
      .filter((i) => !(i.kind === 'tool' && i.status === 'running'))
      .slice(-MAX_PERSISTED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // ignore quota / serialization errors
  }
}

const tz = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

function historyFrom(timeline: TimelineItem[]): AgentTurnInput[] {
  return timeline
    .filter((i): i is Extract<TimelineItem, { kind: 'user' | 'assistant' }> =>
      i.kind === 'user' || i.kind === 'assistant',
    )
    .map((i) => ({ role: i.kind, content: i.text }));
}

function applyRefresh(targets: string[]) {
  const scraper = useScraperStore.getState();
  const jobs = useJobsStore.getState();
  if (targets.includes('jobs')) {
    scraper.loadJobs();
    void jobs.refreshLists({ showLoading: false, reset: false });
  }
  if (targets.includes('stats')) {
    void scraper.loadStats({ silent: true });
  }
  if (targets.includes('sync')) {
    void scraper.checkSyncStatus();
    scraper.loadLastSyncRuns();
  }
}

export const useAgentStore = create<AgentState>((set, get) => {
  /** Mutate the timeline, persist, and return nothing. */
  const update = (fn: (prev: TimelineItem[]) => TimelineItem[]) => {
    set((s) => {
      const timeline = fn(s.timeline);
      persist(timeline);
      return { timeline };
    });
  };

  const handleEvent = (event: AgentEvent, assistantId: string) => {
    switch (event.type) {
      case 'tool_call':
        update((prev) => [
          ...prev,
          {
            id: uid(),
            kind: 'tool',
            tool: event.tool,
            title: event.title || 'Working',
            status: 'running',
          },
        ]);
        break;

      case 'tool_result': {
        const data = event.data as { jobs?: AgentJobCard[] } | undefined;
        const jobs = Array.isArray(data?.jobs) ? data!.jobs : undefined;
        update((prev) => {
          // Update the most recent running tool row for this tool.
          const idx = [...prev]
            .map((i, n) => ({ i, n }))
            .reverse()
            .find(({ i }) => i.kind === 'tool' && i.tool === event.tool && i.status === 'running')?.n;
          if (idx == null) return prev;
          const next = [...prev];
          const row = next[idx];
          if (row.kind === 'tool') {
            next[idx] = {
              ...row,
              status: event.ok ? 'ok' : 'error',
              summary: event.summary,
              jobs,
            };
          }
          return next;
        });
        break;
      }

      case 'refresh':
        applyRefresh(event.targets || []);
        break;

      case 'ui_action':
        if (event.action === 'update_dashboard') {
          agentNavigate('/scraper');
          useScraperStore.getState().applyAgentDashboard(event.filters || {});
        }
        break;

      case 'confirm':
        update((prev) => [
          ...prev,
          {
            id: uid(),
            kind: 'confirm',
            tool: event.tool,
            title: event.title || 'Confirm action',
            args: event.args || {},
            summary: event.summary,
          },
        ]);
        break;

      case 'message':
        update((prev) =>
          prev.map((i) =>
            i.id === assistantId && i.kind === 'assistant' ? { ...i, text: event.text } : i,
          ),
        );
        break;

      case 'error':
        update((prev) => [
          ...prev.filter((i) => i.id !== assistantId),
          { id: uid(), kind: 'error', text: event.message },
        ]);
        break;

      case 'done':
      default:
        break;
    }
  };

  const runTurn = async (
    message: string,
    history: AgentTurnInput[],
    confirmed: ConfirmedAction | null,
  ) => {
    // Placeholder assistant bubble we fill from the final `message` event.
    const assistantId = uid();
    update((prev) => [...prev, { id: assistantId, kind: 'assistant', text: '' }]);
    set({ sending: true });

    try {
      await streamAgentChat(
        { message, history, timezone: tz(), confirmed },
        (event) => handleEvent(event, assistantId),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Something went wrong.';
      update((prev) => [
        ...prev.filter((i) => i.id !== assistantId),
        { id: uid(), kind: 'error', text: detail },
      ]);
    } finally {
      // Remove an empty placeholder if the turn ended without a final message.
      update((prev) =>
        prev.filter((i) => !(i.id === assistantId && i.kind === 'assistant' && !i.text.trim())),
      );
      set({ sending: false });
    }
  };

  return {
    open: false,
    sending: false,
    timeline: loadTimeline(),

    openChat: () => set({ open: true }),
    closeChat: () => set({ open: false }),
    toggleChat: () => set((s) => ({ open: !s.open })),

    clear: () => {
      persist([]);
      set({ timeline: [] });
    },

    send: async (message: string) => {
      const text = message.trim();
      if (!text || get().sending) return;
      const history = historyFrom(get().timeline);
      update((prev) => [...prev, { id: uid(), kind: 'user', text }]);
      await runTurn(text, history, null);
    },

    confirmAction: async (itemId: string) => {
      const item = get().timeline.find((i) => i.id === itemId);
      if (!item || item.kind !== 'confirm' || item.resolved || get().sending) return;
      update((prev) =>
        prev.map((i) => (i.id === itemId && i.kind === 'confirm' ? { ...i, resolved: 'confirmed' } : i)),
      );
      const history = historyFrom(get().timeline);
      await runTurn(
        `Proceed with the ${item.tool} action.`,
        history,
        { tool: item.tool, args: item.args },
      );
    },

    cancelAction: (itemId: string) => {
      update((prev) =>
        prev.map((i) =>
          i.id === itemId && i.kind === 'confirm' ? { ...i, resolved: 'cancelled' } : i,
        ),
      );
    },
  };
});
