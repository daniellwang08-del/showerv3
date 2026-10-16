import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  BarChart3,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  Gauge,
  Layers,
  type LucideIcon,
  MessageSquare,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Table2,
  ThumbsUp,
  UserRound,
  Wifi,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { PageTitle } from '@/components/app/PageTitle';
import { fetchWeeklyProgress } from '@/api/scraperApi';
import { useJobStats } from '@/features/jobs/queries';
import { relativeTime } from '@/features/integrations/status';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useScraperStore } from '@/stores/scraperStore';
import { useShellStore } from '@/stores/shellStore';
import { cn } from '@/lib/utils';
import type { ScraperStats } from '@/types/scraper';
import type { ActivitySeries, TrendSeries } from './InsightsCharts';
import {
  buildActivityRows,
  buildMatchQuality,
  buildOverviewTiles,
  buildPipeline,
  buildTodayTiles,
  buildTrendRows,
  fmt,
  isEmptyPool,
  sumBy,
  topSources,
  type BoardFilters,
  type InsightTile,
  type PipelineStage,
  type TileKey,
} from './insightsData';

let chartsModule: Promise<typeof import('./InsightsCharts')> | undefined;
const loadCharts = () => (chartsModule ??= import('./InsightsCharts'));
const ActivityChart = lazy(() => loadCharts().then((m) => ({ default: m.ActivityChart })));
const TrendChart = lazy(() => loadCharts().then((m) => ({ default: m.TrendChart })));
const MatchDonut = lazy(() => loadCharts().then((m) => ({ default: m.MatchDonut })));

const TILE_ICONS: Record<TileKey, LucideIcon> = {
  today: CalendarDays,
  today_remote: Wifi,
  today_ready: Rocket,
  applied_today: ClipboardCheck,
  total: Layers,
  applied: ClipboardCheck,
  good: ThumbsUp,
  strong: Sparkles,
  avg: Gauge,
  remote: Wifi,
  mine: UserRound,
  sheets: Table2,
  pumble: MessageSquare,
};

const TILE_TONE: Partial<Record<TileKey, string>> = {
  today: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  today_remote: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
  today_ready: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  applied_today: 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-300',
  applied: 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-300',
  good: 'bg-brand/12 text-brand',
  strong: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  avg: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  remote: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
};
const NEUTRAL_TONE = 'bg-foreground/[0.06] text-foreground';

const STAGE_COLOR: Record<PipelineStage['key'], string> = {
  applied: 'bg-status-applied',
  ready: 'bg-status-ready',
  scored: 'bg-status-preparing',
  unscored: 'bg-muted-foreground/30',
};

const ACTIVITY_SERIES: ActivitySeries[] = [
  { key: 'posted', label: 'New jobs', color: 'var(--chart-4)', kind: 'area' },
  { key: 'recommended', label: 'Above your minimum', color: 'var(--chart-1)', kind: 'line' },
  { key: 'applied', label: 'Applied', color: 'var(--status-ready)', kind: 'bar' },
];
const READY_SERIES: TrendSeries[] = [
  { key: 'ready', label: 'Documents ready', color: 'var(--chart-2)', kind: 'bar' },
  { key: 'applied', label: 'Applied', color: 'var(--status-applied)', kind: 'bar' },
];
const REMOTE_SERIES: TrendSeries[] = [
  { key: 'remote', label: 'Remote jobs added', color: 'var(--chart-4)', kind: 'area' },
  { key: 'best', label: 'Strong matches', color: 'var(--chart-1)', kind: 'line' },
];
const RANGES = [7, 30] as const;

export function InsightsPage() {
  const navigate = useNavigate();
  const reduceMotion = usePrefersReducedMotion();
  const stats = useJobStats();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const progress = useQuery({
    queryKey: ['jobs', 'weekly-progress', days],
    queryFn: () => fetchWeeklyProgress(days),
    staleTime: 60_000,
    enabled: !!stats.data && !isEmptyPool(stats.data),
  });

  const goJobs = (filters: BoardFilters) => {
    useScraperStore.getState().applyAgentDashboard({ reset: true, ...filters });
    navigate('/app/jobs');
  };

  const refresh = () => {
    void stats.refetch();
    void progress.refetch();
  };

  const updatedAt = stats.dataUpdatedAt
    ? new Date(stats.dataUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  let body;
  if (stats.isPending) body = <InsightsSkeleton />;
  else if (stats.isError && !stats.data) body = <InsightsError onRetry={() => void stats.refetch()} />;
  else if (stats.data && isEmptyPool(stats.data))
    body = (
      <InsightsEmpty
        onAddJobs={() => navigate('/app/jobs')}
        onAsk={() => useShellStore.getState().setAssistantDocked(true)}
      />
    );
  else if (stats.data)
    body = (
      <InsightsBody
        stats={stats.data}
        onSelect={goJobs}
        activity={
          <ActivityCard
            days={days}
            onDays={setDays}
            loading={progress.isPending}
            failed={progress.isError}
            rows={buildActivityRows(progress.data)}
            minScore={progress.data?.min_match_score}
          />
        }
      />
    );

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
      <div aria-hidden className={cn('docs-backdrop pointer-events-none absolute inset-0 -z-10', !reduceMotion && 'docs-backdrop--motion')}>
        <span className="docs-backdrop__glow docs-backdrop__glow--a" />
        <span className="docs-backdrop__glow docs-backdrop__glow--b" />
        <span className="docs-backdrop__glow docs-backdrop__glow--c" />
        <span className="docs-backdrop__grid" />
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <PageTitle title="Insights" />
        <div className="mx-auto w-full max-w-6xl space-y-6 px-4 pt-6 pb-24 sm:px-6">
          <header
            className={cn(
              'jobs-hero relative isolate overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs',
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
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                  Your pipeline, match quality and momentum. Select any number to open those jobs.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {updatedAt ? (
                  <span className="hidden rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur sm:inline">
                    Updated {updatedAt}
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full bg-background/70 backdrop-blur"
                  onClick={refresh}
                  disabled={stats.isFetching}
                >
                  <RefreshCw className={cn(stats.isFetching && 'animate-spin')} />
                  Refresh
                </Button>
              </div>
            </div>
          </header>
          {body}
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  actions,
  children,
  className,
  label,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section
      aria-label={label ?? title}
      className={cn('jobs-summary-card min-w-0 rounded-2xl border bg-card/85 shadow-xs backdrop-blur-sm', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="px-5 pt-3 pb-5">{children}</div>
    </section>
  );
}

function InsightsBody({
  stats,
  onSelect,
  activity,
}: {
  stats: ScraperStats;
  onSelect: (f: BoardFilters) => void;
  activity: ReactNode;
}) {
  const today = buildTodayTiles(stats);
  const overview = buildOverviewTiles(stats);
  const pipeline = buildPipeline(stats);
  const quality = buildMatchQuality(stats);
  const trends = buildTrendRows(stats);
  const sources = topSources(stats);
  const scored = quality.reduce((s, x) => s + x.value, 0);

  return (
    <div className="space-y-6">
      <section aria-labelledby="insights-today" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
          <h2 id="insights-today" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Today
          </h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {fmt(stats.today_scraped)} new · {fmt(stats.today_remote)} remote · {fmt(stats.applied_today)} applied
          </p>
        </div>
        <TileGrid tiles={today} onSelect={onSelect} />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">{activity}</div>

        <Card title="Match quality" description={`How your ${fmt(scored)} scored jobs rate against your profile.`}>
          <div className="flex flex-col items-center gap-4">
            <Suspense fallback={<Skeleton className="size-[168px] rounded-full" />}>
              <MatchDonut slices={quality} avg={Math.round(stats.avg_match_score ?? 0)} />
            </Suspense>
            <ul className="w-full space-y-1">
              {quality.map((q) => {
                const content = (
                  <>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-2.5 rounded-full',
                          q.key === 'strong' && 'bg-status-ready',
                          q.key === 'good' && 'bg-chart-1',
                          q.key === 'low' && 'bg-muted-foreground/40',
                        )}
                      />
                      {q.label}
                    </span>
                    <span className="flex items-baseline gap-2 tabular-nums">
                      <span className="text-xs text-muted-foreground">{q.ofScored}%</span>
                      <span className="font-semibold">{fmt(q.value)}</span>
                    </span>
                  </>
                );
                return (
                  <li key={q.key}>
                    {q.filters ? (
                      <button
                        type="button"
                        onClick={() => onSelect(q.filters as BoardFilters)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        {content}
                      </button>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      </div>

      <Card
        title="Apply pipeline"
        description={`Where the ${fmt(stats.total_jobs)} jobs in your visible pool stand right now.`}
      >
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          {pipeline.map((s) =>
            s.value > 0 ? (
              <span
                key={s.key}
                className={cn('h-full border-r-2 border-card transition-[width] duration-500 last:border-r-0', STAGE_COLOR[s.key])}
                style={{ width: `${Math.max(s.ofPool, 1)}%` }}
                title={`${s.label}: ${fmt(s.value)}`}
              />
            ) : null,
          )}
        </div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {pipeline.map((s) => {
            const inner = (
              <>
                <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className={cn('size-2.5 rounded-full', STAGE_COLOR[s.key])} />
                  {s.label}
                </span>
                <span className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums">{fmt(s.value)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{s.ofPool}% of pool</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{s.hint}</span>
              </>
            );
            return (
              <li key={s.key}>
                {s.filters ? (
                  <button
                    type="button"
                    onClick={() => onSelect(s.filters as BoardFilters)}
                    className="group relative block w-full rounded-xl border bg-background/50 px-3.5 py-3 text-left transition-all outline-none hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {inner}
                    <ChevronRight className="absolute top-3 right-3 size-4 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-brand" />
                  </button>
                ) : (
                  <div className="rounded-xl border border-dashed bg-background/30 px-3.5 py-3">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <section aria-labelledby="insights-overview" className="space-y-3">
        <h2 id="insights-overview" className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Overview
        </h2>
        <TileGrid tiles={overview} onSelect={onSelect} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Ready vs applied"
          description="Documents finished and applications sent per day, last 7 days."
          actions={<Totals rows={trends} series={READY_SERIES} />}
        >
          <TrendBlock data={trends} series={READY_SERIES} emptyText="Trend data will appear as you use the pipeline." />
        </Card>
        <Card
          title="Remote & strong matches"
          description="Remote jobs added and strong matches found per day, last 7 days."
          actions={<Totals rows={trends} series={REMOTE_SERIES} />}
        >
          <TrendBlock data={trends} series={REMOTE_SERIES} emptyText="Trend data will appear as matches land." />
        </Card>
      </div>

      <Card title="Sources" description="Where the jobs in your pool come from.">
        {sources.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sources appear after jobs sync into your pool.</p>
        ) : (
          <ul className="grid gap-x-8 gap-y-3.5 sm:grid-cols-2">
            {sources.map((src, i) => (
              <li key={src.source} className="min-w-0">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                    <span className="truncate font-medium">{src.label}</span>
                    {src.latest && (
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                        last {relativeTime(src.latest)}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    <span className="text-xs text-muted-foreground">{src.share}%</span>
                    <span className="font-semibold">{fmt(src.count)}</span>
                  </span>
                </div>
                <div className="ml-6 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-brand to-brand-glow transition-[width] duration-500"
                    style={{ width: `${src.width}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ActivityCard({
  days,
  onDays,
  loading,
  failed,
  rows,
  minScore,
}: {
  days: number;
  onDays: (d: (typeof RANGES)[number]) => void;
  loading: boolean;
  failed: boolean;
  rows: ReturnType<typeof buildActivityRows>;
  minScore: number | undefined;
}) {
  const applied = sumBy(rows, 'applied');
  return (
    <Card
      label="Activity"
      title="Activity"
      className="h-full"
      description={
        minScore != null
          ? `New jobs, jobs scoring ${minScore}+ (your minimum) and applications per day.`
          : 'New jobs, jobs above your minimum score and applications per day.'
      }
      actions={
        <div role="tablist" aria-label="Activity range" className="inline-flex rounded-lg bg-muted p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={days === r}
              onClick={() => onDays(r)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition',
                days === r ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r} days
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-3 grid grid-cols-3 gap-2">
        {ACTIVITY_SERIES.map((s) => {
          const total = sumBy(rows, s.key);
          return (
            <div key={s.key} className="min-w-0 rounded-xl border bg-background/50 px-3 py-2">
              <div className="flex items-center gap-1.5 truncate text-[11px] font-medium text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                {s.label}
              </div>
              <div className="mt-0.5 text-lg leading-tight font-semibold tabular-nums">{loading ? '-' : fmt(total)}</div>
            </div>
          );
        })}
      </div>
      {failed ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Activity could not be loaded. Try Refresh.</p>
      ) : loading ? (
        <Skeleton className="h-[260px] w-full rounded-xl" />
      ) : rows.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Activity appears as jobs come in.</p>
      ) : (
        <Suspense fallback={<Skeleton className="h-[260px] w-full rounded-xl" />}>
          <ActivityChart data={rows} series={ACTIVITY_SERIES} />
          <p className="mt-2 text-right text-[11px] text-muted-foreground tabular-nums">
            {(applied / Math.max(rows.length, 1)).toFixed(1)} applications per day on average
          </p>
        </Suspense>
      )}
    </Card>
  );
}

function Totals({ rows, series }: { rows: ReturnType<typeof buildTrendRows>; series: TrendSeries[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: s.color }} />
          {s.label}
          <span className="font-semibold text-foreground tabular-nums">{fmt(sumBy(rows, s.key))}</span>
        </li>
      ))}
    </ul>
  );
}

function TileGrid({ tiles, onSelect }: { tiles: InsightTile[]; onSelect: (f: BoardFilters) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t, i) => {
        const Icon = TILE_ICONS[t.key];
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onSelect(t.filters)}
            style={{ animationDelay: `${60 + i * 40}ms` }}
            className="jobs-summary-card group min-w-0 rounded-2xl border bg-card/85 p-4 text-left shadow-xs backdrop-blur-sm transition-all outline-none hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-medium text-muted-foreground">{t.label}</p>
              <span
                className={cn(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105',
                  TILE_TONE[t.key] ?? NEUTRAL_TONE,
                )}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>
            </div>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{t.display}</p>
            {t.hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.hint}</p> : null}
          </button>
        );
      })}
    </div>
  );
}

function TrendBlock({
  data,
  series,
  emptyText,
}: {
  data: ReturnType<typeof buildTrendRows>;
  series: TrendSeries[];
  emptyText: string;
}) {
  if (data.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <Suspense fallback={<Skeleton className="h-[200px] w-full rounded-xl" />}>
      <TrendChart data={data} series={series} />
    </Suspense>
  );
}

function InsightsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading insights">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-2xl border bg-card/80 p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-14" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border bg-card/80 p-5 lg:col-span-2">
          <Skeleton className="mb-4 h-4 w-32" />
          <Skeleton className="h-[260px] w-full rounded-xl" />
        </div>
        <div className="flex flex-col items-center rounded-2xl border bg-card/80 p-5">
          <Skeleton className="mb-4 h-4 w-28 self-start" />
          <Skeleton className="size-[168px] rounded-full" />
        </div>
      </div>
      <div className="space-y-3 rounded-2xl border bg-card/80 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full rounded-full" />
      </div>
    </div>
  );
}

function InsightsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-5 py-4"
    >
      <div className="flex items-center gap-2 text-sm">
        <AlertCircle className="size-4 text-destructive" aria-hidden />
        Couldn&apos;t load your insights.
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function InsightsEmpty({ onAddJobs, onAsk }: { onAddJobs: () => void; onAsk: () => void }) {
  return (
    <Empty className="rounded-2xl border border-dashed bg-card/60 py-16 backdrop-blur-sm">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BarChart3 />
        </EmptyMedia>
        <EmptyTitle>No insights yet</EmptyTitle>
        <EmptyDescription>Add a few jobs and your pipeline, matches, and trends will show up here.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={onAddJobs}>
          <Plus />
          Add jobs
        </Button>
        <Button variant="outline" onClick={onAsk}>
          <Sparkles />
          Ask the assistant
        </Button>
      </EmptyContent>
    </Empty>
  );
}
