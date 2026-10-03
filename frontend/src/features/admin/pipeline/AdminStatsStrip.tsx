import type { ReactNode } from 'react';
import { CalendarDays, CircleAlert, Clock3, FileCheck2, FileSearch, Layers, Upload, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useScraperStore } from '@/stores/scraperStore';
import type { AdminScraperStats } from '@/types/scraper';
import { fmt, isoToMs, relativeAgo, runStatusTone, type AdminView } from './pipelineModel';

interface Props {
  stats: AdminScraperStats | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  activeView: AdminView;
  activeSource: string;
  onSelectView: (view: AdminView) => void;
  onSelectPlatform: (source: string) => void;
}

export function AdminStatsStrip({ stats, loading, error, onRetry, activeView, activeSource, onSelectView, onSelectPlatform }: Props) {
  const syncing = useScraperStore((s) => s.syncing);
  const progress = useScraperStore((s) => s.syncProgress);

  if (!stats) {
    if (error && !loading) {
      return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <span className="text-destructive">Couldn’t load pipeline stats.</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <div aria-busy="true" aria-label="Loading pipeline stats" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  }

  const today = stats.today_fetched ?? stats.today_scraped;
  const total = stats.total_jobs;
  const extracted = stats.extracted_jobs;
  const needs = stats.needs_extraction_jobs;
  const failed = stats.extraction_failed_jobs;
  const pending = stats.extraction_pending_jobs;
  const lastNew = stats.last_sync_items_new;
  const lastScraped = stats.last_sync_items_scraped ?? 0;
  const platforms = stats.platform_sync ?? [];
  const extractPct = total > 0 ? Math.round((extracted / total) * 100) : 0;
  const failPct = total > 0 ? (failed / total) * 100 : 0;
  const lastSyncMs = isoToMs(stats.last_sync_at);
  const trends = stats.trends;
  const trendMax = Math.max(1, ...(trends?.fetched ?? []), ...(trends?.extracted ?? []));
  const viewActive = (v: AdminView) => !activeSource && activeView === v;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <button
          type="button"
          onClick={() => onSelectView('today')}
          aria-pressed={viewActive('today')}
          className={tileClass(viewActive('today'), 'flex flex-col justify-between gap-3 p-4')}
        >
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CalendarDays className="size-3.5" /> Today&apos;s fetched
          </div>
          <div className="text-3xl font-semibold tabular-nums tracking-tight">{fmt(today)}</div>
          <div className="space-y-1.5">
            <div
              className="flex h-1.5 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${extractPct}% JD coverage, ${Math.round(failPct)}% failed`}
            >
              <span className="bg-status-ready" style={{ width: `${extractPct}%` }} />
              <span className="bg-status-failed" style={{ width: `${failPct}%` }} />
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {lastNew > 0
                ? `${fmt(lastNew)} new from last sync`
                : platforms.length > 0
                  ? `${platforms.length} job sites registered`
                  : 'New jobs added to the platform today'}
            </p>
            <p className="truncate text-xs tabular-nums text-muted-foreground">
              {failed > 0 ? `${fmt(extracted)} ready · ${fmt(failed)} failed` : `${fmt(extracted)} JD ready · ${extractPct}% coverage`}
            </p>
          </div>
        </button>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            icon={FileSearch}
            label="Extraction backlog"
            value={needs}
            hint={pending > 0 ? `${fmt(pending)} extracting now` : 'Unfinished JD pool'}
            title="Live unfinished JD pool — jobs still missing, pending, processing, or stuck mid-extract."
            active={viewActive('needs_extraction')}
            onClick={() => onSelectView('needs_extraction')}
            trend={<Sparkline values={trends?.fetched} labels={trends?.labels} max={trendMax} label="Fetched per day" className="text-status-preparing" />}
          />
          <Stat
            icon={FileCheck2}
            label="JD ready"
            value={extracted}
            hint={total > 0 ? `${extractPct}% of pool` : 'Completed JDs'}
            title="Jobs with a completed job description ready for applicants"
            active={viewActive('extracted')}
            onClick={() => onSelectView('extracted')}
            trend={<Sparkline values={trends?.extracted} labels={trends?.labels} max={trendMax} label="JD ready per day" className="text-status-ready" />}
          />
          <Stat
            icon={CircleAlert}
            label="Extraction failed"
            value={failed}
            hint={failed > 0 ? 'Open the failed board' : 'Nothing failed'}
            title={pending > 0 ? `${fmt(failed)} failed · ${fmt(pending)} still pending/processing` : 'Jobs whose JD extraction failed'}
            active={viewActive('extraction_failed')}
            onClick={() => onSelectView('extraction_failed')}
            valueClass={failed > 0 ? 'text-status-failed' : undefined}
          />
          <Stat
            icon={Layers}
            label="Total jobs"
            value={total}
            hint="Non-blocked pool"
            title="All non-blocked jobs in the platform pool"
            active={viewActive('all')}
            onClick={() => onSelectView('all')}
          />
          <Stat
            icon={Upload}
            label="Manual intake"
            value={stats.manual_jobs}
            hint="By URL or attachment"
            title="Jobs submitted by URL or attachment"
            active={viewActive('manual')}
            onClick={() => onSelectView('manual')}
          />
          <Stat
            icon={Clock3}
            label="New in last sync"
            value={syncing ? (progress?.itemsNew ?? lastNew) : lastNew}
            hint={
              syncing
                ? progress?.total
                  ? `Syncing ${progress.current}/${progress.total} · ${progress.itemsNew} new`
                  : progress?.message || 'Sync in progress…'
                : `${lastSyncMs != null ? relativeAgo(lastSyncMs) : 'Never synced'}${lastScraped > 0 ? ` · ${fmt(lastScraped)} scraped` : ''}`
            }
            title={
              stats.last_sync_spider
                ? `Last sync (${stats.last_sync_spider}): ${fmt(lastNew)} new · ${fmt(lastScraped)} scraped`
                : `Last sync: ${fmt(lastNew)} new job(s)`
            }
          />
          <Stat
            icon={Users}
            label="Total users"
            value={stats.total_users ?? 0}
            hint={(stats.new_users_week ?? 0) > 0 ? `${fmt(stats.new_users_week)} new this week` : 'No new signups this week'}
            title={`${fmt(stats.total_users)} accounts · ${fmt(stats.new_users_week)} created in the last 7 days`}
          />
        </div>
      </div>

      <div aria-label="Job sites" role="group" className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {platforms.length === 0 ? (
          <p className="text-xs text-muted-foreground">No job sites registered.</p>
        ) : (
          platforms.map((p) => {
            const ms = isoToMs(p.last_sync_at);
            const detail = [
              ms != null ? relativeAgo(ms) : 'No sync yet',
              p.last_items_new > 0 ? `+${fmt(p.last_items_new)} new` : p.last_items_scraped > 0 ? `${fmt(p.last_items_scraped)} scraped` : null,
              p.last_errors > 0 ? `${fmt(p.last_errors)} err` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            const active = activeSource === p.name;
            return (
              <button
                key={p.name}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectPlatform(p.name)}
                title={`${p.label}: ${fmt(p.job_count)} jobs in pool · last sync ${ms != null ? new Date(ms).toLocaleString() : 'never'}`}
                className={tileClass(active, 'flex min-w-40 shrink-0 flex-col gap-0.5 px-3 py-2')}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className={cn('size-1.5 rounded-full', ms != null || p.last_status ? runStatusTone(p.last_status, p.last_errors) : 'bg-muted-foreground/40')} />
                  <span className="truncate">{p.label}</span>
                </span>
                <span className="text-lg font-semibold tabular-nums">{fmt(p.job_count)}</span>
                <span className="truncate text-xs text-muted-foreground">{detail}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function tileClass(active: boolean, extra: string) {
  return cn(
    'min-w-0 rounded-xl border bg-card text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
    'enabled:hover:bg-muted/40',
    active && 'border-brand/50 bg-brand-soft/40 shadow-[inset_0_0_0_1px_var(--brand)]',
    extra,
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  title,
  active = false,
  onClick,
  trend,
  valueClass,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  hint: string;
  title?: string;
  active?: boolean;
  onClick?: () => void;
  trend?: ReactNode;
  valueClass?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className={cn('text-xl font-semibold tabular-nums tracking-tight', valueClass)}>{fmt(value)}</span>
        {trend}
      </span>
      <span className="truncate text-xs text-muted-foreground">{hint}</span>
    </>
  );
  const cls = tileClass(active, 'flex flex-col gap-1 px-3 py-2.5');
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} title={title} className={cls}>
      {body}
    </button>
  ) : (
    <div title={title} className={cls}>
      {body}
    </div>
  );
}

function Sparkline({
  values,
  labels,
  max,
  label,
  className,
}: {
  values?: number[];
  labels?: string[];
  max: number;
  label: string;
  className?: string;
}) {
  if (!values || values.length < 2) return null;
  const w = 56;
  const h = 18;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (Math.max(0, v) / max) * (h - 2) - 1).toFixed(1)}`)
    .join(' ');
  const summary = values.map((v, i) => `${labels?.[i] ?? i + 1}: ${v}`).join(', ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label} — ${summary}`} className={cn('hidden shrink-0 sm:block', className)}>
      <title>{`${label} — ${summary}`}</title>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
