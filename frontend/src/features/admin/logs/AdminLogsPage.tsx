import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PageLayout } from '@/components/app/PageLayout';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { fetchSystemLogStats, fetchSystemLogs, purgeSystemLogs } from '@/api/systemLogsApi';
import type { SystemLogEvent, SystemLogStats } from '@/types/systemLogs';
import { LogsFilters } from './LogsFilters';
import { LogsTable } from './LogsTable';
import { LogsPagination } from './LogsPagination';
import { LogDetailSheet, type LogPanel } from './LogDetailSheet';
import {
  MATCH_TIMING_EVENT,
  TEXT_KEYS,
  draftsOf,
  errDetail,
  hasActiveFilters,
  readFilters,
  toQuery,
  writeFilters,
  type LogFilters,
  type TextDrafts,
} from './logFilters';

const LIVE_INTERVAL_MS = 5000;

function StatTile({ label, value, hint, loading }: { label: string; value: string; hint?: string; loading: boolean }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-1.5 h-6 w-16" />
      ) : (
        <p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
      )}
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function StatsRow({ stats, total, hours, loading }: { stats?: SystemLogStats; total: number; hours: number; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Events" value={(stats?.total ?? total).toLocaleString()} hint={`Last ${hours}h`} loading={loading} />
      <StatTile label="Error rate" value={`${stats?.error_rate ?? 0}%`} hint="error + critical" loading={loading} />
      <StatTile
        label="HTTP"
        value={(stats?.by_category?.http ?? 0).toLocaleString()}
        hint={`Workers: ${(stats?.by_category?.worker ?? 0).toLocaleString()}`}
        loading={loading}
      />
      <StatTile
        label="Retention"
        value={`${stats?.retention_days ?? 14}d`}
        hint="Auto-purged on API start"
        loading={loading}
      />
    </div>
  );
}

function downloadJson(items: SystemLogEvent[], filters: LogFilters) {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `system-logs-${filters.hours}h-p${filters.page}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AdminLogsPage({ standalone = false }: { standalone?: boolean }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const [live, setLive] = useState(false);
  const [panel, setPanel] = useState<LogPanel | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);

  const committedKey = TEXT_KEYS.map((k) => filters[k]).join('\u0000');
  const [draftState, setDraftState] = useState(() => ({ key: committedKey, drafts: draftsOf(filters) }));
  let drafts = draftState.drafts;
  if (draftState.key !== committedKey) {
    drafts = draftsOf(filters);
    setDraftState({ key: committedKey, drafts });
  }
  const dirty = TEXT_KEYS.some((k) => drafts[k].trim() !== filters[k]);

  const update = (patch: Partial<LogFilters>) => {
    setParams(writeFilters({ ...filters, ...patch }), { replace: true });
  };
  const trimmedDrafts = (): TextDrafts =>
    Object.fromEntries(TEXT_KEYS.map((k) => [k, drafts[k].trim()])) as TextDrafts;

  const list = useQuery({
    queryKey: ['admin-logs', 'list', toQuery(filters)],
    queryFn: () => fetchSystemLogs(toQuery(filters)),
    placeholderData: keepPreviousData,
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });
  const stats = useQuery({
    queryKey: ['admin-logs', 'stats', filters.hours],
    queryFn: () => fetchSystemLogStats(filters.hours),
    refetchInterval: live ? LIVE_INTERVAL_MS : false,
  });

  const purge = useMutation({
    mutationFn: () => purgeSystemLogs(),
    onSuccess: (res) => {
      setPurgeOpen(false);
      toast.success(`Purged ${res.deleted.toLocaleString()} old event${res.deleted === 1 ? '' : 's'}`);
      if (filters.page !== 1) update({ page: 1 });
      void queryClient.invalidateQueries({ queryKey: ['admin-logs'] });
    },
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = list.data?.pages ?? 1;
  const refreshing = list.isFetching || stats.isFetching;
  const retentionDays = stats.data?.retention_days ?? 14;
  const filtered = hasActiveFilters(filters);

  const refresh = () => {
    void list.refetch();
    void stats.refetch();
  };

  const clearFilters = () =>
    update({ level: '', category: '', service: '', path: '', event: '', request: '', job: '', user: '', page: 1 });

  const byService = Object.entries(stats.data?.by_service ?? {}).sort((a, b) => b[1] - a[1]);

  const empty = (
    <Empty className="border-0 py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ScrollText />
        </EmptyMedia>
        <EmptyTitle>{filtered ? 'No log events match these filters' : 'No log events yet'}</EmptyTitle>
        <EmptyDescription>
          {filtered
            ? 'Try a wider time window or clear the filters.'
            : `Nothing was recorded in the last ${filters.hours}h.`}
        </EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );

  const actions = (
    <>
      <label className="mr-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Switch checked={live} onCheckedChange={setLive} aria-label="Live tail" />
        <span className={cn(live && 'text-foreground')}>Live</span>
        {live ? <span className="size-2 animate-pulse rounded-full bg-status-ready" aria-hidden /> : null}
      </label>
      <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
        <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => downloadJson(items, filters)}
        disabled={items.length === 0}
        aria-label="Export this page as JSON"
      >
        <Download /> <span className="hidden sm:inline">Export</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={() => {
          purge.reset();
          setPurgeOpen(true);
        }} className="text-destructive hover:text-destructive">
        <Trash2 /> Purge old
      </Button>
    </>
  );

  const content = (
    <PageLayout
      title={standalone ? 'NAO system logs' : 'Logs'}
      description="Request/response lifecycle, worker tasks, and process events across the platform."
      actions={<div className="flex flex-wrap items-center gap-2">{actions}</div>}
      width="wide"
      className={cn(standalone && 'max-w-7xl pb-8')}
    >
      <div className="space-y-4">
        {list.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              {errDetail(list.error, 'Failed to load system logs')}
            </span>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw /> Retry
            </Button>
          </div>
        ) : null}

        <StatsRow stats={stats.data} total={total} hours={filters.hours} loading={stats.isPending} />

        <section aria-label="Filters" className="rounded-xl border bg-card p-4">
          <LogsFilters
            filters={filters}
            drafts={drafts}
            dirty={dirty}
            onDraft={(key, value) => setDraftState((s) => ({ ...s, drafts: { ...s.drafts, [key]: value } }))}
            onChange={(patch) => update({ ...patch, page: 1 })}
            onApply={() => update({ ...trimmedDrafts(), page: 1 })}
            onClear={clearFilters}
            onMatchTimings={() => update({ ...trimmedDrafts(), event: MATCH_TIMING_EVENT, page: 1 })}
            onJobTimeline={(id) => setPanel({ kind: 'job', id })}
          />
          {byService.length > 0 ? (
            <div className="mt-4 border-t pt-3">
              <p className="mb-2 text-xs text-muted-foreground">By service ({filters.hours}h)</p>
              <div className="flex flex-wrap gap-1.5">
                {byService.map(([name, count]) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={filters.service === name}
                    onClick={() => update({ service: filters.service === name ? '' : name, page: 1 })}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50',
                      filters.service === name && 'border-brand/40 bg-brand-soft text-brand hover:bg-brand-soft',
                    )}
                  >
                    {name}
                    <span className="tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section aria-label="Log events" className="overflow-hidden rounded-xl border bg-card">
          <LogsTable
            items={items}
            loading={list.isPending}
            activeId={panel?.kind === 'record' ? panel.event.id : null}
            onOpen={(event) => setPanel({ kind: 'record', event })}
            onOpenRequest={(id) => setPanel({ kind: 'request', id })}
            empty={list.isError ? null : empty}
          />
          <LogsPagination
            page={filters.page}
            pages={pages}
            total={total}
            perPage={filters.perPage}
            disabled={list.isFetching && list.isPlaceholderData}
            onPage={(page) => update({ page })}
            onPerPage={(perPage) => update({ perPage, page: 1 })}
          />
        </section>
      </div>

      <LogDetailSheet panel={panel} hours={filters.hours} onPanel={setPanel} />

      <AlertDialog open={purgeOpen} onOpenChange={(open) => !purge.isPending && setPurgeOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Purge old system logs?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes log events older than the retention window ({retentionDays} days). Recent activity is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {purge.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errDetail(purge.error, 'Purge failed')}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purge.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={purge.isPending} onClick={() => purge.mutate()}>
              {purge.isPending ? 'Purging…' : 'Purge'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );

  if (!standalone) return content;
  return (
    <div data-testid="logs-standalone" className="h-dvh bg-background text-foreground">
      {content}
    </div>
  );
}
