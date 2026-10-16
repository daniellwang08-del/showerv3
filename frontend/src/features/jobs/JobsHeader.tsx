import type { ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';

/** Compact Jobs masthead over a slow multi-color aurora. */
export function JobsHeader({
  syncSlot,
  actions,
}: {
  syncSlot?: ReactNode;
  actions?: ReactNode;
}) {
  const reduceMotion = usePrefersReducedMotion();

  return (
    <header
      className={cn(
        'jobs-hero relative isolate shrink-0 overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs',
        !reduceMotion && 'jobs-hero--motion',
      )}
    >
      <div aria-hidden className="jobs-hero__aurora pointer-events-none absolute inset-0 -z-10">
        <span className="jobs-hero__blob jobs-hero__blob--a" />
        <span className="jobs-hero__blob jobs-hero__blob--b" />
        <span className="jobs-hero__blob jobs-hero__blob--c" />
        <span className="jobs-hero__blob jobs-hero__blob--d" />
        <span className="jobs-hero__sheen" />
        <span className="jobs-hero__veil" />
      </div>

      <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Jobs</h1>
          <p className="hidden truncate text-sm text-muted-foreground md:block">
            Every role you can act on, scored against your profile.
          </p>
        </div>

        {actions}

        {syncSlot}
      </div>
    </header>
  );
}
