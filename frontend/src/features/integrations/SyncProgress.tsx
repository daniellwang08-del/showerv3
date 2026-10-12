import { Loader2 } from 'lucide-react';
import type { JobSiteSyncActivity } from '@/api/jobSitesApi';
import { cn } from '@/lib/utils';
import { summarizeSyncActivity } from './syncActivity';

/** Thin determinate/indeterminate line; indeterminate until the listing is back. */
export function SyncProgressLine({ percent, label, className }: { percent: number | null; label: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-brand/15', className)}
    >
      {percent == null ? (
        <div className="attachment-bar-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-brand motion-reduce:animate-none" />
      ) : (
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      )}
    </div>
  );
}

/** Label row plus progress line for one or more running syncs; renders nothing when idle. */
export function SyncProgress({ activity, className }: { activity: JobSiteSyncActivity[] | undefined; className?: string }) {
  const summary = summarizeSyncActivity(activity);
  if (!summary) return null;
  return (
    <div className={cn('space-y-1.5', className)} aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-brand motion-reduce:animate-none" />
        <span className="min-w-0 flex-1 truncate">{summary.label}</span>
        {summary.detail ? <span className="shrink-0 tabular-nums">{summary.detail}</span> : null}
      </div>
      <SyncProgressLine percent={summary.percent} label={summary.label} />
    </div>
  );
}
