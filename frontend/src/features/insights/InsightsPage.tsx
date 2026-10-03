import { lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  BarChart3,
  CalendarDays,
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
import { PageLayout, SectionCard } from '@/components/app/PageLayout';
import { useJobStats } from '@/features/jobs/queries';
import { useScraperStore } from '@/stores/scraperStore';
import { useShellStore } from '@/stores/shellStore';
import { cn } from '@/lib/utils';
import type { ScraperStats } from '@/types/scraper';
import type { TrendSeries } from './InsightsCharts';
import {
  buildFunnel,
  buildOverviewTiles,
  buildTodayTiles,
  buildTrendRows,
  fmt,
  isEmptyPool,
  topSources,
  type BoardFilters,
  type InsightTile,
  type TileKey,
} from './insightsData';

const TrendChart = lazy(() => import('./InsightsCharts'));

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

const FUNNEL_COLORS = ['bg-chart-4', 'bg-chart-3', 'bg-chart-2', 'bg-chart-1'];

const READY_SERIES: TrendSeries[] = [
  { key: 'ready', label: 'Ready', color: 'var(--chart-2)' },
  { key: 'available', label: 'In progress', color: 'var(--chart-3)' },
];
const REMOTE_SERIES: TrendSeries[] = [
  { key: 'remote', label: 'Remote', color: 'var(--chart-4)' },
  { key: 'best', label: 'Strong matches', color: 'var(--chart-1)' },
];

const CHART_HEIGHT = 220;

export function InsightsPage() {
  const navigate = useNavigate();
  const stats = useJobStats();

  const goJobs = (filters: BoardFilters) => {
    useScraperStore.getState().applyAgentDashboard({ reset: true, ...filters });
    navigate('/app/jobs');
  };

  const updatedAt = stats.dataUpdatedAt
    ? new Date(stats.dataUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  const actions = (
    <>
      {updatedAt ? <span className="hidden text-xs text-muted-foreground sm:inline">Updated {updatedAt}</span> : null}
      <Button variant="outline" size="sm" onClick={() => void stats.refetch()} disabled={stats.isFetching}>
        <RefreshCw className={cn(stats.isFetching && 'animate-spin')} />
        Refresh
      </Button>
    </>
  );

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
  else if (stats.data) body = <InsightsBody stats={stats.data} onSelect={goJobs} />;

  return (
    <PageLayout
      title="Insights"
      description="Your pipeline, match quality, and seven-day momentum. Select any number to open those jobs."
      actions={actions}
      width="wide"
    >
      {body}
    </PageLayout>
  );
}

function InsightsBody({ stats, onSelect }: { stats: ScraperStats; onSelect: (f: BoardFilters) => void }) {
  const today = buildTodayTiles(stats);
  const overview = buildOverviewTiles(stats);
  const funnel = buildFunnel(stats);
  const trends = buildTrendRows(stats);
  const sources = topSources(stats);

  return (
    <div className="space-y-8">
      <section aria-labelledby="insights-today">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="insights-today" className="text-sm font-semibold">
            Today
          </h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {fmt(stats.today_scraped)} new · {fmt(stats.today_remote)} remote · {fmt(stats.applied_today)} applied
          </p>
        </div>
        <TileGrid tiles={today} onSelect={onSelect} />
      </section>

      <section aria-labelledby="insights-overview">
        <h2 id="insights-overview" className="mb-3 text-sm font-semibold">
          Overview
        </h2>
        <TileGrid tiles={overview} onSelect={onSelect} />
      </section>

      <SectionCard title="Apply pipeline" description="From your visible pool to applications sent.">
        <ul className="space-y-4">
          {funnel.map((step, i) => (
            <li key={step.key}>
              <button
                type="button"
                onClick={() => onSelect(step.filters)}
                className="group -mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{step.label}</span>
                  <span className="flex items-baseline gap-2 tabular-nums">
                    {i > 0 ? <span className="text-xs text-muted-foreground">{step.ofPool}% of pool</span> : null}
                    <span className="font-semibold">{fmt(step.value)}</span>
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full transition-[width] duration-500', FUNNEL_COLORS[i])}
                    style={{ width: `${step.width}%` }}
                  />
                </div>
              </button>
            </li>
          ))}
        </ul>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Ready vs in progress" description="Daily counts, last 7 days.">
          <TrendBlock data={trends} series={READY_SERIES} emptyText="Trend data will appear as you use the pipeline." />
        </SectionCard>
        <SectionCard title="Remote & strong matches" description="Daily counts, last 7 days.">
          <TrendBlock data={trends} series={REMOTE_SERIES} emptyText="Trend data will appear as matches land." />
        </SectionCard>
      </div>

      <SectionCard title="Sources" description="Where the jobs in your pool come from.">
        {sources.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sources appear after jobs sync into your pool.</p>
        ) : (
          <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {sources.map((src) => (
              <li key={src.source}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate capitalize">{src.label}</span>
                  <span className="font-medium tabular-nums">{fmt(src.count)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${src.width}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function TileGrid({ tiles, onSelect }: { tiles: InsightTile[]; onSelect: (f: BoardFilters) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t) => {
        const Icon = TILE_ICONS[t.key];
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onSelect(t.filters)}
            className="group min-w-0 rounded-xl border bg-card p-3.5 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs text-muted-foreground">{t.label}</p>
              <Icon className="size-4 shrink-0 text-muted-foreground group-hover:text-brand" aria-hidden />
            </div>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums">{t.display}</p>
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
    <Suspense fallback={<Skeleton className="w-full rounded-lg" style={{ height: CHART_HEIGHT + 28 }} />}>
      <TrendChart data={data} series={series} height={CHART_HEIGHT} />
    </Suspense>
  );
}

function InsightsSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading insights">
      {[4, 8].map((n, s) => (
        <div key={s}>
          <Skeleton className="mb-3 h-4 w-24" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: n }).map((_, i) => (
              <div key={i} className="rounded-xl border bg-card p-3.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-7 w-14" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="space-y-4 rounded-xl border bg-card p-5">
        <Skeleton className="h-4 w-32" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border bg-card p-5">
            <Skeleton className="mb-4 h-4 w-40" />
            <Skeleton className="h-[220px] w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

function InsightsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4">
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
    <Empty className="border py-16">
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
