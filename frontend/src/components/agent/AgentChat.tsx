import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Bot,
  Send,
  X,
  Sparkles,
  Trash2,
  Loader2,
  Check,
  AlertCircle,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react';
import { useAgentStore, type TimelineItem } from '../../stores/agentStore';
import type { AgentJobCard } from '../../api/agentApi';

const SUGGESTIONS = [
  'Display all remote jobs',
  "Show today's new jobs",
  'Sort jobs by match score',
  'Sync all platforms',
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
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
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

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const icon =
    item.status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
    ) : item.status === 'ok' ? (
      <Check className="h-3.5 w-3.5 text-emerald-500" />
    ) : (
      <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
    );
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
        {icon}
        <span>{item.title}</span>
        {item.summary && item.status !== 'running' && (
          <span className="truncate text-slate-400">- {item.summary}</span>
        )}
      </div>
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
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
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
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={[
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-line',
          isUser
            ? 'rounded-br-sm bg-blue-600 text-white'
            : 'rounded-bl-sm bg-white text-slate-700 ring-1 ring-slate-200',
        ].join(' ')}
      >
        {item.text}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-white px-3.5 py-3 ring-1 ring-slate-200">
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

export function AgentChat() {
  const { open, sending, timeline, openChat, closeChat, clear, send } = useAgentStore();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const lastIsEmptyAssistant = useMemo(() => {
    const last = timeline[timeline.length - 1];
    return last?.kind === 'assistant' && !last.text.trim();
  }, [timeline]);

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      inputRef.current?.focus();
    }
  }, [open, timeline]);

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

  if (!open) {
    return (
      <button
        type="button"
        onClick={openChat}
        aria-label="Open AI assistant"
        className="group fixed bottom-5 right-5 z-[60] flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-blue-600 to-blue-700 text-white shadow-xl shadow-blue-600/30 transition hover:scale-105 hover:shadow-2xl focus:outline-none focus:ring-4 focus:ring-blue-300"
      >
        <Bot className="h-6 w-6" />
        <span className="absolute right-0 top-0 h-3 w-3 animate-pulse rounded-full bg-emerald-400 ring-2 ring-white" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-[60] flex h-[min(640px,calc(100vh-2.5rem))] w-[min(420px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl shadow-slate-900/20">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-indigo-600 to-blue-600 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-none">AI Assistant</p>
            <p className="mt-0.5 text-[11px] text-blue-100">Search & act across your jobs</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {timeline.length > 0 && (
            <button
              type="button"
              onClick={clear}
              title="Clear conversation"
              className="rounded-lg p-1.5 text-blue-100 transition hover:bg-white/15 hover:text-white"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={closeChat}
            title="Close"
            className="rounded-lg p-1.5 text-blue-100 transition hover:bg-white/15 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3.5 py-4">
        {timeline.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 to-blue-100">
              <Bot className="h-7 w-7 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-700">How can I help?</p>
              <p className="mt-1 text-xs text-slate-500">
                Ask me to display or filter jobs in your dashboard, check stats, submit a URL,
                mark jobs applied, or sync platforms.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100"
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
                <div key={item.id} className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200">
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

      {/* Composer */}
      <div className="border-t border-slate-200 bg-white px-3 py-3">
        <div className="flex items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 focus-within:border-blue-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask anything about your jobs…"
            disabled={sending}
            className="max-h-28 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={sending || !draft.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Send"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
