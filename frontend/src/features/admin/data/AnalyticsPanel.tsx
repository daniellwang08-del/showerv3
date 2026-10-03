import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CalendarRange, RefreshCw } from 'lucide-react';
import { getClientTimezone } from '@/api/dataManagementApi';
import { SectionCard } from '@/components/app/PageLayout';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { UserActivityMetric } from '@/types/dataManagement';
import {
  chartColor,
  cycleSeries,
  DEFAULT_ACTIVITY_USERS,
  extractErrorMessage,
  fmt,
  MAX_ACTIVITY_USERS,
  monthKey,
  parseMonthKey,
  toChartSeries,
  type ChartRow,
  type ChartSeries,
} from './dataUtils';
import { MultiSelectPopover } from './MultiSelectPopover';
import {
  adminDataKeys,
  useAnalysisPlatforms,
  useAnalysisUsers,
  useMonths,
  useMonthlySeries,
  usePlatformSeries,
  useUserActivitySeries,
} from './queries';

const LineSeriesChart = lazy(() => import('./DataCharts'));

const ACTIVITY_METRICS: Array<{ id: UserActivityMetric; label: string }> = [
  { id: 'board_added', label: 'Board added' },
  { id: 'applied', label: 'Applied' },
];

const FETCHED = chartColor(4);
const APPLIED = chartColor(1);

const APPLIED_SERIES: ChartSeries[] = [
  { key: 'applied_count', label: 'Team applied', color: APPLIED },
  { key: 'fetched_count', label: 'Fetched', color: FETCHED },
];
const REMOTE_SERIES: ChartSeries[] = [
  { key: 'remote_count', label: 'Remote', color: chartColor(3) },
  { key: 'fetched_count', label: 'Fetched', color: FETCHED },
];
const PIPELINE_COLORS = { fetched_count: FETCHED, jd_ready_count: chartColor(2), extraction_failed_count: chartColor(5) };
const DISTRIBUTION_COLORS = { sheet_posted_count: chartColor(2), pumble_posted_count: chartColor(1) };
const GROWTH_COLORS = { new_users_count: chartColor(3), team_applied_count: APPLIED };
const SCRAPE_COLORS = { items_new: chartColor(2), errors: chartColor(5) };
/** chart-1 is reserved for the applied line. */
const PLATFORM_PALETTE = [4, 2, 3, 5];

const CHART_HEIGHT = 260;
const WIDE_CHART_HEIGHT = 320;

type QueryState = { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; isFetching?: boolean };

export function AnalyticsPanel() {
  const timezone = getClientTimezone();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const months = useMonths(timezone);
  const fetching = useIsFetching({ queryKey: adminDataKeys.all }) > 0;

  const monthList = months.data?.months ?? [];
  const requested = searchParams.get('month');
  const selected = monthList.find((m) => monthKey(m) === requested) ?? monthList[0];
  const ym = selected ? parseMonthKey(monthKey(selected)) : null;
  const period = ym ? { ...ym, timezone } : null;

  const setMonth = (key: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('month', key);
        return next;
      },
      { replace: true },
    );

  const monthItems = monthList.map((m) => ({ value: monthKey(m), label: m.label }));

  const toolbar = (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-xl text-sm text-muted-foreground">
        Platform-wide metrics for <span className="font-medium text-foreground">{timezone}</span>. Fetched means jobs
        created on NAO, not the employer post date.
      </p>
      <div className="flex w-full items-end gap-2 sm:w-auto">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:w-56 sm:flex-none">
          <FieldLabel htmlFor="admin-data-month">Month period</FieldLabel>
          <Select
            items={monthItems}
            value={selected ? monthKey(selected) : null}
            onValueChange={(v) => {
              if (v) setMonth(String(v));
            }}
            disabled={months.isPending || monthList.length === 0}
          >
            <SelectTrigger id="admin-data-month" className="w-full">
              <SelectValue placeholder={months.isPending ? 'Loading…' : 'No months'} />
            </SelectTrigger>
            <SelectContent>
              {monthItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh analytics"
          disabled={fetching}
          onClick={() => void qc.invalidateQueries({ queryKey: adminDataKeys.all })}
        >
          <RefreshCw className={cn(fetching && 'animate-spin')} />
        </Button>
      </div>
    </div>
  );

  let body: ReactNode;
  if (months.isPending) body = <AnalyticsSkeleton />;
  else if (months.isError)
    body = (
      <InlineError
        message={extractErrorMessage(months.error, 'Failed to load analysis controls.')}
        onRetry={() => void months.refetch()}
      />
    );
  else if (!period)
    body = (
      <Empty className="border py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarRange />
          </EmptyMedia>
          <EmptyTitle>No months to analyze yet</EmptyTitle>
          <EmptyDescription>Analytics appear once jobs start flowing into NAO.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  else body = <AnalyticsBody period={period} monthLabel={selected?.label ?? ''} />;

  return (
    <div>
      {toolbar}
      {body}
    </div>
  );
}

function AnalyticsBody({
  period,
  monthLabel,
}: {
  period: { year: number; month: number; timezone: string };
  monthLabel: string;
}) {
  const applied = useMonthlySeries('applied-vs-fetched', period);
  const remote = useMonthlySeries('remote-vs-fetched', period);
  const pipeline = useMonthlySeries('pipeline', period);
  const distribution = useMonthlySeries('distribution', period);
  const growth = useMonthlySeries('growth', period);
  const scrape = useMonthlySeries('scrape-health', period);

  const p = pipeline.data?.totals;
  const d = distribution.data?.totals;
  const g = growth.data?.totals;
  const s = scrape.data?.totals;
  const kpis = [
    { label: 'Fetched', value: p?.fetched_count, hint: 'Jobs created on the platform this month' },
    { label: 'JD ready', value: p?.jd_ready_count, hint: 'Extractions that reached completed this month' },
    { label: 'Ext. failed', value: p?.extraction_failed_count, hint: 'Extractions marked failed this month' },
    { label: 'Backlog now', value: p?.backlog_now, hint: 'Live unfinished JD pool (point-in-time)' },
    {
      label: 'Team applied',
      value: g?.team_applied_count ?? applied.data?.totals.applied_count,
      hint: 'Applications marked by all users this month',
    },
    {
      label: 'Scrape new',
      value: s?.items_new,
      hint: `Sheet ${fmt(d?.sheet_posted_count)} · Pumble ${fmt(d?.pumble_posted_count)} · Runs ${fmt(s?.runs)}`,
    },
  ];
  const kpiLoading = pipeline.isPending && growth.isPending;

  const pipelineSeries = toChartSeries(pipeline.data?.series, PIPELINE_COLORS);
  const scrapeSeries = toChartSeries(scrape.data?.series, SCRAPE_COLORS, 2);
  const distributionSeries = toChartSeries(distribution.data?.series, DISTRIBUTION_COLORS);
  const growthSeries = toChartSeries(growth.data?.series, GROWTH_COLORS);

  const monthBadge = monthLabel ? <span className="text-xs text-muted-foreground">{monthLabel}</span> : null;

  return (
    <div className="space-y-6">
      <section aria-label="Key metrics" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="min-w-0 rounded-xl border bg-card p-3.5" title={k.hint}>
            <p className="truncate text-xs text-muted-foreground">{k.label}</p>
            {kpiLoading ? (
              <Skeleton className="mt-2 h-7 w-14" />
            ) : (
              <p className="mt-1 text-2xl font-semibold tabular-nums">{fmt(k.value)}</p>
            )}
          </div>
        ))}
      </section>

      <SectionCard
        title="Platform overview"
        description="Team applications and remote share against platform-wide fetches for the selected month."
        actions={monthBadge}
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <ChartBlock
            title="Team applied vs fetched"
            query={applied}
            summary={
              applied.data
                ? `${fmt(applied.data.totals.applied_count)} applied · ${fmt(applied.data.totals.fetched_count)} fetched`
                : undefined
            }
            data={applied.data?.days as unknown as ChartRow[] | undefined}
            series={APPLIED_SERIES}
            emptyText="No data"
          />
          <ChartBlock
            title="Remote vs fetched"
            query={remote}
            summary={
              remote.data
                ? `${fmt(remote.data.totals.remote_count)} remote · ${fmt(remote.data.totals.fetched_count)} fetched`
                : undefined
            }
            data={remote.data?.days as unknown as ChartRow[] | undefined}
            series={REMOTE_SERIES}
            emptyText="No data"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Pipeline & scrape health"
        description="Daily extraction outcomes and scrape run items/errors. Backlog is live, not historical."
        actions={monthBadge}
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <ChartBlock
            title="Extraction pipeline"
            query={pipeline}
            summary={
              p
                ? `${fmt(p.jd_ready_count)} ready · ${fmt(p.extraction_failed_count)} failed · backlog ${fmt(p.backlog_now)}`
                : undefined
            }
            data={pipeline.data?.days}
            series={pipelineSeries}
            emptyText="No extraction events this month"
          />
          <ChartBlock
            title="Scrape health"
            query={scrape}
            summary={s ? `${fmt(s.items_new)} new · ${fmt(s.errors)} errors · ${fmt(s.runs)} runs` : undefined}
            data={scrape.data?.days}
            series={scrapeSeries}
            emptyText="No scrape runs this month"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Distribution & growth"
        description="System-wide Sheet/Pumble posts, new user signups, and team applications."
        actions={monthBadge}
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <ChartBlock
            title="Sheet & Pumble"
            query={distribution}
            summary={d ? `${fmt(d.sheet_posted_count)} sheet · ${fmt(d.pumble_posted_count)} pumble` : undefined}
            data={distribution.data?.days}
            series={distributionSeries}
            emptyText="No distribution events this month"
          />
          <ChartBlock
            title="Users & applications"
            query={growth}
            summary={g ? `${fmt(g.new_users_count)} new users · ${fmt(g.team_applied_count)} applied` : undefined}
            data={growth.data?.days}
            series={growthSeries}
            emptyText="No growth events this month"
          />
        </div>
      </SectionCard>

      <PlatformSection period={period} monthBadge={monthBadge} monthLabel={monthLabel} />
      <UserActivitySection period={period} monthBadge={monthBadge} monthLabel={monthLabel} />
    </div>
  );
}

type Period = { year: number; month: number; timezone: string };

function PlatformSection({ period, monthBadge, monthLabel }: { period: Period; monthBadge: ReactNode; monthLabel: string }) {
  const platforms = useAnalysisPlatforms();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const all = platforms.data ?? [];
  const selected = picked ?? new Set(all);
  const settled = !platforms.isPending;
  const series = usePlatformSeries(settled ? period : null, selected.size > 0 ? [...selected] : null);

  const chartSeries: ChartSeries[] = [];
  let free = 0;
  for (const s of series.data?.series ?? []) {
    if (s.kind === 'applied') chartSeries.push({ key: s.key, label: s.label, color: APPLIED });
    else chartSeries.push({ key: s.key, label: s.label, ...cycleSeries(free++, PLATFORM_PALETTE) });
  }

  return (
    <SectionCard
      title="Platform fetch vs applied"
      description="Jobs fetched per scrape source versus applications across all users (same platform-wide scope on both axes)."
      actions={monthBadge}
    >
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <MultiSelectPopover
          label="Platforms"
          options={all.map((x) => ({ id: x, label: x }))}
          selected={selected}
          onChange={setPicked}
          emptyLabel="No platforms found"
          disabled={platforms.isPending}
        />
        {platforms.isError ? (
          <InlineError compact message="Couldn't load platforms." onRetry={() => void platforms.refetch()} />
        ) : null}
      </div>
      <ChartBlock
        title={`${monthLabel || 'Month'} platform series`}
        hideTitle
        query={{ ...series, isPending: !settled || series.isPending }}
        data={series.data?.days}
        series={chartSeries}
        height={WIDE_CHART_HEIGHT}
        emptyText="Select at least one platform for this month."
        errorFallback="Failed to load platform series for this month."
      />
    </SectionCard>
  );
}

function UserActivitySection({
  period,
  monthBadge,
  monthLabel,
}: {
  period: Period;
  monthBadge: ReactNode;
  monthLabel: string;
}) {
  const users = useAnalysisUsers();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [metrics, setMetrics] = useState<Set<UserActivityMetric>>(() => new Set(['board_added', 'applied']));
  const all = users.data ?? [];
  const selected = picked ?? new Set(all.slice(0, Math.min(DEFAULT_ACTIVITY_USERS, MAX_ACTIVITY_USERS)).map((u) => u.id));
  const ids = [...selected].slice(0, MAX_ACTIVITY_USERS);
  const metricList = ACTIVITY_METRICS.map((m) => m.id).filter((id) => metrics.has(id));
  const activity = useUserActivitySeries(period, ids, metricList);

  const toggleMetric = (id: UserActivityMetric) =>
    setMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const blocked = users.isPending
    ? null
    : ids.length === 0
      ? 'Select at least one user for this month.'
      : metricList.length === 0
        ? 'Select at least one metric for this month.'
        : null;

  return (
    <SectionCard
      title="User activity"
      description="Per-user board adds (jobs that appeared on that user's board) and applications. Sheet/Pumble posts are system-wide, see Distribution above."
      actions={monthBadge}
    >
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start">
        <MultiSelectPopover
          label="Users"
          options={all.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` }))}
          selected={selected}
          onChange={setPicked}
          emptyLabel="No users found"
          maxSelect={MAX_ACTIVITY_USERS}
          helperText={`Up to ${MAX_ACTIVITY_USERS} users per month chart`}
          disabled={users.isPending}
        />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Metrics</legend>
          <div className="flex flex-wrap gap-2">
            {ACTIVITY_METRICS.map((m) => {
              const on = metrics.has(m.id);
              return (
                <label
                  key={m.id}
                  className={cn(
                    'inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors hover:bg-muted',
                    on && 'border-brand/40 bg-brand-soft',
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={() => toggleMetric(m.id)} />
                  {m.label}
                </label>
              );
            })}
          </div>
        </fieldset>
        {users.isError ? (
          <InlineError compact message="Couldn't load users." onRetry={() => void users.refetch()} />
        ) : null}
      </div>
      {blocked ? (
        <p className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          {blocked}
        </p>
      ) : (
        <ChartBlock
          title={`${monthLabel || 'Month'} user activity`}
          hideTitle
          query={{ ...activity, isPending: users.isPending || activity.isPending }}
          data={activity.data?.days}
          series={toChartSeries(activity.data?.series)}
          height={WIDE_CHART_HEIGHT}
          emptyText="Select users and metrics to display this month."
          errorFallback="Failed to load user activity for this month."
        />
      )}
    </SectionCard>
  );
}

function ChartBlock({
  title,
  hideTitle,
  summary,
  query,
  data,
  series,
  emptyText,
  errorFallback = 'Failed to load this chart.',
  height = CHART_HEIGHT,
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
        <LineSeriesChart data={data} series={series} height={height} />
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

function InlineError({ message, onRetry, compact }: { message: string; onRetry: () => void; compact?: boolean }) {
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

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-3.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-7 w-12" />
          </div>
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="rounded-xl border bg-card p-5">
          <Skeleton className="mb-4 h-4 w-40" />
          <div className="grid gap-8 lg:grid-cols-2">
            <Skeleton className="h-[260px] w-full rounded-lg" />
            <Skeleton className="h-[260px] w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}
