import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { applyMinMatchScore } from '@/api/settingsApi';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { SETTINGS_KEY, refreshJobStores, useSettingsQuery } from '@/features/settings/queries';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { MATCH_FILTERS } from './matchFilters';

const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
const sliderValue = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : v) as number;

interface Props {
  minScore: number;
  onMinScore: (v: number) => void;
}

function listFilterLabel(minScore: number): string {
  const preset = MATCH_FILTERS.find((f) => Number(f.value) === minScore);
  if (preset) return preset.label;
  if (minScore <= 0) return 'Any match';
  return `${minScore}+`;
}

export function MatchScoreFilter({ minScore, onMinScore }: Props) {
  const settingsQuery = useSettingsQuery();
  const queryClient = useQueryClient();
  const prefScore = settingsQuery.data?.min_match_score ?? 0;

  const [open, setOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [draftPref, setDraftPref] = useState(prefScore);
  const draftPrefRef = useRef(prefScore);
  const prefScoreRef = useRef(prefScore);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    prefScoreRef.current = prefScore;
    if (!adjusting) {
      setDraftPref(prefScore);
      draftPrefRef.current = prefScore;
    }
  }, [prefScore, adjusting]);

  useEffect(() => {
    return () => {
      if (applyTimer.current) clearTimeout(applyTimer.current);
    };
  }, []);

  const applyPref = useMutation({
    mutationFn: (score: number) =>
      applyMinMatchScore({
        min_match_score_mode: 'custom',
        min_match_score: score,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(SETTINGS_KEY, result.settings);
      setDraftPref(result.min_match_score);
      draftPrefRef.current = result.min_match_score;
      setAdjusting(false);
      const parts: string[] = [];
      if (result.hidden > 0) parts.push(`hid ${result.hidden}`);
      if (result.restored > 0) parts.push(`restored ${result.restored}`);
      toast.success(
        parts.length
          ? `Limit set to ${result.min_match_score} (${parts.join(', ')}).`
          : `Limit set to ${result.min_match_score}.`,
        {
          description:
            result.min_match_score > 0
              ? 'Upcoming jobs below this score stay hidden.'
              : 'All scored jobs can appear in Upcoming.',
        },
      );
      refreshJobStores();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Failed to update match limit.')),
  });

  const flushApply = (score: number) => {
    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
    }
    if (score === prefScoreRef.current || applyPref.isPending) return;
    applyPref.mutate(score);
  };

  const scheduleApply = (score: number) => {
    draftPrefRef.current = score;
    if (applyTimer.current) clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => flushApply(score), 450);
  };

  const busy = applyPref.isPending || settingsQuery.isPending;
  const matchActive = minScore > 0 || prefScore > 0;
  const triggerLabel = (() => {
    const list = listFilterLabel(minScore);
    if (settingsQuery.data == null) return list;
    return `${list} · ${prefScore}`;
  })();

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setAdjusting(false);
          flushApply(draftPrefRef.current);
        } else {
          setDraftPref(prefScoreRef.current);
          draftPrefRef.current = prefScoreRef.current;
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant={matchActive ? 'secondary' : 'outline'}
            size="sm"
            aria-label="Match score filter and preference"
            aria-haspopup="dialog"
            className={cn(
              'min-w-36 justify-between tabular-nums',
              matchActive && 'border-brand/40 bg-brand-soft text-brand',
            )}
          />
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="opacity-70" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 p-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">This list only</p>
          <p className="text-xs text-muted-foreground">
            These buttons hide low-scoring rows in the table you are looking at. They do not change your saved
            limit.
          </p>
        </div>

        <div className="flex flex-col gap-0.5" role="listbox" aria-label="List match filters">
          {MATCH_FILTERS.map((f) => {
            const selected = minScore === Number(f.value);
            return (
              <button
                key={f.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onMinScore(Number(f.value));
                  setOpen(false);
                }}
                className={cn(
                  'rounded-md px-2.5 py-2 text-left transition-colors',
                  selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/70',
                )}
              >
                <span className="block text-sm font-medium">{f.label}</span>
                <span className="block text-xs text-muted-foreground">{f.hint}</span>
              </button>
            );
          })}
        </div>

        <Separator />

        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Your saved limit</p>
            <p className="text-xs text-muted-foreground">
              Click the number, then drag the bar. New Upcoming jobs below this score are filtered out.
            </p>
          </div>

          <div className="flex items-center gap-4 rounded-lg border bg-muted/40 px-3 py-3">
            <button
              type="button"
              aria-label="Adjust saved match limit"
              aria-expanded={adjusting}
              disabled={busy}
              onClick={() => setAdjusting((v) => !v)}
              className={cn(
                'flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg border bg-card text-foreground shadow-sm transition-colors',
                'hover:border-brand/50 hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                adjusting && 'border-brand/50 bg-brand-soft ring-1 ring-brand/30',
                busy && 'opacity-60',
              )}
            >
              {applyPref.isPending ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <span className="text-xl font-semibold tabular-nums leading-none">{draftPref}</span>
              )}
              <span className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                limit
              </span>
            </button>

            {adjusting ? (
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Slider
                  orientation="vertical"
                  aria-label="Saved minimum match score"
                  min={0}
                  max={100}
                  step={1}
                  value={[draftPref]}
                  disabled={busy}
                  onValueChange={(v) => {
                    const next = clampScore(sliderValue(v));
                    setDraftPref(next);
                    scheduleApply(next);
                  }}
                  className="h-36"
                />
                <div className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                  <p>
                    Drag up for a higher bar (stricter). Drag down toward 0 to show more jobs.
                  </p>
                  <p className="font-medium text-foreground tabular-nums">
                    {draftPref <= 0 ? 'Show all scored jobs' : `Hide scores under ${draftPref}`}
                  </p>
                </div>
              </div>
            ) : (
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {prefScore <= 0
                  ? 'No limit yet. Click the number to set one.'
                  : `Jobs under ${prefScore} stay out of Upcoming after analysis.`}
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
