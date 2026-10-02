import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Send,
  Loader2,
  ClipboardCopy,
  CheckCircle2,
  ChevronDown,
  X,
} from 'lucide-react';
import { useResumeAiStore, type ResumeAiChatMessage } from '../../stores/resumeAiStore';
import type { ResumeAiMatch } from '../../types/resumeAi';
import { renderRich } from '../../utils/richText';
import { BrandMark, type BrandMood } from '../shared/BrandMark';
import { AI_PRODUCT } from '../shared/aiProductCopy';

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

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 px-0.5" aria-hidden>
      <span className="brand-type-dot h-2 w-2 rounded-full bg-fuchsia-400" />
      <span className="brand-type-dot h-2 w-2 rounded-full bg-violet-400" />
      <span className="brand-type-dot h-2 w-2 rounded-full bg-cyan-300" />
    </span>
  );
}

const AI_STAGES: {
  id: string;
  said: string;
  speaking: string[];
}[] = [
  {
    id: 'routing',
    said: 'Understood - I have your intent locked in.',
    speaking: [
      'Alright… let me parse exactly what you need…',
      'Reading between the lines of your request…',
      'Mapping the smartest path for this one…',
    ],
  },
  {
    id: 'analyzing',
    said: 'Match analysis is complete on my side.',
    speaking: [
      'Comparing your experience against this role…',
      'Scoring the fit - strengths first, gaps second…',
      'Running a careful match pass on the job…',
    ],
  },
  {
    id: 'evidence',
    said: 'I pulled the strongest proof from your projects.',
    speaking: [
      'Gathering evidence from your project history…',
      'Looking for proof points that sell this role…',
      'Selecting the wins that belong on this resume…',
    ],
  },
  {
    id: 'tailoring',
    said: 'Your tailored draft is coming together.',
    speaking: [
      'Rewriting your resume for this specific job…',
      'Sharpening bullets so they speak the role\'s language…',
      'Polishing the draft until it feels interview-ready…',
    ],
  },
];

const WAITING_QUIPS = [
  'Still with you - quality takes a moment.',
  'Almost there… finishing the careful pass.',
  'Hang tight - I am mid-thought.',
  'Worth the wait - refining the last details.',
];

/** Live progress as spoken dialogue - avatar once, no repeated nameplates. */
function PendingStatus({ stage }: { stage?: string }) {
  const [elapsed, setElapsed] = useState(0);
  const [lineTick, setLineTick] = useState(0);

  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setLineTick(0);
    const id = window.setInterval(() => setLineTick((n) => n + 1), 3400);
    return () => window.clearInterval(id);
  }, [stage]);

  const currentIdx = Math.max(
    0,
    AI_STAGES.findIndex((s) => s.id === stage),
  );
  const current = AI_STAGES[currentIdx] ?? AI_STAGES[0];
  const spoken = useMemo(() => {
    const pool = current.speaking;
    return pool[lineTick % pool.length];
  }, [current, lineTick]);

  const waitingQuip = WAITING_QUIPS[Math.floor(elapsed / 8) % WAITING_QUIPS.length];
  const doneStages = AI_STAGES.slice(0, currentIdx);

  return (
    <div className="flex w-full items-start gap-3">
      <BrandMark mood="thinking" size="md" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Working…</span>
          <span className="tabular-nums text-[10px] font-semibold text-slate-500">{elapsed}s</span>
        </div>

        {doneStages.map((s, i) => (
          <div
            key={s.id}
            className="brand-said-in flex items-start gap-2 rounded-2xl rounded-tl-md bg-emerald-50 px-3.5 py-2.5 text-[12px] leading-snug text-emerald-800 ring-1 ring-emerald-200"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-500" />
            <span>{s.said}</span>
          </div>
        ))}

        <div
          key={`${stage}-${spoken}`}
          className="brand-speech-in relative max-w-[95%] rounded-2xl rounded-tl-md bg-gradient-to-br from-white to-violet-50 px-4 py-3.5 text-sm text-slate-800 shadow-md ring-1 ring-violet-200"
        >
          <p className="leading-relaxed">{spoken}</p>
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-violet-100 pt-2">
            <TypingDots />
            <span className="text-[10px] font-semibold italic text-slate-500">{waitingQuip}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantSpeech({
  children,
  mood = 'idle',
}: {
  children: ReactNode;
  mood?: BrandMood;
}) {
  return (
    <div className="flex w-full items-start gap-3">
      <BrandMark mood={mood} size="sm" />
      <div className="relative min-w-0 max-w-[92%] flex-1 rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-slate-700 shadow-md ring-1 ring-violet-100">
        {children}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ResumeAiChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="brand-fade-in flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-gradient-to-br from-indigo-600 to-fuchsia-600 px-4 py-2.5 text-sm text-white shadow-md shadow-indigo-500/30">
          {msg.text.length > 600 ? `${msg.text.slice(0, 600)}…` : msg.text}
        </div>
      </div>
    );
  }

  if (msg.pending) {
    return (
      <div className="brand-fade-in">
        <PendingStatus stage={msg.stage} />
      </div>
    );
  }

  const celebrate = msg.action === 'tailored' || msg.action === 'analyzed';

  return (
    <div className="brand-fade-in flex flex-col items-start gap-1.5">
      <AssistantSpeech mood={celebrate ? 'celebrate' : 'idle'}>
        <p className="whitespace-pre-wrap break-words leading-relaxed">{msg.text}</p>
      </AssistantSpeech>
      {msg.action === 'tailored' && (
        <span className="ml-12 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-100">
          <CheckCircle2 size={11} /> Loaded into the builder - review and refine anytime
        </span>
      )}
      <div className="ml-12 w-[calc(100%-3rem)]">
        {msg.match && <MatchCard match={msg.match} />}
        {msg.coverLetter && <CoverLetterCard body={msg.coverLetter} />}
      </div>
    </div>
  );
}

/** Docked launcher in the left Style/Content/Resumes panel. */
export function OneClickAILauncher({
  className = '',
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { open, sending, setOpen } = useResumeAiStore();

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`oneclick-launcher-glow group relative flex w-full flex-col items-stretch gap-1.5 overflow-hidden rounded-xl border-2 border-indigo-300/80 bg-gradient-to-r from-indigo-50 via-violet-50 to-fuchsia-50 px-3 py-2.5 text-left shadow-lg shadow-indigo-500/20 transition hover:border-fuchsia-400 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300 ${
          open ? 'border-fuchsia-400 ring-2 ring-fuchsia-300/60' : ''
        } ${className}`}
      >
        <span className="oneclick-shimmer pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-70" />
        <span className="relative flex w-full items-center gap-3">
          <BrandMark mood={sending ? 'thinking' : open ? 'celebrate' : 'idle'} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold tracking-tight text-slate-900">
              {AI_PRODUCT.oneClickTitle}
            </p>
            <p className="truncate text-[11px] font-semibold text-slate-600">
              {open
                ? sending
                  ? 'Working…'
                  : 'Session open'
                : 'Match & tailor to a job'}
            </p>
          </div>
          <span className="oneclick-shimmer relative inline-flex shrink-0 items-center gap-1 rounded-lg bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-500 px-2.5 py-1.5 text-[11px] font-bold text-white shadow-md shadow-violet-500/40">
            {open ? <ChevronDown size={13} /> : null}
            {open ? 'Hide' : 'Open'}
          </span>
        </span>
        <p className="relative text-[11px] font-medium leading-snug text-slate-600">
          {AI_PRODUCT.oneClickHowTo}
        </p>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      className={`oneclick-launcher-glow group relative flex w-full flex-col items-stretch gap-3 overflow-hidden rounded-2xl border-2 border-indigo-300/80 bg-gradient-to-br from-indigo-50 via-violet-50 to-fuchsia-50 p-4 text-left shadow-lg shadow-indigo-500/25 transition hover:border-fuchsia-400 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300 ${
        open ? 'border-fuchsia-400 ring-2 ring-fuchsia-300/60' : ''
      } ${className}`}
    >
      <span className="oneclick-shimmer pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/45 to-transparent opacity-80" />
      <div className="relative flex items-center gap-3">
        <BrandMark mood={sending ? 'thinking' : open ? 'celebrate' : 'idle'} size="md" />
        <div className="min-w-0">
          <p className="text-base font-extrabold tracking-tight text-slate-900">
            {AI_PRODUCT.oneClickTitle}
          </p>
          <p className="text-[11px] font-semibold text-slate-600">
            {open
              ? sending
                ? 'Working on your request…'
                : 'Session open'
              : AI_PRODUCT.oneClickSubtitle}
          </p>
        </div>
      </div>
      <p className="relative text-[12px] font-medium leading-snug text-slate-700">
        {AI_PRODUCT.oneClickHowTo}
      </p>
      <span className="oneclick-shimmer relative inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-500 px-3 py-2.5 text-xs font-bold text-white shadow-md shadow-fuchsia-500/35 transition group-hover:scale-[1.02] group-hover:shadow-lg">
        {open ? (
          <>
            <ChevronDown size={14} />
            Minimize
          </>
        ) : (
          <>Open {AI_PRODUCT.oneClickTitle}</>
        )}
      </span>
    </button>
  );
}

/** Floating chat panel - rendered when the session is open. */
export function OneClickAICenter() {
  const { open, messages, sending, setOpen, send } = useResumeAiStore();
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      setLeaving(false);
      setVisible(true);
      return;
    }
    if (!wasOpenRef.current) return;
    setLeaving(true);
    const t = window.setTimeout(() => {
      wasOpenRef.current = false;
      setVisible(false);
      setLeaving(false);
    }, 220);
    return () => window.clearTimeout(t);
  }, [open]);

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

  if (!visible) return null;

  const canSend = Boolean(draft.trim()) && !sending;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label={`Close ${AI_PRODUCT.oneClickTitle}`}
        className={`absolute inset-0 bg-indigo-950/50 backdrop-blur-[3px] ${
          leaving ? 'animate-oneclick-backdrop-out' : 'animate-modal-backdrop-in'
        }`}
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={AI_PRODUCT.oneClickTitle}
        className={`relative flex h-[min(1200px,92dvh)] w-full max-w-[1440px] flex-col overflow-hidden rounded-2xl border-2 border-violet-200 bg-gradient-to-b from-violet-50/80 to-slate-50 shadow-2xl shadow-violet-900/25 ring-1 ring-fuchsia-200/60 sm:w-[min(1440px,96vw)] sm:rounded-3xl ${
          leaving ? 'animate-oneclick-modal-out' : 'animate-modal-in'
        }`}
      >
        {/* Product header - NAO brand chrome */}
        <div className="shrink-0 border-b border-violet-200/80 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-500 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <BrandMark mood={sending ? 'thinking' : 'idle'} size="md" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-extrabold tracking-tight text-white drop-shadow-sm">
                      {AI_PRODUCT.oneClickTitle}
                    </h2>
                    <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white ring-1 ring-white/30 backdrop-blur-sm">
                      {AI_PRODUCT.oneClickSubtitle}
                    </span>
                    {sending && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-300/95 px-2 py-0.5 text-[10px] font-bold text-amber-950 shadow-sm ring-1 ring-amber-200">
                        <Loader2 size={10} className="animate-spin" />
                        In progress
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs font-medium leading-snug text-white/90">
                    {sending ? 'Working through your request - hang tight…' : AI_PRODUCT.oneClickHeader}
                  </p>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/40 transition hover:bg-white/25"
            >
              <X size={18} strokeWidth={2.5} />
            </button>
          </div>
        </div>

        {/* Transcript */}
        <div ref={scrollRef} className="builder-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-violet-200/80 bg-gradient-to-r from-indigo-50/80 via-white to-fuchsia-50/80 px-5 py-4">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={6}
              placeholder="Paste a job description, or ask to score your match…"
              className="builder-scroll max-h-64 min-h-[160px] w-full resize-y rounded-2xl border-2 border-violet-200 bg-white px-4 py-3.5 pr-20 pb-14 text-base leading-relaxed text-slate-800 shadow-inner outline-none transition focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-200"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              title="Send (Ctrl/⌘ + Enter)"
              aria-label="Send"
              className="absolute bottom-3 right-3 inline-flex h-12 w-12 -rotate-6 items-center justify-center rounded-[1.15rem] bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/40 transition duration-200 hover:-rotate-12 hover:scale-110 hover:shadow-fuchsia-500/55 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:rotate-[-6deg] disabled:hover:scale-100"
            >
              {sending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} className="-translate-x-px translate-y-px" />}
            </button>
          </div>
          <p className="mt-2 px-1 text-xs text-slate-400">
            Press Ctrl/⌘ + Enter to send · tailored content loads into the builder automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
