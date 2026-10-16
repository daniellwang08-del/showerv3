import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';

const HORIZON_SRC = '/brand/nao-horizon.jpg';

/** Compact Jobs page masthead: horizon key art, soft motion, clear actions. */
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
        'jobs-hero relative isolate overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs',
        !reduceMotion && 'jobs-hero--motion',
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <img
          src={HORIZON_SRC}
          alt=""
          className={cn(
            'jobs-hero__art absolute inset-0 h-full w-full object-cover object-[62%_38%] opacity-[0.42] dark:opacity-[0.5]',
            !reduceMotion && 'jobs-hero__art--drift',
          )}
        />
        <div className="absolute inset-0 bg-gradient-to-r from-card via-card/92 to-card/55 dark:from-card dark:via-card/88 dark:to-card/40" />
        <div className="absolute inset-0 bg-gradient-to-t from-card via-transparent to-card/40" />
        <div
          className={cn(
            'jobs-hero__wash absolute -left-1/4 top-[-40%] h-[160%] w-[70%] rounded-full bg-brand/10 blur-3xl dark:bg-sky-400/12',
            !reduceMotion && 'jobs-hero__wash--pulse',
          )}
        />
      </div>

      <div className="relative flex flex-wrap items-end justify-between gap-4 px-4 py-5 sm:px-5 md:px-6">
        <div className={cn('min-w-0 max-w-xl', !reduceMotion && 'jobs-hero__copy')}>
          <p className="text-xs font-medium tracking-[0.14em] text-brand uppercase">Workspace</p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground sm:text-[1.7rem]">
            Jobs
          </h1>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            Every role you can act on, scored against your profile and ready when you are.
          </p>
        </div>

        <div className={cn('flex flex-wrap items-center gap-2', !reduceMotion && 'jobs-hero__actions')}>
          <Button variant="ghost" size="sm" onClick={onJump} className="hidden md:inline-flex">
            Jump to… <kbd className="ml-1 text-xs text-muted-foreground">⌘K</kbd>
          </Button>
          <Link to="/app/analysis" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <BarChart3 /> Insights
          </Link>
        </div>
      </div>

      {syncSlot ? <div className="relative border-t border-border/50 px-4 py-2.5 sm:px-5 md:px-6">{syncSlot}</div> : null}
    </header>
  );
}
