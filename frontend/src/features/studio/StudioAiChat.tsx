import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Sparkles,
  SquarePen,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { MatchScore } from '@/components/app/MatchScore';
import { Composer } from '@/features/assistant/Composer';
import { AssistantAvatar } from '@/features/assistant/Thread';
import {
  clearResumeAiChat,
  fetchResumeAiChatContext,
  streamResumeAiChat,
  type ResumeAiChatMessage,
  type ResumeAiChatResult,
  type ResumeAiMatch,
} from '@/api/resumeAiChatApi';
import { saveLibraryCoverLetter } from '@/api/documentsApi';
import { cn } from '@/lib/utils';
import { normalizeResumeContent, profileToContent, seedHeaderLocation } from '@/utils/resumeContent';
import { useResumeBuilderStore } from '@/stores/resumeBuilderStore';
import { mergeTailoredContent } from './mergeTailoredContent';

const SUGGESTIONS = [
  'Tailor this resume to the job',
  'Score how well I match this role',
  'Make the summary shorter and sharper',
  'Emphasize leadership in my experience',
] as const;

type Props = {
  open: boolean;
  resumeId: string | null;
  onClose: () => void;
  onCoverLetter?: (body: string) => void;
};

export function StudioAiChat({ open, resumeId, onClose, onCoverLetter }: Props) {
  const design = useResumeBuilderStore((s) => s.design);
  const profile = useResumeBuilderStore((s) => s.profile);
  const setContent = useResumeBuilderStore((s) => s.setContent);
  const setPanelTab = useResumeBuilderStore((s) => s.setPanelTab);

  const [messages, setMessages] = useState<ResumeAiChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  const [lastJd, setLastJd] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    name: string;
    job_title: string | null;
    company: string | null;
    match_score: number | null;
  } | null>(null);
  const [lastMatch, setLastMatch] = useState<ResumeAiMatch | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !resumeId) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setLastMatch(null);
    setStageLabel(null);
    fetchResumeAiChatContext(resumeId)
      .then((ctx) => {
        if (!alive) return;
        setMessages(ctx.messages || []);
        setLastJd(ctx.last_job_description || ctx.job_description || null);
        setMeta({
          name: ctx.name,
          job_title: ctx.job_title,
          company: ctx.company,
          match_score: ctx.match_score,
        });
      })
      .catch(() => {
        if (!alive) return;
        setLoadError('Could not load AI context for this resume.');
        setMessages([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, [open, resumeId]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, stageLabel, open]);

  const applyResult = (result: ResumeAiChatResult) => {
    if (result.job_description) setLastJd(result.job_description);
    if (result.match) {
      setLastMatch(result.match);
      setMeta((m) =>
        m
          ? {
              ...m,
              job_title: result.job_title ?? m.job_title,
              company: result.company ?? m.company,
              match_score: result.match?.overall_score ?? m.match_score,
            }
          : m,
      );
    }

    if (result.action === 'tailored' && result.content && design) {
      const base = seedHeaderLocation(
        design.content ? normalizeResumeContent(design.content) : profileToContent(profile),
        profile,
      );
      setContent(mergeTailoredContent(base, result.content));
      setPanelTab('content');
      toast.success('Resume updated from AI', {
        description: 'Review the Content tab. Changes save automatically.',
      });
    }

    if (result.cover_letter && resumeId) {
      onCoverLetter?.(result.cover_letter);
      void saveLibraryCoverLetter(resumeId, result.cover_letter).catch(() => undefined);
    }
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !resumeId || busy) return;

    const nextMessages: ResumeAiChatMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setDraft('');
    setBusy(true);
    setStageLabel('Understanding your request…');
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const result = await streamResumeAiChat(
        {
          messages: nextMessages,
          last_job_description: lastJd,
          resume_id: resumeId,
        },
        (ev) => setStageLabel(ev.label || ev.stage),
        ac.signal,
      );
      setMessages((prev) => [...prev, { role: 'assistant', content: result.reply || 'Done.' }]);
      applyResult(result);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: message },
      ]);
      toast.error(message);
    } finally {
      setBusy(false);
      setStageLabel(null);
    }
  };

  const resetChat = async () => {
    if (!resumeId || busy) return;
    try {
      await clearResumeAiChat(resumeId);
      setMessages([]);
      setLastMatch(null);
      toast.success('Chat cleared');
    } catch {
      toast.error('Could not clear chat.');
    }
  };

  if (!open) return null;

  const roleLine = [meta?.job_title, meta?.company].filter(Boolean).join(' · ');

  return (
    <aside
      aria-label="Resume AI chat"
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-l bg-background"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <AssistantAvatar thinking={busy} />
        <div className="ml-1.5 min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Resume AI</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {roleLine || meta?.name || 'Edit this resume with AI'}
          </p>
        </div>
        {typeof meta?.match_score === 'number' ? <MatchScore score={meta.match_score} /> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void resetChat()}
          aria-label="New chat"
          disabled={busy || messages.length === 0}
        >
          <SquarePen />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close resume AI">
          <X />
        </Button>
      </header>

      <div ref={scrollerRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading job and chat history…
          </div>
        ) : loadError ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {loadError}
          </p>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-3 pb-1">
            <p className="text-base font-semibold tracking-tight">Change this resume with AI</p>
            <p className="text-sm text-muted-foreground">
              Paste a job description, ask for a match score, or refine the open content. Your
              conversation is saved with this resume.
            </p>
            {lastJd ? (
              <p className="rounded-xl border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Job context loaded
                {roleLine ? ` for ${roleLine}` : ''}. Ask to tailor or refine without pasting again.
              </p>
            ) : (
              <p className="rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">
                No saved job yet. Paste a full posting to tailor this resume.
              </p>
            )}
            <div className="flex flex-col items-start gap-1.5 pt-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => void send(s)}
                  className="rounded-full border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Sparkles className="mr-1.5 inline size-3 text-brand" />
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <div
                key={`${m.role}-${i}`}
                className={cn(
                  'rounded-2xl px-3 py-2 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'ml-6 bg-brand text-brand-foreground'
                    : 'mr-4 border bg-card text-foreground',
                )}
              >
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.content}</p>
              </div>
            ))}
            {busy && stageLabel ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {stageLabel}
              </p>
            ) : null}
            {lastMatch ? (
              <div className="rounded-2xl border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">Match analysis</p>
                  <MatchScore score={lastMatch.overall_score} />
                </div>
                {lastMatch.summary ? (
                  <p className="mt-2 text-sm text-foreground">{lastMatch.summary}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 pt-0">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={(t) => void send(t)}
          busy={busy || loading || !resumeId}
          placeholder="Ask to tailor, refine, or paste a job…"
          size="md"
        />
      </div>
    </aside>
  );
}

/** Mid-right edge tab that toggles the studio AI rail. */
export function StudioAiChatToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={open ? 'Close resume AI' : 'Open resume AI'}
      title={open ? 'Close resume AI' : 'Edit with AI'}
      className={cn(
        'studio-ai-tab group absolute top-1/2 right-0 z-30 flex h-28 w-8 -translate-y-1/2 flex-col items-center justify-center gap-1.5 rounded-l-xl text-white transition-[width] duration-200',
        'hover:w-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        open && 'studio-ai-tab--open',
      )}
    >
      <span aria-hidden className="studio-ai-tab__glow" />
      <span aria-hidden className="studio-ai-tab__shine" />
      <Sparkles className="studio-ai-tab__icon relative size-4 shrink-0 drop-shadow-[0_0_4px_rgba(255,255,255,0.8)]" />
      <span
        className="relative text-[11px] font-bold tracking-[0.2em] uppercase drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
      >
        AI
      </span>
    </button>
  );
}
