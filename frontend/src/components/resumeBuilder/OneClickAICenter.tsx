import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Send,
  Loader2,
  ClipboardCopy,
  CheckCircle2,
  Circle,
  Wand2,
  ChevronDown,
} from 'lucide-react';
import { useResumeAiStore, type ResumeAiChatMessage } from '../../stores/resumeAiStore';
import type { ResumeAiMatch } from '../../types/resumeAi';
import { renderRich } from '../../utils/richText';

/* NOTE on dark mode: this app inverts the slate palette + accent-50 steps via CSS
 * variables in style.css (e.g. `.dark` makes slate-900 white and slate-50 dark). So we
 * deliberately use ONLY base utility classes (bg-white, bg-slate-50, text-slate-700,
 * bg-emerald-50, …) and let the global remap invert them. Adding `dark:bg-slate-900`
 * style overrides would flip surfaces to WHITE in dark mode, which is the bug this
 * component previously had. */

function scoreTone(score: number): { ring: string; text: string; chip: string; label: string } {
  if (score >= 75) return { ring: 'text-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700', label: 'Strong match' };
  if (score >= 50) return { ring: 'text-sky-500', text: 'text-sky-700', chip: 'bg-sky-50 text-sky-700', label: 'Good match' };
  if (score >= 30) return { ring: 'text-amber-500', text: 'text-amber-700', chip: 'bg-amber-50 text-amber-700', label: 'Fair match' };
  return { ring: 'text-rose-500', text: 'text-rose-700', chip: 'bg-rose-50 text-rose-700', label: 'Weak match' };
}

function MatchCard({ match }: { match: ResumeAiMatch }) {
  const score = Math.max(0, Math.min(100, Math.round(match.overall_score)));
  const tone = scoreTone(score);
  const circumference = 2 * Math.PI * 26;
  const dash = (score / 100) * circumference;

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="relative h-16 w-16 shrink-0">
          <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
            <circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeWidth="6" className="text-slate-100" />
            <circle
              cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference}`} className={tone.ring}
            />
          </svg>
          <div className={`absolute inset-0 flex flex-col items-center justify-center ${tone.text}`}>
            <span className="text-lg font-bold tabular-nums leading-none">{score}</span>
            <span className="text-[8px] font-medium opacity-70">/ 100</span>
          </div>
        </div>
        <div className="min-w-0">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.chip}`}>
            {match.recommendation ? match.recommendation.replace(/_/g, ' ') : tone.label}
          </span>
          {match.summary && <p className="mt-1 text-xs leading-snug text-slate-600">{match.summary}</p>}
        </div>
      </div>

      {(match.strengths.length > 0 || match.gaps.length > 0) && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {match.strengths.length > 0 && (
            <div className="rounded-lg bg-emerald-50 p-2">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Strengths</p>
              <ul className="space-y-0.5">
                {match.strengths.slice(0, 4).map((s, i) => (
                  <li key={i} className="text-[11px] leading-snug text-emerald-800">• {s}</li>
                ))}
              </ul>
            </div>
          )}
          {match.gaps.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-2">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">Gaps to address</p>
              <ul className="space-y-0.5">
                {match.gaps.slice(0, 4).map((g, i) => (
                  <li key={i} className="text-[11px] leading-snug text-amber-800">• {g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CoverLetterCard({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="mt-2 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-700">Tailored cover letter</p>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700 transition hover:bg-indigo-100"
        >
          {copied ? <CheckCircle2 size={12} /> : <ClipboardCopy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-snug text-slate-700">
        {renderRich(body)}
      </div>
    </div>
  );
}

const AI_STAGES: { id: string; label: string }[] = [
  { id: 'routing', label: 'Understanding your request' },
  { id: 'analyzing', label: 'Scoring your match' },
  { id: 'evidence', label: 'Gathering evidence from your projects' },
  { id: 'tailoring', label: 'Rewriting your resume' },
];

/** Live multi-step progress shown while the pipeline runs, driven by SSE stage events. */
function PendingStatus({ stage }: { stage?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);
  const currentIdx = Math.max(0, AI_STAGES.findIndex((s) => s.id === stage));

  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-500">Working on it…</span>
        <span className="tabular-nums text-[10px] text-slate-400">{elapsed}s</span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {AI_STAGES.map((s, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <li key={s.id} className="flex items-center gap-2 text-[12px]">
              {done ? (
                <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
              ) : active ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-blue-500" />
              ) : (
                <Circle size={13} className="shrink-0 text-slate-300" />
              )}
              <span className={done ? 'text-slate-500' : active ? 'font-semibold text-slate-700' : 'text-slate-400'}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ResumeAiChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white shadow-sm">
          {msg.text.length > 600 ? `${msg.text.slice(0, 600)}…` : msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200">
        {msg.pending ? (
          <PendingStatus stage={msg.stage} />
        ) : (
          <div className="flex items-start gap-1.5">
            <Sparkles size={14} className="mt-0.5 shrink-0 text-blue-500" />
            <span className="whitespace-pre-wrap break-words">{msg.text}</span>
          </div>
        )}
      </div>
      {msg.action === 'tailored' && (
        <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
          <CheckCircle2 size={11} /> Loaded into builder
        </span>
      )}
      <div className="w-full">
        {msg.match && <MatchCard match={msg.match} />}
        {msg.coverLetter && <CoverLetterCard body={msg.coverLetter} />}
      </div>
    </div>
  );
}

export function OneClickAICenter() {
  const { open, messages, sending, setOpen, send } = useResumeAiStore();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    void send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-1/2 z-[55] -translate-x-1/2 inline-flex items-center gap-2 rounded-full border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:scale-[1.02] hover:shadow-blue-600/40"
      >
        <Wand2 size={16} />
        OneClick AI — tailor from a job description
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 left-1/2 z-[55] flex h-[min(600px,80vh)] w-[min(720px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl ring-1 ring-slate-900/10">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white">
            <Wand2 size={16} />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">OneClick AI</p>
            <p className="text-[11px] text-slate-500">Tailor your resume · score your match</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Minimize"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
        >
          <ChevronDown size={18} />
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="builder-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Paste a job description, or ask me to score your match…"
            className="builder-scroll max-h-32 min-h-[44px] flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
          />
          <button
            type="button"
            onClick={submit}
            disabled={sending || !draft.trim()}
            className="inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            Send
          </button>
        </div>
        <p className="mt-1 px-1 text-[10px] text-slate-400">Press Ctrl/⌘ + Enter to send · tailored content loads into the builder automatically.</p>
      </div>
    </div>
  );
}
