import { API_BASE_URL } from './client';
import type { ResumeAiChatRequestMessage, ResumeAiChatResponse } from '../types/resumeAi';

export interface ResumeAiStageEvent {
  stage: string;
  label?: string;
}

interface ResumeAiSseFrame {
  stage?: string;
  label?: string;
  result?: ResumeAiChatResponse;
  message?: string;
}

/** OneClick AI center: tailor a resume / score the match from a pasted job description.
 *
 *  Streams Server-Sent Events; `onStage` is called for each progress step
 *  (routing → analyzing → evidence → tailoring). Resolves with the final tailored
 *  result. Job-less - the backend persists nothing. */
export async function streamResumeAiChat(
  messages: ResumeAiChatRequestMessage[],
  lastJobDescription: string | null,
  onStage: (ev: ResumeAiStageEvent) => void,
): Promise<ResumeAiChatResponse> {
  const res = await fetch(`${API_BASE_URL}/resume-builder/ai/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages, last_job_description: lastJobDescription }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Resume AI chat failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ResumeAiChatResponse | null = null;
  let errorMessage: string | null = null;

  const handleFrame = (raw: string) => {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    let parsed: ResumeAiSseFrame;
    try {
      parsed = JSON.parse(data) as ResumeAiSseFrame;
    } catch {
      return;
    }
    if (parsed.stage === 'done' && parsed.result) {
      result = parsed.result;
    } else if (parsed.stage === 'error') {
      errorMessage = parsed.message || 'Failed to process request.';
    } else if (parsed.stage) {
      onStage({ stage: parsed.stage, label: parsed.label });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      handleFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handleFrame(buffer);

  if (errorMessage) throw new Error(errorMessage);
  if (!result) throw new Error('Resume AI chat returned no result.');
  return result;
}
