import { lazy, Suspense, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { extractErrorMessage, type ChartRow, type ChartSeries, type ChartValueFormat } from './dataUtils';

const LineSeriesChart = lazy(() => import('./DataCharts'));

export const CHART_HEIGHT = 260;
export const WIDE_CHART_HEIGHT = 320;

export type QueryState = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  isFetching?: boolean;
};

export function ChartBlock({
  title,
  hideTitle,
  summary,
  query,
  data,
  series,
  emptyText,
  errorFallback = 'Failed to load this chart.',
  height = CHART_HEIGHT,
  format,
}: {
  title: string;
  hideTitle?: boolean;
  summary?: string;
  query: QueryState;
  data: ChartRow[] | undefined;
  series: ChartSeries[];
  emptyText: string;
  errorFallback?: string;
  height?: number;
  format?: ChartValueFormat;
}) {
  let content: ReactNode;
  if (query.isPending) content = <Skeleton className="w-full rounded-lg" style={{ height: height + 28 }} />;
  else if (query.isError)
    content = (
      <div className="flex items-center justify-center rounded-lg border border-dashed" style={{ height }}>
        <InlineError compact message={extractErrorMessage(query.error, errorFallback)} onRetry={() => void query.refetch()} />
      </div>
    );
  else if (!data || series.length === 0)
    content = (
      <p
        className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyText}
      </p>
    );
  else
    content = (
      <Suspense fallback={<Skeleton className="w-full rounded-lg" style={{ height: height + 28 }} />}>
        <LineSeriesChart data={data} series={series} height={height} format={format} />
      </Suspense>
    );

  return (
    <figure className="min-w-0" aria-label={title} aria-busy={query.isPending || undefined}>
      {hideTitle ? null : (
        <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {summary ? <p className="text-xs text-muted-foreground tabular-nums">{summary}</p> : null}
        </figcaption>
      )}
      {content}
    </figure>
  );
}

export function InlineError({ message, onRetry, compact }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-3',
        compact ? 'text-sm' : 'justify-between rounded-xl border bg-card px-5 py-4',
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
        {message}
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function BlockedChart({ message }: { message: string }) {
  return (
    <p className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {message}
    </p>
  );
}
