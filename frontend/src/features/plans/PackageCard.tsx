import { Check, Crown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  type CreditPackage,
  describeDuration,
  formatCount,
  formatRate,
  formatUsd,
  savingsCents,
  savingsPercent,
  totalCents,
  weeksCovered,
} from './plansModel';

const BADGE = {
  popular: { label: 'Most popular', icon: Sparkles },
  value: { label: 'Best value', icon: Crown },
} as const;

export function PackageCard({
  pkg,
  jobsPerWeek,
  fitsPace,
  onBuy,
}: {
  pkg: CreditPackage;
  jobsPerWeek: number;
  fitsPace: boolean;
  onBuy: (pkg: CreditPackage) => void;
}) {
  const badge = pkg.badge ? BADGE[pkg.badge] : null;
  const featured = pkg.badge === 'popular';
  const saved = savingsPercent(pkg);

  return (
    <article
      aria-label={`${pkg.name} package`}
      className={cn(
        'relative flex flex-col rounded-2xl border bg-card/90 p-5 shadow-xs backdrop-blur-sm transition hover:-translate-y-0.5 hover:shadow-md',
        featured && 'border-brand/60 ring-1 ring-brand/40 shadow-brand/10',
        fitsPace && !featured && 'border-status-ready/50',
      )}
    >
      {featured ? (
        <span aria-hidden className="absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-brand to-transparent" />
      ) : null}

      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        {badge ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
              featured ? 'bg-brand text-brand-foreground shadow-sm' : 'bg-chart-4/15 text-chart-4',
            )}
          >
            <badge.icon className="size-3" aria-hidden />
            {badge.label}
          </span>
        ) : null}
        {fitsPace ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-ready/15 px-2 py-0.5 text-[11px] font-semibold text-status-ready">
            <Check className="size-3" aria-hidden />
            Fits your pace
          </span>
        ) : null}
      </div>

      <h3 className="mt-3 text-base font-semibold tracking-tight">{pkg.name}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">{pkg.tagline}</p>

      <p className="mt-5 flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tracking-tight tabular-nums">{formatCount(pkg.credits)}</span>
        <span className="text-sm font-medium text-muted-foreground">credits</span>
      </p>

      <div className="mt-4 flex items-end justify-between gap-3 rounded-xl border border-border/60 bg-muted/40 px-3.5 py-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{formatUsd(totalCents(pkg))}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{formatRate(pkg.rateCents)}</span> per job
          </p>
        </div>
        {saved > 0 ? (
          <span className="rounded-lg bg-status-ready/15 px-2 py-1 text-xs font-semibold text-status-ready tabular-nums">
            Save {saved}%
          </span>
        ) : (
          <span className="rounded-lg bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Base rate</span>
        )}
      </div>

      <ul className="mt-4 flex-1 space-y-2 text-sm">
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <span>
            Prepares <span className="font-medium tabular-nums">{formatCount(pkg.credits)}</span> jobs, ready to apply
          </span>
        </li>
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <span>
            Lasts {describeDuration(weeksCovered(pkg, jobsPerWeek))} at {formatCount(jobsPerWeek)} jobs a week
          </span>
        </li>
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <span>
            {savingsCents(pkg) > 0
              ? `${formatUsd(savingsCents(pkg))} less than the base rate`
              : 'Credits never expire'}
          </span>
        </li>
      </ul>

      <Button
        size="lg"
        variant={featured ? 'default' : 'outline'}
        className={cn('mt-5 h-10 w-full rounded-xl font-semibold', featured && 'shadow-sm shadow-brand/20')}
        onClick={() => onBuy(pkg)}
      >
        Buy {formatCount(pkg.credits)} credits
      </Button>
    </article>
  );
}
