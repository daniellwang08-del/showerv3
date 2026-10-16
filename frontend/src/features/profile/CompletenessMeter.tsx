import { ArrowRight, CircleCheck, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProfileCompletionResult } from '@/utils/profileCompletion';
import { COMPLETION_SECTION, type FormSectionId } from './profileSections';

const MAX_SUGGESTIONS = 4;
const RING_RADIUS = 30;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function CompletenessMeter({
  completion,
  onSuggestion,
}: {
  completion: ProfileCompletionResult;
  onSuggestion: (section: FormSectionId) => void;
}) {
  const { requiredPercent, requiredFilled, requiredTotal, missingRequired, optionalItems } = completion;
  const suggestions = [
    ...missingRequired.map((m) => ({ ...m, required: true })),
    ...optionalItems.filter((o) => !o.done).map((o) => ({ id: o.id, label: o.label, required: false })),
  ].slice(0, MAX_SUGGESTIONS);
  const complete = missingRequired.length === 0;
  const optionalDone = optionalItems.filter((o) => o.done).length;

  return (
    <div
      className="jobs-summary-card relative overflow-hidden rounded-2xl border bg-card/90 p-4 shadow-xs backdrop-blur-sm sm:p-5"
      aria-label="Profile completeness"
    >
      <div className="flex flex-wrap items-center gap-5">
        <div
          className="relative size-[76px] shrink-0"
          role="progressbar"
          aria-label="Required fields complete"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={requiredPercent}
        >
          <svg viewBox="0 0 76 76" className="size-full -rotate-90" aria-hidden>
            <circle cx="38" cy="38" r={RING_RADIUS} fill="none" strokeWidth="7" className="stroke-muted" />
            <circle
              cx="38"
              cy="38"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - requiredPercent / 100)}
              className={cn('transition-[stroke-dashoffset] duration-700', complete ? 'stroke-match-strong' : 'stroke-brand')}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-base font-semibold tabular-nums">
            {requiredPercent}%
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            {complete ? <CircleCheck className="size-4 text-match-strong" aria-hidden /> : null}
            {complete ? 'Your profile is ready for tailoring' : 'Profile completeness'}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            {requiredFilled}/{requiredTotal} required
            {optionalItems.length ? ` · ${optionalDone}/${optionalItems.length} extras` : ''}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {complete
              ? 'Every tailored résumé and cover letter draws from this profile.'
              : 'Fill the required fields so NAO can tailor résumés and answer applications.'}
          </p>
        </div>

        {suggestions.length ? (
          <div className="w-full min-w-0 lg:w-auto lg:max-w-[46%]">
            <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              <Sparkles className="size-3 text-brand" aria-hidden />
              {complete ? 'Make it stronger' : 'Next best'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => {
                const section = COMPLETION_SECTION[s.id];
                if (!section) return null;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSuggestion(section)}
                    className={cn(
                      'group inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      s.required
                        ? 'border-brand/30 bg-brand/5 text-foreground hover:bg-brand/10'
                        : 'bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {s.required ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" /> : null}
                    <span className="truncate">{s.label}</span>
                    <ArrowRight className="size-3 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
