import { create } from 'zustand';
import { streamResumeAiChat } from '../api/resumeAiApi';
import type { ResumeAiMatch, ResumeAiTailoredContent } from '../types/resumeAi';
import type { ResumeContent } from '../types/resumeDesign';
import { useResumeBuilderStore } from './resumeBuilderStore';
import { normalizeContentWork, profileToContent } from '../utils/resumeContent';

export interface ResumeAiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  /** Current pipeline stage while pending: routing | analyzing | evidence | tailoring. */
  stage?: string;
  intent?: string;
  action?: 'tailored' | 'analyzed' | 'none';
  match?: ResumeAiMatch | null;
  coverLetter?: string | null;
  jobLabel?: string | null;
}

interface ResumeAiState {
  open: boolean;
  messages: ResumeAiChatMessage[];
  sending: boolean;
  error: string | null;
  lastJobDescription: string | null;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Open the center (used by the dashboard entry that navigates to the builder). */
  requestOpen: () => void;
  send: (text: string) => Promise<void>;
  reset: () => void;
}

let msgSeq = 0;
function newId(): string {
  msgSeq += 1;
  return `rai-${Date.now()}-${msgSeq}`;
}

const WELCOME: ResumeAiChatMessage = {
  id: 'rai-welcome',
  role: 'assistant',
  text:
    "Paste a job description and I'll tailor your resume to it, or ask me to score how well you match. "
    + 'Tailored content loads straight into the builder for you to refine.',
};

/** Merge tailored sections onto a profile-seeded content override and save it as a NEW
 *  resume in the library (source "tailored"), then open it in the builder. Header /
 *  education / certificates come from the profile so they're preserved; the AI only
 *  rewrites summary, skills and experience. Every tailored run keeps its own history
 *  entry rather than overwriting the active resume. */
async function applyTailoredToBuilder(
  tailored: ResumeAiTailoredContent,
  meta: { jobTitle?: string | null; company?: string | null },
): Promise<void> {
  const builder = useResumeBuilderStore.getState();
  // Ensure the design + profile are loaded (e.g. when arriving via the dashboard entry).
  if (!builder.design || !builder.profile) {
    await builder.load();
  }
  const s = useResumeBuilderStore.getState();
  if (!s.design) return;

  const base = profileToContent(s.profile);
  const merged: ResumeContent = {
    ...base,
    profile_summary: tailored.profile_summary || base.profile_summary,
    technical_skills: tailored.technical_skills.length ? tailored.technical_skills : base.technical_skills,
    work_experience: tailored.work_experience.length
      ? tailored.work_experience.map((w) => normalizeContentWork(w))
      : base.work_experience,
  };
  // Inherit the current theme/styling; only swap in the tailored content.
  const design = { ...s.design, content: merged };
  const name = [meta.jobTitle, meta.company].filter(Boolean).join(' - ') || 'Tailored resume';

  await s.createResumeEntry({
    name: name.slice(0, 200),
    design,
    source: 'tailored',
    status: 'draft',
    jobTitle: meta.jobTitle ?? null,
    company: meta.company ?? null,
    activate: true,
  });
  s.setPanelTab('content');
}

export const useResumeAiStore = create<ResumeAiState>((set, get) => ({
  open: false,
  messages: [WELCOME],
  sending: false,
  error: null,
  lastJobDescription: null,

  setOpen: (open) => set({ open }),
  toggle: () => set((st) => ({ open: !st.open })),
  requestOpen: () => set({ open: true }),

  send: async (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().sending) return;

    const userMsg: ResumeAiChatMessage = { id: newId(), role: 'user', text: trimmed };
    const pendingMsg: ResumeAiChatMessage = {
      id: newId(),
      role: 'assistant',
      text: 'Working on it…',
      pending: true,
      stage: 'routing',
    };
    const priorMessages = get().messages;
    set({ messages: [...priorMessages, userMsg, pendingMsg], sending: true, error: null });

    // Build the API conversation from real (non-pending, non-welcome) turns + this message.
    const apiMessages = [...priorMessages, userMsg]
      .filter((m) => m.id !== 'rai-welcome' && !m.pending)
      .map((m) => ({ role: m.role, content: m.text }));

    try {
      const resp = await streamResumeAiChat(apiMessages, get().lastJobDescription, (ev) => {
        set((st) => ({
          messages: st.messages.map((m) =>
            m.id === pendingMsg.id ? { ...m, stage: ev.stage, text: ev.label || m.text } : m,
          ),
        }));
      });

      if (resp.action === 'tailored' && resp.content) {
        try {
          await applyTailoredToBuilder(resp.content, { jobTitle: resp.job_title, company: resp.company });
        } catch {
          /* builder injection is best-effort; the reply still shows */
        }
      }

      const jobLabel = [resp.job_title, resp.company].filter(Boolean).join(' · ') || null;
      set((st) => ({
        sending: false,
        lastJobDescription: resp.job_description ?? st.lastJobDescription,
        messages: st.messages.map((m) =>
          m.id === pendingMsg.id
            ? {
                ...m,
                pending: false,
                text: resp.reply,
                intent: resp.intent,
                action: resp.action,
                match: resp.match ?? null,
                coverLetter: resp.cover_letter ?? null,
                jobLabel,
              }
            : m,
        ),
      }));
    } catch {
      set((st) => ({
        sending: false,
        error: 'Could not reach the assistant. Please try again.',
        messages: st.messages.map((m) =>
          m.id === pendingMsg.id
            ? { ...m, pending: false, text: 'Sorry - something went wrong. Please try again.' }
            : m,
        ),
      }));
    }
  },

  reset: () => set({ messages: [WELCOME], lastJobDescription: null, error: null }),
}));
