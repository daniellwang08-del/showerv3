import type { ReactNode } from 'react';
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
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'narrow' | 'default' | 'wide';
  className?: string;
}) {
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <PageTitle title={title} />
      <div
        className={cn(
          'mx-auto w-full px-4 pt-6 pb-24 sm:px-6',
          width === 'narrow' && 'max-w-2xl',
          width === 'default' && 'max-w-4xl',
          width === 'wide' && 'max-w-6xl',
          className,
        )}
      >
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
        {children}
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
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('scroll-mt-6 rounded-xl border bg-card', className)} aria-label={typeof title === 'string' ? title : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
