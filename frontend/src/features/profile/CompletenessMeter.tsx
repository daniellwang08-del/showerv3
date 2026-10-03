import { ArrowRight, CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { ProfileCompletionResult } from '@/utils/profileCompletion';
import { COMPLETION_SECTION, type FormSectionId } from './profileSections';

const MAX_SUGGESTIONS = 3;

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

  return (
    <div className="rounded-xl border bg-card p-4" aria-label="Profile completeness">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">
              {complete ? 'Your profile is ready for tailoring' : 'Profile completeness'}
            </p>
            <p className="text-sm tabular-nums">
              <span className={cn('font-semibold', complete ? 'text-match-strong' : 'text-foreground')}>
                {requiredPercent}%
              </span>
              <span className="text-muted-foreground">
                {' '}
                · {requiredFilled}/{requiredTotal} required
              </span>
            </p>
          </div>
          <Progress value={requiredPercent} className="mt-2" aria-label="Required fields complete" />
        </div>
        {complete ? <CircleCheck className="size-5 shrink-0 text-match-strong" aria-hidden /> : null}
      </div>
      {suggestions.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{complete ? 'Make it stronger:' : 'Next best:'}</span>
          {suggestions.map((s) => {
            const section = COMPLETION_SECTION[s.id];
            if (!section) return null;
            return (
              <Button
                key={s.id}
                type="button"
                variant="outline"
                size="xs"
                className="max-w-full"
                onClick={() => onSuggestion(section)}
              >
                <span className="truncate">{s.label}</span>
                <ArrowRight />
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
