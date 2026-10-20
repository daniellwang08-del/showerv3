import { Gauge } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import {
  describeDuration,
  formatCount,
  formatRate,
  formatUsd,
  monthlyJobs,
  recommendPackage,
  totalCents,
  weeksCovered,
} from './plansModel';

export const PACE_MIN = 5;
export const PACE_MAX = 500;
const PACE_STEP = 5;

export function UsageEstimator({ jobsPerWeek, onChange }: { jobsPerWeek: number; onChange: (n: number) => void }) {
  const pick = recommendPackage(jobsPerWeek);
  const perMonth = monthlyJobs(jobsPerWeek);

  return (
    <section
      aria-labelledby="plans-estimator"
      className="grid gap-5 rounded-2xl border bg-card/90 p-5 shadow-xs backdrop-blur-sm md:grid-cols-[1.3fr_1fr] md:gap-8"
    >
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Gauge className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="plans-estimator" className="text-sm font-semibold tracking-tight">
              Find the right size
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">How many jobs do you want NAO to prepare each week?</p>
          </div>
        </div>

        <div className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="plans-pace" className="text-sm font-medium">
              Jobs per week
            </label>
            <output htmlFor="plans-pace" className="text-2xl font-semibold tabular-nums" aria-live="polite">
              {formatCount(jobsPerWeek)}
            </output>
          </div>
          <Slider
            id="plans-pace"
            className="mt-4"
            min={PACE_MIN}
            max={PACE_MAX}
            step={PACE_STEP}
            value={[jobsPerWeek]}
            onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
            aria-label="Jobs per week"
          />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{PACE_MIN}</span>
            <span>{PACE_MAX}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-4 rounded-xl border border-border/60 bg-muted/40 p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">About a month</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{formatCount(perMonth)} jobs</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Price per job</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{formatRate(pick.rateCents)}</dd>
          </div>
        </dl>
        <div>
          <p className="text-xs font-medium text-muted-foreground">We suggest</p>
          <p className="mt-0.5 text-lg font-semibold tracking-tight">
            {pick.name}, {formatCount(pick.credits)} credits for {formatUsd(totalCents(pick))}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Lasts {describeDuration(weeksCovered(pick, jobsPerWeek))} at this pace.
          </p>
        </div>
      </div>
    </section>
  );
}
