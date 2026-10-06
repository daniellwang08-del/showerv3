import { create } from 'zustand';
import {
  deleteAgentSession,
  fetchAgentSession,
  listAgentSessions,
  renameAgentSession,
  saveAgentSession,
  streamAgentChat,
  type AgentDocumentResult,
  type AgentEvent,
  type AgentJobCard,
  type AgentSessionSummary,
  type AgentTurnInput,
  type ConfirmedAction,
  type ProgressStep,
} from '../api/agentApi';
import { useScraperStore, type AgentDashboardSnapshot } from './scraperStore';
import { useJobsStore } from './jobsStore';
import { useResumeBuilderStore } from './resumeBuilderStore';
import { agentNavigate } from '../lib/agentNavigation';

// ---------------------------------------------------------------------------
// Timeline model
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'ok' | 'error';

export type AgentDiscardAction =
  | { kind: 'dashboard'; snapshot: AgentDashboardSnapshot }
  | { kind: 'applied'; jobIds: string[]; wasApplied: boolean }
  | { kind: 'submit_job'; jobId: string };

export type TimelineItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | {
      id: string;
      kind: 'tool';
      tool: string;
      title: string;
      status: ToolStatus;
      /** Latest step reported by a long-running tool. */
      progress?: string;
      /** Checklist reported by a long-running tool (tailoring). */
      steps?: ProgressStep[];
      expectedSeconds?: number;
      startedAt?: number;
      finishedAt?: number;
      summary?: string;
      jobs?: AgentJobCard[];
      document?: AgentDocumentResult;
      args?: Record<string, unknown>;
      discard?: AgentDiscardAction;
      discarded?: boolean;
    }
  | { id: string; kind: 'confirm'; tool: string; title: string; args: Record<string, unknown>; summary: string; resolved?: 'confirmed' | 'cancelled' }
  | { id: string; kind: 'error'; text: string };

export type SessionLoad = 'idle' | 'loading' | 'not_found' | 'error';

/** `tool` runs that tool directly; `selectedTool` asks the planner to act with it. */
export type SendOptions = { tool?: ConfirmedAction; selectedTool?: string };

interface AgentState {
  open: boolean;
  /** A reply is streaming. Only one turn runs at a time, possibly in a chat that is not open. */
  sending: boolean;
  sendingSessionId: string | null;
  /** Chat currently shown. null means a new chat that has no messages yet. */
  sessionId: string | null;
  timeline: TimelineItem[];
  sessions: AgentSessionSummary[];
  sessionsLoaded: boolean;
  sessionLoad: SessionLoad;
  saveFailed: boolean;

  openChat: () => void;
  closeChat: () => void;
  toggleChat: () => void;
  /** Load saved chats for this account and restore the last open one. */
  init: (userId: string) => Promise<void>;
  /** Forget everything in memory (account switch or sign-out). Saved chats stay on the server. */
  reset: (opts?: { dropLegacy?: boolean }) => void;
  loadSessions: () => Promise<void>;
  /** Start a fresh chat. Earlier chats stay saved. */
  clear: () => void;
  openSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /**
   * Start a new chat with `message` and return its id (for navigation).
   * `tool` runs that tool directly for this turn (a prompt block the user picked).
   */
  startChat: (message: string, opts?: SendOptions) => string;
  send: (message: string, opts?: SendOptions) => Promise<void>;
  confirmAction: (itemId: string) => Promise<void>;
  cancelAction: (itemId: string) => void;
  discardAction: (itemId: string) => Promise<void>;
}

/** Pre-session builds kept a single timeline here; it is uploaded once as a saved chat. */
const LEGACY_STORAGE_KEY = 'job_scraper:agent_timeline:v1';
const ACTIVE_KEY_PREFIX = 'job_scraper:agent_active:v1:';
const SAVE_DELAY_MS = 600;
const TITLE_CHARS = 80;

let _counter = 0;
const uid = () => `agent-${Date.now()}-${++_counter}`;

export function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 3).trimEnd()}...` : t || 'New chat';
}

function loadLegacyTimeline(): TimelineItem[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TimelineItem[]) : [];
  } catch {
    return [];
  }
}

function dropLegacyTimeline() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readActive(userId: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY_PREFIX + userId);
  } catch {
    return null;
  }
}

function writeActive(userId: string | null, sessionId: string | null) {
  if (!userId) return;
  try {
    if (sessionId) localStorage.setItem(ACTIVE_KEY_PREFIX + userId, sessionId);
    else localStorage.removeItem(ACTIVE_KEY_PREFIX + userId);
  } catch {
    // ignore
  }
}

/** What gets saved: no spinners that would never finish, no empty reply placeholders. */
export function persistableItems(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.filter(
    (i) => !(i.kind === 'tool' && i.status === 'running') && !(i.kind === 'assistant' && !i.text.trim()),
  );
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
      (i.kind === 'user' || i.kind === 'assistant') && !!i.text.trim(),
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
  if (targets.includes('documents')) {
    void useResumeBuilderStore.getState().loadResumes();
  }
}

function discardForTool(
  tool: string,
  ok: boolean,
  args: Record<string, unknown> | undefined,
  data: unknown,
): AgentDiscardAction | undefined {
  if (!ok) return undefined;

  if (tool === 'set_applied' && args) {
    const raw = args.job_ids;
    const jobIds = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
    if (jobIds.length === 0) return undefined;
    const wasApplied = args.applied !== false;
    return { kind: 'applied', jobIds, wasApplied };
  }

  if (tool === 'submit_job') {
    const d = data as { job_id?: string | null; duplicate_job_id?: string | null } | undefined;
    const jobId = d?.job_id || d?.duplicate_job_id;
    if (jobId) return { kind: 'submit_job', jobId: String(jobId) };
  }

  return undefined;
}

function attachDashboardDiscard(prev: TimelineItem[], snapshot: AgentDashboardSnapshot): TimelineItem[] {
  const idx = [...prev]
    .map((i, n) => ({ i, n }))
    .reverse()
    .find(({ i }) => i.kind === 'tool' && i.tool === 'update_dashboard' && i.status === 'ok')?.n;
  if (idx == null) return prev;
  const next = [...prev];
  const row = next[idx];
  if (row.kind !== 'tool' || row.discarded) return prev;
  next[idx] = { ...row, discard: { kind: 'dashboard', snapshot } };
  return next;
}

function upsertSummary(list: AgentSessionSummary[], summary: AgentSessionSummary): AgentSessionSummary[] {
  return [summary, ...list.filter((s) => s.id !== summary.id)];
}

export const useAgentStore = create<AgentState>((set, get) => {
  let owner: string | null = null;
  /** Latest timeline per chat touched in this tab, including a chat whose reply is still streaming in the background. */
  const buffers = new Map<string, TimelineItem[]>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const saveChains = new Map<string, Promise<void>>();
  let generation = 0;

  const flushSave = (sid: string) => {
    const timer = saveTimers.get(sid);
    if (timer) clearTimeout(timer);
    saveTimers.delete(sid);
    const gen = generation;
    const prev = saveChains.get(sid) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (gen !== generation) return;
      const items = persistableItems(buffers.get(sid) ?? []);
      if (!items.length) return;
      try {
        const summary = await saveAgentSession(sid, items);
        if (gen !== generation) return;
        set((s) => ({ sessions: upsertSummary(s.sessions, summary), saveFailed: false }));
      } catch {
        if (gen === generation) set({ saveFailed: true });
      }
    });
    saveChains.set(sid, next);
    return next;
  };

  const scheduleSave = (sid: string) => {
    const timer = saveTimers.get(sid);
    if (timer) clearTimeout(timer);
    saveTimers.set(
      sid,
      setTimeout(() => void flushSave(sid), SAVE_DELAY_MS),
    );
  };

  /** Mutate one chat's timeline; it is shown if it is the open chat, and saved either way. */
  const update = (sid: string, fn: (prev: TimelineItem[]) => TimelineItem[]) => {
    const next = fn(buffers.get(sid) ?? []);
    buffers.set(sid, next);
    if (get().sessionId === sid) set({ timeline: next });
    scheduleSave(sid);
  };

  /** The user picked a chat (or a new one) since init started, so don't restore the last open chat over it. */
  let chosen = false;

  const show = (sid: string | null, timeline: TimelineItem[], sessionLoad: SessionLoad = 'idle') => {
    chosen = true;
    set({ sessionId: sid, timeline, sessionLoad });
    writeActive(owner, sid);
  };

  const handleEvent = (event: AgentEvent, sid: string, assistantId: string) => {
    switch (event.type) {
      case 'tool_call':
        update(sid, (prev) => [
          ...prev,
          {
            id: uid(),
            kind: 'tool',
            tool: event.tool,
            title: event.title || 'Working',
            status: 'running',
            args: event.args,
            startedAt: Date.now(),
          },
        ]);
        break;

      case 'progress':
        update(sid, (prev) => {
          const idx = [...prev]
            .map((i, n) => ({ i, n }))
            .reverse()
            .find(({ i }) => i.kind === 'tool' && i.tool === event.tool && i.status === 'running')?.n;
          if (idx == null || !event.label) return prev;
          const next = [...prev];
          const row = next[idx];
          if (row.kind === 'tool') {
            next[idx] = {
              ...row,
              progress: event.label,
              ...(Array.isArray(event.steps) ? { steps: event.steps } : {}),
              ...(typeof event.expected_seconds === 'number' ? { expectedSeconds: event.expected_seconds } : {}),
            };
          }
          return next;
        });
        break;

      case 'tool_result': {
        const data = event.data as { jobs?: AgentJobCard[]; document?: AgentDocumentResult } | undefined;
        const jobs = Array.isArray(data?.jobs) ? data!.jobs : undefined;
        const savedDoc = event.ok && data?.document?.resume_id ? data.document : undefined;
        update(sid, (prev) => {
          // Update the most recent running tool row for this tool.
          const idx = [...prev]
            .map((i, n) => ({ i, n }))
            .reverse()
            .find(({ i }) => i.kind === 'tool' && i.tool === event.tool && i.status === 'running')?.n;
          if (idx == null) return prev;
          const next = [...prev];
          const row = next[idx];
          if (row.kind === 'tool') {
            const discard = discardForTool(event.tool, event.ok, row.args, event.data);
            next[idx] = {
              ...row,
              progress: undefined,
              status: event.ok ? 'ok' : 'error',
              finishedAt: Date.now(),
              summary: event.summary,
              jobs,
              ...(savedDoc ? { document: savedDoc } : {}),
              ...(discard ? { discard } : {}),
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
          const scraper = useScraperStore.getState();
          const snapshot = scraper.captureAgentDashboardSnapshot();
          agentNavigate('/app/jobs');
          scraper.applyAgentDashboard(event.filters || {});
          update(sid, (prev) => attachDashboardDiscard(prev, snapshot));
        }
        break;

      case 'confirm':
        update(sid, (prev) => [
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
        update(sid, (prev) =>
          prev.map((i) =>
            i.id === assistantId && i.kind === 'assistant' ? { ...i, text: event.text } : i,
          ),
        );
        break;

      case 'error':
        update(sid, (prev) => [
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
    sid: string,
    message: string,
    history: AgentTurnInput[],
    confirmed: ConfirmedAction | null,
    selectedTool?: string,
  ) => {
    // Placeholder assistant bubble we fill from the final `message` event.
    const assistantId = uid();
    update(sid, (prev) => [...prev, { id: assistantId, kind: 'assistant', text: '' }]);
    set({ sending: true, sendingSessionId: sid });

    try {
      await streamAgentChat(
        { message, history, timezone: tz(), confirmed, ...(selectedTool ? { tool: selectedTool } : {}) },
        (event) => handleEvent(event, sid, assistantId),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Something went wrong.';
      update(sid, (prev) => [
        ...prev.filter((i) => i.id !== assistantId),
        { id: uid(), kind: 'error', text: detail },
      ]);
    } finally {
      // Remove an empty placeholder if the turn ended without a final message.
      update(sid, (prev) =>
        prev.filter((i) => !(i.id === assistantId && i.kind === 'assistant' && !i.text.trim())),
      );
      set({ sending: false, sendingSessionId: null });
      await flushSave(sid);
    }
  };

  /** Ensure the open chat has an id, creating one for a brand-new chat. */
  const ensureSession = (firstMessage: string): string => {
    const current = get().sessionId;
    if (current) return current;
    const sid = newSessionId();
    const now = new Date().toISOString();
    buffers.set(sid, []);
    show(sid, []);
    set((s) => ({
      sessions: upsertSummary(s.sessions, {
        id: sid,
        title: titleFrom(firstMessage),
        item_count: 0,
        created_at: now,
        updated_at: now,
      }),
    }));
    return sid;
  };

  const migrateLegacy = async () => {
    const legacy = persistableItems(loadLegacyTimeline());
    if (!legacy.length) {
      dropLegacyTimeline();
      return;
    }
    const sid = newSessionId();
    const gen = generation;
    try {
      const summary = await saveAgentSession(sid, legacy);
      dropLegacyTimeline();
      if (gen !== generation) return;
      buffers.set(sid, legacy);
      set((s) => ({ sessions: upsertSummary(s.sessions, summary) }));
      if (!chosen) show(sid, legacy);
    } catch {
      // Keep the local copy and try again on the next start.
    }
  };

  const doSend = async (sid: string, text: string, opts?: SendOptions) => {
    const history = historyFrom(buffers.get(sid) ?? []);
    update(sid, (prev) => [...prev, { id: uid(), kind: 'user', text }]);
    await runTurn(sid, text, history, opts?.tool ?? null, opts?.selectedTool);
  };

  return {
    open: false,
    sending: false,
    sendingSessionId: null,
    sessionId: null,
    timeline: [],
    sessions: [],
    sessionsLoaded: false,
    sessionLoad: 'idle',
    saveFailed: false,

    openChat: () => set({ open: true }),
    closeChat: () => set({ open: false }),
    toggleChat: () => set((s) => ({ open: !s.open })),

    init: async (userId: string) => {
      if (owner === userId) return;
      owner = userId;
      const active = readActive(userId);
      await get().loadSessions();
      await migrateLegacy();
      if (active && !chosen && owner === userId) await get().openSession(active);
    },

    reset: (opts) => {
      generation += 1;
      owner = null;
      chosen = false;
      buffers.clear();
      for (const t of saveTimers.values()) clearTimeout(t);
      saveTimers.clear();
      saveChains.clear();
      if (opts?.dropLegacy) dropLegacyTimeline();
      set({
        sessionId: null,
        timeline: [],
        sessions: [],
        sessionsLoaded: false,
        sessionLoad: 'idle',
        saveFailed: false,
      });
    },

    loadSessions: async () => {
      const gen = generation;
      try {
        const list = await listAgentSessions();
        if (gen !== generation) return;
        // Keep chats created in this tab that the server has not seen yet.
        const local = get().sessions.filter((s) => !list.some((l) => l.id === s.id) && buffers.has(s.id));
        set({ sessions: [...local, ...list], sessionsLoaded: true });
      } catch {
        if (gen === generation) set({ sessionsLoaded: true });
      }
    },

    clear: () => {
      show(null, []);
    },

    openSession: async (id: string) => {
      if (get().sessionId === id && get().sessionLoad !== 'error') return;
      const cached = buffers.get(id);
      if (cached) {
        show(id, cached);
        return;
      }
      show(id, [], 'loading');
      const gen = generation;
      try {
        const detail = await fetchAgentSession<TimelineItem>(id);
        if (gen !== generation || get().sessionId !== id) return;
        const items = Array.isArray(detail.items) ? detail.items : [];
        buffers.set(id, items);
        set((s) => ({ timeline: items, sessionLoad: 'idle', sessions: upsertSummary(s.sessions, detail) }));
        // Keep list order by recency rather than by last opened.
        set((s) => ({
          sessions: [...s.sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        }));
      } catch (err) {
        if (gen !== generation || get().sessionId !== id) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        set({ sessionLoad: status === 404 ? 'not_found' : 'error' });
        if (status === 404) writeActive(owner, null);
      }
    },

    deleteSession: async (id: string) => {
      try {
        await deleteAgentSession(id);
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        // Never saved (no messages reached the server): just forget it.
        if (status !== 404) throw err;
      }
      const timer = saveTimers.get(id);
      if (timer) clearTimeout(timer);
      saveTimers.delete(id);
      buffers.delete(id);
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
      if (get().sessionId === id) show(null, []);
    },

    renameSession: async (id: string, title: string) => {
      const summary = await renameAgentSession(id, title);
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? summary : x)) }));
    },

    startChat: (message: string, opts?: SendOptions) => {
      const text = message.trim();
      show(null, []);
      const sid = ensureSession(text);
      if (text && !get().sending) void doSend(sid, text, opts);
      return sid;
    },

    send: async (message: string, opts?: SendOptions) => {
      const text = message.trim();
      if (!text || get().sending) return;
      const sid = ensureSession(text);
      await doSend(sid, text, opts);
    },

    confirmAction: async (itemId: string) => {
      const sid = get().sessionId;
      const item = get().timeline.find((i) => i.id === itemId);
      if (!sid || !item || item.kind !== 'confirm' || item.resolved || get().sending) return;
      update(sid, (prev) =>
        prev.map((i) => (i.id === itemId && i.kind === 'confirm' ? { ...i, resolved: 'confirmed' } : i)),
      );
      const history = historyFrom(buffers.get(sid) ?? []);
      await runTurn(
        sid,
        `Proceed with the ${item.tool} action.`,
        history,
        { tool: item.tool, args: item.args },
      );
    },

    cancelAction: (itemId: string) => {
      const sid = get().sessionId;
      if (!sid) return;
      update(sid, (prev) =>
        prev.map((i) =>
          i.id === itemId && i.kind === 'confirm' ? { ...i, resolved: 'cancelled' } : i,
        ),
      );
    },

    discardAction: async (itemId: string) => {
      const sid = get().sessionId;
      const item = get().timeline.find((i) => i.id === itemId);
      if (!sid || !item || item.kind !== 'tool' || !item.discard || item.discarded || get().sending) return;

      const scraper = useScraperStore.getState();
      const discard = item.discard;

      try {
        if (discard.kind === 'dashboard') {
          scraper.restoreAgentDashboardSnapshot(discard.snapshot);
        } else if (discard.kind === 'applied') {
          if (discard.wasApplied) {
            await scraper.markJobsUnapplied(discard.jobIds);
          } else {
            await scraper.markJobsApplied(discard.jobIds);
          }
        } else if (discard.kind === 'submit_job') {
          await scraper.deleteJob(discard.jobId);
        }
        update(sid, (prev) =>
          prev.map((i) => (i.id === itemId && i.kind === 'tool' ? { ...i, discarded: true } : i)),
        );
      } catch {
        // Keep the discard button visible so the user can retry.
      }
    },
  };
});