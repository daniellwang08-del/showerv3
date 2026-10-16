import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';

/** Compact Jobs masthead over a slow multi-color aurora. */
export function JobsHeader({
  syncSlot,
  onJump,
}: {
  syncSlot?: ReactNode;
  onJump: () => void;
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

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onJump} className="hidden md:inline-flex">
            Jump to… <kbd className="ml-1 text-xs text-muted-foreground">⌘K</kbd>
          </Button>
          <Link to="/app/analysis" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <BarChart3 /> Insights
          </Link>
        </div>

        {syncSlot}
      </div>
    </header>
  );
}
