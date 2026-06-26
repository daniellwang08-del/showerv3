import { API_BASE_URL } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentJobCard {
  id: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  source?: string | null;
  source_url?: string | null;
  match_overall_score?: number | null;
  applied_at?: string | null;
  extraction_status?: string | null;
  is_remote?: boolean | null;
  user_status?: string | null;
  posted_date?: string | null;
}

export interface AgentDashboardFilters {
  view?: 'all' | 'today' | 'mine' | 'suggested';
  remote_only?: boolean;
  source?: string;
  query?: string;
  title?: string;
  company?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  reset?: boolean;
}

export type AgentEvent =
  | { type: 'tool_call'; tool: string; title?: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string; data?: unknown }
  | { type: 'refresh'; targets: string[] }
  | { type: 'ui_action'; action: string; filters?: AgentDashboardFilters; summary?: string }
  | { type: 'confirm'; tool: string; title?: string; args?: Record<string, unknown>; summary: string }
  | { type: 'message'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentTurnInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConfirmedAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentChatPayload {
  message: string;
  history: AgentTurnInput[];
  timezone?: string | null;
  confirmed?: ConfirmedAction | null;
}

// ---------------------------------------------------------------------------
// SSE-over-fetch client
//
// EventSource cannot POST, and the API is cookie-authenticated, so we stream the
// response body manually and parse `data: {json}\n\n` frames.
// ---------------------------------------------------------------------------

function parseFrame(frame: string): AgentEvent | null {
  const line = frame
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'));
  if (!line) return null;
  const json = line.slice('data:'.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json) as AgentEvent;
  } catch {
    return null;
  }
}

export async function streamAgentChat(
  payload: AgentChatPayload,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = 'The assistant is unavailable.';
    try {
      const data = await res.json();
      if (data?.detail) detail = String(data.detail);
    } catch {
      // ignore
    }
    onEvent({ type: 'error', message: detail });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseFrame(frame);
      if (event) onEvent(event);
    }
  }

  // Flush any trailing frame without a terminating blank line.
  const tail = parseFrame(buffer);
  if (tail) onEvent(tail);
}
