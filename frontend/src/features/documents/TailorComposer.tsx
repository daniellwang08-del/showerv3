import { forwardRef, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ClipboardPaste, Loader2, PenLine, Sparkles, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { tailorFromJobDescription, type TailorResult } from '@/api/documentsApi';
import { cn } from '@/lib/utils';

const STAGES = [
  { id: 'analyzing', label: 'Reading the job' },
  { id: 'evidence', label: 'Finding proof' },
  { id: 'tailoring', label: 'Writing' },
  { id: 'saving', label: 'Saving' },
];
/** Finer server stages shown under the nearest step above. */
const STAGE_ALIAS: Record<string, string> = { reading: 'analyzing', quality: 'tailoring' };
const MIN_CHARS = 40;
const SUGGESTIONS = ['Lead with my strongest leadership work', 'Keep it to one page', 'Emphasise measurable impact'];

export const TailorComposer = forwardRef<HTMLTextAreaElement, { onDone: (result: TailorResult) => void }>(
  function TailorComposer({ onDone }, ref) {
    const [jd, setJd] = useState('');
    const [instructions, setInstructions] = useState('');
    const [showInstructions, setShowInstructions] = useState(false);
    const [running, setRunning] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    const run = async () => {
      const text = jd.trim();
      if (text.length < MIN_CHARS || running) {
        setError(text ? 'Paste the full job description (at least a few sentences).' : null);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError(null);
      setStage('analyzing');
      try {
        const result = await tailorFromJobDescription(
          text,
          instructions.trim(),
          (ev) => setStage(STAGE_ALIAS[ev.stage] ?? ev.stage),
          controller.signal,
        );
        setJd('');
        setInstructions('');
        setShowInstructions(false);
        onDone(result);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Tailoring failed. Please try again.');
      } finally {
        setRunning(false);
        setStage(null);
        abortRef.current = null;
      }
    };

    const paste = async () => {
      try {
        const text = await navigator.clipboard?.readText();
        if (text) setJd(text);
      } catch {
        setError('Clipboard access was blocked. Paste with Ctrl+V instead.');
      }
    };

    const stageIndex = STAGES.findIndex((s) => s.id === stage);
    const progress = running ? ((Math.max(stageIndex, 0) + 0.5) / STAGES.length) * 100 : 0;
    const chars = jd.trim().length;

    return (
      <section
        aria-label="Tailor to a job"
        className="docs-composer relative overflow-hidden rounded-2xl border bg-card/85 shadow-sm backdrop-blur-sm"
      >
        <div className="flex flex-wrap items-start gap-3 px-5 pt-5 sm:px-6">
          <span className="docs-composer__icon inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-md">
            <Wand2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-tight">Tailor to a job</h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Paste a job description. NAO rewrites your resume and writes a matching cover letter, then saves both here
              with the posting so you can revisit it before an interview.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 pt-4 pb-5 sm:px-6">
          <div className="group/jd relative rounded-xl border bg-background/70 transition focus-within:border-brand/50 focus-within:ring-4 focus-within:ring-brand/10">
            <Textarea
              ref={ref}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
              disabled={running}
              placeholder="Paste the full job description here"
              aria-label="Job description"
              className="max-h-[50dvh] min-h-36 resize-y border-0 bg-transparent px-4 pt-3.5 pb-10 text-sm shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
            />
            <div className="pointer-events-none absolute inset-x-3 bottom-2.5 flex items-center justify-between gap-2">
              <span className="pointer-events-auto">
                {!jd && !running && (
                  <button
                    type="button"
                    onClick={() => void paste()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-xs transition hover:border-brand/40 hover:text-brand"
                  >
                    <ClipboardPaste className="size-3.5" />
                    Paste from clipboard
                  </button>
                )}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] tabular-nums',
                  chars === 0
                    ? 'text-muted-foreground/70'
                    : chars < MIN_CHARS
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : 'bg-status-ready/10 text-emerald-700 dark:text-emerald-300',
                )}
              >
                {chars.toLocaleString()} chars
              </span>
            </div>
          </div>

          {showInstructions && (
            <div className="space-y-2">
              <div className="relative">
                <PenLine className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  disabled={running}
                  placeholder="Anything to emphasise? For example: lead with my Kubernetes work"
                  aria-label="Extra instructions"
                  className="h-10 rounded-xl pr-9 pl-9"
                />
                {!running && (
                  <button
                    type="button"
                    aria-label="Remove instructions"
                    onClick={() => {
                      setInstructions('');
                      setShowInstructions(false);
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              {!instructions && !running && (
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setInstructions(s)}
                      className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}

          {running && (
            <div className="space-y-2.5 rounded-xl border bg-muted/30 px-4 py-3" aria-live="polite">
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="docs-composer__progress h-full rounded-full transition-[width] duration-700 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                {STAGES.map((s, i) => (
                  <li
                    key={s.id}
                    className={cn(
                      'flex items-center gap-1.5',
                      i < stageIndex && 'text-emerald-700 dark:text-emerald-300',
                      i === stageIndex && 'font-semibold text-brand',
                      i > stageIndex && 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ring-1',
                        i < stageIndex && 'bg-status-ready/15 ring-status-ready/30',
                        i === stageIndex && 'bg-brand-soft ring-brand/30',
                        i > stageIndex && 'bg-background ring-border',
                      )}
                    >
                      {i < stageIndex ? (
                        <Check className="size-3" />
                      ) : i === stageIndex ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    {s.label}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!running && !showInstructions && (
              <Button variant="ghost" size="sm" onClick={() => setShowInstructions(true)}>
                <PenLine />
                Add instructions
              </Button>
            )}
            {!running && (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Ctrl</kbd> +{' '}
                <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Enter</kbd> to start
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {running && (
                <Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </Button>
              )}
              <button
                type="button"
                onClick={() => void run()}
                disabled={running || !jd.trim()}
                className={cn(
                  'docs-composer__cta group relative inline-flex h-10 items-center gap-2 overflow-hidden rounded-full px-5 text-sm font-semibold text-white outline-none transition-all',
                  'shadow-md hover:-translate-y-px hover:shadow-lg focus-visible:ring-4 focus-visible:ring-brand/25 active:translate-y-0',
                  'disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none',
                )}
              >
                {running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4 transition-transform group-hover:rotate-12" />}
                {running ? 'Tailoring…' : 'Tailor resume and letter'}
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  },
);
