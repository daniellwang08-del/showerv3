import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import { PageTitle } from './PageTitle';

/** Scrollable page body with the standard content width. */
export function PageLayout({
  title,
  description,
  actions,
  children,
  width = 'default',
  className,
  variant = 'plain',
  icon,
  meta,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'narrow' | 'default' | 'wide' | 'full';
  className?: string;
  /** `hero` adds the ambient backdrop and an aurora header card. */
  variant?: 'plain' | 'hero';
  icon?: LucideIcon;
  /** Extra row inside the hero header, e.g. summary stats. */
  meta?: ReactNode;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const hero = variant === 'hero';
  const Icon = icon;

  const body = (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <PageTitle title={title} />
      <div
        className={cn(
          'mx-auto w-full px-4 pt-6 pb-24 sm:px-6',
          width === 'narrow' && 'max-w-2xl',
          width === 'default' && 'max-w-4xl',
          width === 'wide' && 'max-w-6xl',
          width === 'full' && 'max-w-none lg:px-8',
          className,
        )}
      >
        {hero ? (
          <header
            className={cn(
              'jobs-hero relative isolate mb-6 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs',
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
            <div className="relative flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-6">
              <div className="flex min-w-0 items-center gap-3.5">
                {Icon ? (
                  <span
                    aria-hidden
                    className="hidden size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand/70 text-white shadow-md shadow-brand/25 sm:inline-flex"
                  >
                    <Icon className="size-5" />
                  </span>
                ) : null}
                <div className="min-w-0">
                  <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                  {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
                </div>
              </div>
              {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            {meta ? <div className="relative border-t border-border/50 px-5 py-3 sm:px-6">{meta}</div> : null}
          </header>
        ) : (
          <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
              {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </header>
        )}
        {children}
      </div>
    </div>
  );

  if (!hero) return body;
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className={cn('docs-backdrop pointer-events-none absolute inset-0 -z-10', !reduceMotion && 'docs-backdrop--motion')}
      >
        <span className="docs-backdrop__glow docs-backdrop__glow--a" />
        <span className="docs-backdrop__glow docs-backdrop__glow--b" />
        <span className="docs-backdrop__glow docs-backdrop__glow--c" />
        <span className="docs-backdrop__grid" />
      </div>
      {body}
    </div>
  );
}

/** Compact label/value chip for the hero header's `meta` row. */
export function HeroStat({
  icon: Icon,
  label,
  value,
  tone = 'text-brand bg-brand/10',
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 px-3 py-2 backdrop-blur">
      <span aria-hidden className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-lg', tone)}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

export function SectionCard({
  id,
  title,
  description,
  actions,
  children,
  className,
  icon: Icon,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-6 rounded-2xl border bg-card/90 shadow-xs backdrop-blur-sm transition-shadow hover:shadow-sm',
        className,
      )}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span
              aria-hidden
              className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
            >
              <Icon className="size-4" />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
