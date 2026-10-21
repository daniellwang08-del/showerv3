import { API_BASE_URL, apiClient } from './client';
import type { ResumeContent } from '@/types/resumeDesign';
import { queryClient } from '@/lib/queryClient';
import { STORE_KEY } from '@/features/plans/storeModel';

export type ResumeAiChatRole = 'user' | 'assistant';

export interface ResumeAiChatMessage {
  role: ResumeAiChatRole;
  content: string;
}

export interface ResumeAiMatch {
  overall_score: number;
  recommendation: string;
  summary: string;
  strengths: string[];
  gaps: string[];
  dimension_scores: Record<string, number>;
}

export interface ResumeAiTailoredContent {
  profile_summary: string;
  technical_skills: { category: string; skills: string }[];
  work_experience: ResumeContent['work_experience'];
}

export type ResumeAiAction = 'tailored' | 'analyzed' | 'none';

export interface ResumeAiChatResult {
  reply: string;
  intent: string;
  action: ResumeAiAction;
  job_description?: string | null;
  job_title?: string | null;
  company?: string | null;
  content?: ResumeAiTailoredContent | null;
  cover_letter?: string | null;
  match?: ResumeAiMatch | null;
}

export interface ResumeAiChatContext {
  resume_id: string;
  name: string;
  source: string;
  origin: string | null;
  job_description: string | null;
  job_title: string | null;
  company: string | null;
  match_score: number | null;
  content: ResumeContent | null;
  messages: ResumeAiChatMessage[];
  last_job_description: string | null;
}

export type ResumeAiChatStage = {
  stage: string;
  label?: string;
};

function parseFrame(frame: string): Record<string, unknown> | null {
  const line = frame
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'));
  if (!line) return null;
  const json = line.slice('data:'.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchResumeAiChatContext(resumeId: string): Promise<ResumeAiChatContext> {
  const { data } = await apiClient.get<ResumeAiChatContext>(
    `/resume-builder/resumes/${encodeURIComponent(resumeId)}/ai-chat`,
  );
  return data;
}

export async function clearResumeAiChat(resumeId: string): Promise<void> {
  await apiClient.delete(`/resume-builder/resumes/${encodeURIComponent(resumeId)}/ai-chat`);
}

export async function streamResumeAiChat(
  payload: {
    messages: ResumeAiChatMessage[];
    last_job_description?: string | null;
    resume_id?: string | null;
  },
  onStage?: (stage: ResumeAiChatStage) => void,
  signal?: AbortSignal,
): Promise<ResumeAiChatResult> {
  const res = await fetch(`${API_BASE_URL}/resume-builder/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    credentials: 'include',
    body: JSON.stringify({
      messages: payload.messages,
      last_job_description: payload.last_job_description ?? null,
      resume_id: payload.resume_id ?? null,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = 'The resume AI is unavailable.';
    try {
      const data = await res.json();
      if (data?.detail) detail = String(data.detail);
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ResumeAiChatResult | null = null;
  let error: string | null = null;

  const handle = (frame: Record<string, unknown>) => {
    const stage = String(frame.stage || '');
    if (stage === 'done' && frame.result && typeof frame.result === 'object') {
      result = frame.result as ResumeAiChatResult;
      if (result.action === 'tailored') void queryClient.invalidateQueries({ queryKey: STORE_KEY });
      return;
    }
    if (stage === 'error') {
      error = String(frame.message || 'Tailoring failed.');
      return;
    }
    if (stage && onStage) onStage({ stage, label: frame.label ? String(frame.label) : undefined });
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseFrame(raw);
      if (event) handle(event);
    }
  }
  const tail = parseFrame(buffer);
  if (tail) handle(tail);

  if (error) throw new Error(error);
  if (!result) throw new Error('The resume AI returned no result.');
  return result;
}
