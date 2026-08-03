import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Send,
  X,
  Trash2,
  Loader2,
  Check,
  AlertCircle,
  ExternalLink,
  CheckCircle2,
  Undo2,
} from 'lucide-react';
import { useAgentStore, type TimelineItem } from '../../stores/agentStore';
import type { AgentJobCard } from '../../api/agentApi';
import { BrandMark } from '../shared/BrandMark';
import { AI_PRODUCT } from '../shared/aiProductCopy';

const BASE_SUGGESTIONS = [
  'Display all remote jobs',
  "Show today's new jobs",
  'Sort jobs by match score',
];

function ScorePill({ score }: { score: number }) {
  const tone =
    score >= 75
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : score >= 50
        ? 'bg-amber-50 text-amber-700 ring-amber-200'
        : 'bg-slate-100 text-slate-600 ring-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 ${tone}`}>
      {score}
    </span>
  );
}

function JobCard({ job }: { job: AgentJobCard }) {
  return (
    <div className="brand-fade-in flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-slate-800">{job.title || 'Untitled role'}</p>
        <p className="truncate text-[11px] text-slate-500">
          {job.company || 'Unknown'}
          {job.location ? ` · ${job.location}` : ''}
        </p>
      </div>
      {typeof job.match_overall_score === 'number' && <ScorePill score={job.match_overall_score} />}
      {job.applied_at && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label="Applied" />}
      {job.source_url && (
        <a
          href={job.source_url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-slate-400 transition hover:text-blue-600"
          title="Open job"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

function discardLabel(discard: NonNullable<Extract<TimelineItem, { kind: 'tool' }>['discard']>): string {
  switch (discard.kind) {
    case 'dashboard':
      return 'Discard filter changes';
    case 'applied':
      return discard.wasApplied ? 'Undo applied marks' : 'Restore applied marks';
    case 'submit_job':
      return 'Remove submitted job';
    default:
      return 'Discard change';
  }
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const discardAction = useAgentStore((s) => s.discardAction);
  const sending = useAgentStore((s) => s.sending);
  const canDiscard = Boolean(item.discard && !item.discarded && item.status === 'ok');

  const icon =
    item.status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
    ) : item.status === 'ok' ? (
      <Check className="h-3.5 w-3.5 text-emerald-500" />
    ) : (
      <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
    );
  return (
    <div className="brand-fade-in space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
        {icon}
        <span>{item.title}</span>
        {item.summary && item.status !== 'running' && (
          <span className="truncate text-slate-400">- {item.summary}</span>
        )}
      </div>
      {canDiscard && item.discard && (
        <div className="ml-5">
          <button
            type="button"
            disabled={sending}
            onClick={() => void discardAction(item.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
          >
            <Undo2 className="h-3 w-3" />
            {discardLabel(item.discard)}
          </button>
        </div>
      )}
      {item.discarded && (
        <p className="ml-5 text-[11px] font-medium text-slate-400">Change discarded</p>
      )}
      {item.jobs && item.jobs.length > 0 && (
        <div className="ml-5 space-y-1.5">
          {item.jobs.slice(0, 8).map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmRow({ item }: { item: Extract<TimelineItem, { kind: 'confirm' }> }) {
  const confirmAction = useAgentStore((s) => s.confirmAction);
  const cancelAction = useAgentStore((s) => s.cancelAction);
  const sending = useAgentStore((s) => s.sending);

  return (
    <div className="brand-fade-in rounded-xl border border-amber-200 bg-amber-50/70 p-3">
      <p className="text-xs font-medium text-amber-900 whitespace-pre-line">{item.summary}</p>
      {!item.resolved ? (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            disabled={sending}
            onClick={() => void confirmAction(item.id)}
            className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700 disabled:opacity-60"
          >
            <Check className="h-3.5 w-3.5" />
            Confirm
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={() => cancelAction(item.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className={`mt-2 text-[11px] font-semibold ${item.resolved === 'confirmed' ? 'text-emerald-600' : 'text-slate-400'}`}>
          {item.resolved === 'confirmed' ? 'Confirmed' : 'Cancelled'}
        </p>
      )}
    </div>
  );
}

function Bubble({ item }: { item: Extract<TimelineItem, { kind: 'user' | 'assistant' }> }) {
  const isUser = item.kind === 'user';
  if (isUser) {
    return (
      <div className="brand-fade-in flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-3.5 py-2 text-sm leading-relaxed whitespace-pre-line text-white">
          {item.text}
        </div>
      </div>
    );
  }
  return (
    <div className="brand-fade-in flex items-start gap-2">
      <BrandMark mood="idle" size="sm" />
      <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white px-3.5 py-2 text-sm leading-relaxed whitespace-pre-line text-slate-700 shadow-sm ring-1 ring-violet-100">
        {item.text}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="brand-fade-in flex items-start gap-2">
      <BrandMark mood="thinking" size="sm" />
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-white px-3.5 py-3 ring-1 ring-violet-100">
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="brand-type-dot h-2 w-2 rounded-full bg-fuchsia-400"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

const AGENT_CLOSE_MS = 170;

export function AgentChat() {
  const { open, sending, timeline, closeChat, clear, send } = useAgentStore();
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const wasOpenRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = BASE_SUGGESTIONS;

  const lastIsEmptyAssistant = useMemo(() => {
    const last = timeline[timeline.length - 1];
    return last?.kind === 'assistant' && !last.text.trim();
  }, [timeline]);

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
    }, AGENT_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [open, timeline]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeChat]);

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[60] md:left-60"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close AI assistant"
        className={`absolute inset-0 bg-slate-950/35 backdrop-blur-[1px] ${
          leaving ? 'animate-agent-backdrop-out' : 'animate-agent-backdrop-in'
        }`}
        onClick={closeChat}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI Assistant"
        className={[
          'absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-[61]',
          'flex h-[min(640px,calc(100dvh-5.5rem))] w-[min(420px,calc(100vw-1.5rem))] flex-col overflow-hidden',
          'rounded-2xl border-2 border-violet-200 bg-slate-50 shadow-2xl shadow-violet-900/25',
          'md:bottom-[max(1.25rem,env(safe-area-inset-bottom))] md:left-3',
          'md:h-[min(640px,calc(100dvh-2.5rem))] md:w-[min(420px,calc(100%-1.5rem))]',
          leaving ? 'animate-agent-modal-out' : 'animate-agent-modal-in',
        ].join(' ')}
      >
        <div className="flex items-center justify-between gap-2 border-b border-violet-200/80 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-500 px-3.5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark mood={sending ? 'thinking' : 'idle'} size="sm" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-sm font-extrabold leading-none text-white">AI Assistant</p>
                <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white ring-1 ring-white/30">
                  Jobs
                </span>
                {sending && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-300/95 px-1.5 py-0.5 text-[9px] font-bold text-amber-950 ring-1 ring-amber-200">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    In progress
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-[11px] font-medium leading-snug text-white/90">
                {sending ? 'Working through your request - hang tight…' : AI_PRODUCT.assistantHeader}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {timeline.length > 0 && (
              <button
                type="button"
                onClick={clear}
                title="Clear conversation"
                className="rounded-lg p-1.5 text-white/80 transition hover:bg-white/15 hover:text-white"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={closeChat}
              title="Close"
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white ring-1 ring-white/40 transition hover:bg-white/25"
            >
              <X className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3.5 py-4">
          {timeline.length === 0 && (
            <div className="brand-fade-in flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
              <BrandMark mood="idle" size="lg" />
              <div className="brand-fade-in brand-fade-in-delay-1">
                <p className="text-sm font-bold text-slate-800">How can I help?</p>
                <p className="mt-1 text-xs text-slate-500">
                  Ask me to display or filter jobs, check stats, submit a URL, or mark jobs applied.
                </p>
              </div>
              <div className="brand-fade-in brand-fade-in-delay-2 flex flex-wrap justify-center gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-semibold text-violet-700 transition hover:bg-fuchsia-50 hover:text-fuchsia-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {timeline.map((item) => {
            switch (item.kind) {
              case 'user':
              case 'assistant':
                if (item.kind === 'assistant' && !item.text.trim()) return null;
                return <Bubble key={item.id} item={item} />;
              case 'tool':
                return <ToolRow key={item.id} item={item} />;
              case 'confirm':
                return <ConfirmRow key={item.id} item={item} />;
              case 'error':
                return (
                  <div key={item.id} className="brand-fade-in flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{item.text}</span>
                  </div>
                );
              default:
                return null;
            }
          })}

          {sending && lastIsEmptyAssistant && <TypingDots />}
        </div>

        <div className="border-t border-slate-200 bg-white px-3 py-3">
          <div className="relative">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="Ask anything about your jobs…"
              disabled={sending}
              className="max-h-28 min-h-[52px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 pr-12 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={submit}
              disabled={sending || !draft.trim()}
              className="absolute bottom-2.5 right-2.5 inline-flex h-9 w-9 -rotate-6 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-600/25 transition hover:-rotate-12 hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:rotate-[-6deg] disabled:hover:scale-100"
              aria-label="Send"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 -translate-x-px translate-y-px" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
