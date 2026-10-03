import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
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

export function StatusBadge({ kind }: { kind: StatusKind }) {
  return (
    <Badge
      variant="outline"
      data-status={kind}
      className={cn('gap-1.5 font-normal text-muted-foreground', kind === 'attention' && 'text-foreground')}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[kind])} />
      {STATUS_LABEL[kind]}
    </Badge>
  );
}

export function IntegrationLogo({ name, src, size = 'default' }: { name: string; src?: string; size?: 'default' | 'lg' }) {
  return (
    <Avatar
      className={cn(
        'rounded-lg bg-muted after:rounded-lg',
        size === 'lg' ? 'size-10' : 'size-9',
      )}
    >
      {src ? <AvatarImage src={src} alt="" className="rounded-lg object-contain p-1.5" /> : null}
      <AvatarFallback className="rounded-lg font-medium text-foreground">
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
      onClick={onOpen}
      className={cn(
        'group flex cursor-pointer flex-col rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40',
        unavailable && 'opacity-80',
      )}
    >
      <div className="flex items-start gap-3">
        <IntegrationLogo name={name} src={logoSrc} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-sm font-medium break-words">{name}</h3>
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
          className="w-full"
          aria-label={`${primaryActionLabel(status.kind)} ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {primaryActionLabel(status.kind)}
        </Button>
      </div>
    </article>
  );
}

export function IntegrationCardSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border bg-card p-4" aria-hidden>
      <div className="flex items-start gap-3">
        <Skeleton className="size-9 rounded-lg" />
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
    <div role="alert" className="flex flex-col rounded-xl border bg-card p-4">
      <h3 className="text-sm font-medium">{name}</h3>
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
