import type { ReactNode } from 'react';
import { ArrowUpRight, RotateCw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { primaryActionLabel, STATUS_LABEL, type IntegrationStatus, type StatusKind } from './status';

const DOT: Record<StatusKind, string> = {
  connected: 'bg-status-ready',
  attention: 'bg-status-preparing',
  off: 'bg-muted-foreground/60',
  not_connected: 'border border-muted-foreground/50',
  unavailable: 'bg-muted-foreground/30',
};

const BADGE_TONE: Record<StatusKind, string> = {
  connected: 'border-status-ready/30 bg-status-ready/10 text-foreground',
  attention: 'border-status-preparing/40 bg-status-preparing/10 text-foreground',
  off: 'text-muted-foreground',
  not_connected: 'text-muted-foreground',
  unavailable: 'text-muted-foreground',
};

/** Thin top stripe that tints a card by its connection state. */
export const STATUS_ACCENT: Record<StatusKind, string> = {
  connected: 'bg-gradient-to-r from-status-ready/80 to-status-ready/20',
  attention: 'bg-gradient-to-r from-status-preparing to-status-preparing/30',
  off: 'bg-muted-foreground/20',
  not_connected: 'bg-transparent',
  unavailable: 'bg-transparent',
};

export function StatusBadge({ kind }: { kind: StatusKind }) {
  return (
    <Badge variant="outline" data-status={kind} className={cn('gap-1.5 font-normal', BADGE_TONE[kind])}>
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[kind], kind === 'connected' && 'animate-pulse')} />
      {STATUS_LABEL[kind]}
    </Badge>
  );
}

export function IntegrationLogo({ name, src, size = 'default' }: { name: string; src?: string; size?: 'default' | 'lg' }) {
  return (
    <Avatar
      className={cn(
        'rounded-xl border border-border/60 bg-background shadow-xs after:rounded-xl',
        size === 'lg' ? 'size-11' : 'size-10',
      )}
    >
      {src ? <AvatarImage src={src} alt="" className="rounded-xl object-contain p-1.5" /> : null}
      <AvatarFallback className="rounded-xl bg-gradient-to-br from-brand/15 to-brand/5 font-semibold text-brand">
        {name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

export function IntegrationCard({
  name,
  description,
  logoSrc,
  status,
  onOpen,
}: {
  name: string;
  description: string;
  logoSrc?: string;
  status: IntegrationStatus;
  onOpen: () => void;
}) {
  const unavailable = status.kind === 'unavailable';
  return (
    <article
      aria-label={name}
      data-status={status.kind}
      onClick={onOpen}
      className={cn(
        'jobs-summary-card group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card/90 p-4 shadow-xs backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-md',
        unavailable && 'opacity-75 hover:translate-y-0 hover:border-border hover:shadow-xs',
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5', STATUS_ACCENT[status.kind])} />
      <div className="flex items-start gap-3">
        <IntegrationLogo name={name} src={logoSrc} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-sm font-semibold break-words">{name}</h3>
            <span className="shrink-0">
              <StatusBadge kind={status.kind} />
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <p
        className={cn(
          'mt-3 line-clamp-2 min-h-4 text-xs tabular-nums text-muted-foreground',
          status.kind === 'attention' && 'text-destructive',
        )}
      >
        {status.detail ?? ''}
      </p>
      <div className="mt-auto pt-3">
        <Button
          variant={status.kind === 'not_connected' ? 'default' : 'outline'}
          size="sm"
          className={cn('w-full', status.kind !== 'not_connected' && 'bg-background/60')}
          aria-label={`${primaryActionLabel(status.kind)} ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {primaryActionLabel(status.kind)}
          {unavailable ? null : (
            <ArrowUpRight className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          )}
        </Button>
      </div>
    </article>
  );
}

export function IntegrationCardSkeleton() {
  return (
    <div className="flex flex-col rounded-2xl border bg-card/80 p-4" aria-hidden>
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 rounded-xl" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </div>
      <Skeleton className="mt-4 h-3 w-2/3" />
      <Skeleton className="mt-4 h-7 w-full" />
    </div>
  );
}

export function IntegrationCardError({ name, message, onRetry }: { name: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col rounded-2xl border border-destructive/30 bg-card/90 p-4 backdrop-blur-sm">
      <h3 className="text-sm font-semibold">{name}</h3>
      <p className="mt-1 text-xs text-destructive">{message}</p>
      <div className="mt-auto pt-3">
        <Button variant="outline" size="sm" className="w-full" onClick={onRetry}>
          <RotateCw />
          Retry
        </Button>
      </div>
    </div>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}
