import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  ClipboardCheck,
  type LucideIcon,
  MailPlus,
  MessagesSquare,
  UsersRound,
} from 'lucide-react';
import { fetchTeamInsights } from '@/api/teamApi';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { TeamInsights, TeamInsightsMember } from '@/types/team';
import { relativeAgo } from '@/features/interviews/interviewsModel';
import { TeamActivityCard } from '@/features/team/LeadSpacePanel';
import { TEAM_KEY } from '@/features/team/teamModel';
import type { ChartSeries, TeamChartRow } from './InsightsCharts';
import { MemberAvatar } from './SubjectPicker';

const TeamChart = lazy(() => import('./InsightsCharts').then((m) => ({ default: m.TeamChart })));

const RANGES = [7, 14, 30, 90] as const;
type Range = (typeof RANGES)[number];

const METRICS = [
  { key: 'applied', label: 'Applications', icon: ClipboardCheck },
  { key: 'added', label: 'Jobs added', icon: BriefcaseBusiness },
  { key: 'interviews', label: 'Interview updates', icon: MessagesSquare },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

const MEMBER_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-4)',
  'var(--status-ready)',
  'var(--chart-3)',
  'var(--chart-5)',
  'var(--status-applied)',
  'var(--status-preparing)',
];

type SortKey = 'name' | 'applied' | 'jobs_added' | 'interview_updates' | 'active_interviews' | 'last_active_at';

export const teamInsightsKey = (spaceId: string, days: number) => [...TEAM_KEY, 'insights', spaceId, days] as const;

const fmt = new Intl.NumberFormat('en-US');
const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (iso: string) => dayFormat.format(new Date(`${iso}T00:00:00Z`));

const metricOf = (m: TeamInsightsMember, key: MetricKey) =>
  key === 'applied' ? m.stats.applied : key === 'added' ? m.stats.jobs_added : m.stats.interview_updates;

export function buildTeamRows(data: TeamInsights, metric: MetricKey): TeamChartRow[] {
  return data.dates.map((date, i) => {
    const row: TeamChartRow = { day: dayLabel(date), date };
    for (const m of data.members) row[m.id] = m.series[metric][i] ?? 0;
    return row;
  });
}

function sortMembers(members: TeamInsightsMember[], key: SortKey, desc: boolean): TeamInsightsMember[] {
  const value = (m: TeamInsightsMember): string | number =>
    key === 'name' ? m.name.toLowerCase() : key === 'last_active_at' ? (m.stats.last_active_at ?? '') : m.stats[key];
  return [...members].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    const order = av < bv ? -1 : av > bv ? 1 : 0;
    return desc ? -order : order;
  });
}

/** A lead's side-by-side view of every member in one team space. */
export function TeamInsightsView({ spaceId, onOpenMember }: { spaceId: string; onOpenMember: (id: string) => void }) {
  const [days, setDays] = useState<Range>(30);
  const query = useQuery({
    queryKey: teamInsightsKey(spaceId, days),
    queryFn: () => fetchTeamInsights(spaceId, days),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <TeamSkeleton />;
  if (query.isError || !query.data) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-5 py-4"
      >
        <span className="flex items-center gap-2 text-sm">
          <AlertCircle className="size-4 text-destructive" aria-hidden />
          Couldn&apos;t load team insights.
        </span>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const data = query.data;
  if (data.members.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-16 text-center backdrop-blur-sm">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
          <UsersRound className="size-5" aria-hidden />
        </span>
        <p className="mt-3 font-medium">No one has joined {data.space.name} yet</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Invite people from the Team page. Their jobs, applications and interviews show up here once they accept.
        </p>
        <Link to="/app/team" className={cn(buttonVariants({ size: 'sm' }), 'mt-4')}>
          <MailPlus /> Invite members
        </Link>
      </div>
    );
  }

  const t = data.totals;
  return (
    <div className={cn('space-y-6 transition-opacity', query.isPlaceholderData && 'opacity-60')}>
      <section aria-label="Team totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi icon={UsersRound} label="Active members" value={`${t.active_members} of ${t.members}`} hint={`Active in the last ${data.days} days`} />
        <Kpi
          icon={ClipboardCheck}
          tone="bg-status-ready/15 text-status-ready"
          label="Applications"
          value={fmt.format(t.applied)}
          hint={`${(t.applied / Math.max(data.days, 1)).toFixed(1)} per day`}
        />
        <Kpi
          icon={BriefcaseBusiness}
          tone="bg-chart-4/12 text-chart-4"
          label="Jobs added"
          value={fmt.format(t.jobs_added)}
          hint={`${(t.jobs_added / Math.max(t.members, 1)).toFixed(1)} per member`}
        />
        <Kpi
          icon={MessagesSquare}
          tone="bg-chart-2/12 text-chart-2"
          label="Interview updates"
          value={fmt.format(t.interview_updates)}
          hint="Invites, schedules and replies"
        />
        <Kpi
          icon={CalendarClock}
          tone="bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
          label="Active interviews"
          value={fmt.format(t.active_interviews)}
          hint={t.upcoming_interviews ? `${t.upcoming_interviews} scheduled ahead` : 'None scheduled ahead'}
        />
      </section>

      <ProgressCard data={data} days={days} onDays={setDays} />
      <ComparisonCard data={data} onOpenMember={onOpenMember} />
      <TeamActivityCard spaceId={spaceId} hasMembers />
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'bg-brand/12 text-brand',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="jobs-summary-card min-w-0 rounded-2xl border bg-card/85 p-4 shadow-xs backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <span className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg', tone)} aria-hidden>
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Tabs<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition',
            value === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ProgressCard({ data, days, onDays }: { data: TeamInsights; days: Range; onDays: (d: Range) => void }) {
  const [metric, setMetric] = useState<MetricKey>('applied');
  const rows = useMemo(() => buildTeamRows(data, metric), [data, metric]);
  const series: ChartSeries<string>[] = data.members.map((m, i) => ({
    key: m.id,
    label: m.name,
    color: MEMBER_COLORS[i % MEMBER_COLORS.length],
    kind: 'bar',
    stack: 'team',
  }));
  const total = data.members.reduce((s, m) => s + metricOf(m, metric), 0);
  const metricLabel = METRICS.find((x) => x.key === metric)?.label ?? '';

  return (
    <section
      aria-label="Team progress"
      className="jobs-summary-card min-w-0 rounded-2xl border bg-card/85 shadow-xs backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <BarChart3 className="size-4 text-brand" aria-hidden />
            Team progress
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {metricLabel} per day, stacked by member. {fmt.format(total)} in the last {data.days} days.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            label="Metric"
            value={metric}
            onChange={setMetric}
            options={METRICS.map((m) => ({
              value: m.key,
              label: (
                <>
                  <m.icon className="size-3.5" aria-hidden />
                  {m.label}
                </>
              ),
            }))}
          />
          <Tabs label="Team range" value={days} onChange={onDays} options={RANGES.map((r) => ({ value: r, label: `${r} days` }))} />
        </div>
      </div>
      <div className="px-5 pt-3 pb-5">
        {total === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No {metricLabel.toLowerCase()} in the last {data.days} days.
          </p>
        ) : (
          <Suspense fallback={<Skeleton className="h-[280px] w-full rounded-xl" />}>
            <TeamChart data={rows} series={series} />
          </Suspense>
        )}
        <ul aria-label="Members in the chart" className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
          {data.members.map((m, i) => (
            <li key={m.id} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2.5 rounded-full" style={{ background: MEMBER_COLORS[i % MEMBER_COLORS.length] }} />
              {m.name}
              <span className="font-semibold text-foreground tabular-nums">{fmt.format(metricOf(m, metric))}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Member' },
  { key: 'applied', label: 'Applied', numeric: true },
  { key: 'jobs_added', label: 'Jobs added', numeric: true },
  { key: 'interview_updates', label: 'Interview updates', numeric: true },
  { key: 'active_interviews', label: 'Active interviews', numeric: true },
  { key: 'last_active_at', label: 'Last active' },
];

function ComparisonCard({ data, onOpenMember }: { data: TeamInsights; onOpenMember: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'applied', desc: true });
  const members = sortMembers(data.members, sort.key, sort.desc);
  const topApplied = Math.max(1, ...data.members.map((m) => m.stats.applied));
  const grid =
    'lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_repeat(3,minmax(0,0.9fr))_minmax(0,1fr)_minmax(0,1.1fr)_auto]';

  return (
    <section
      aria-label="Member comparison"
      className="jobs-summary-card min-w-0 rounded-2xl border bg-card/85 shadow-xs backdrop-blur-sm"
    >
      <div className="px-5 pt-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <UsersRound className="size-4 text-brand" aria-hidden />
          Member comparison
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Last {data.days} days. Open a member for their full pipeline, match quality and inbox applications.
        </p>
      </div>
      <div className="px-3 pt-3 pb-3 sm:px-5">
        <div
          className={cn(
            'hidden gap-3 border-b px-2 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase lg:grid',
            grid,
          )}
        >
          {COLUMNS.map((c) => {
            const active = sort.key === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-label={`Sort by ${c.label.toLowerCase()}${active ? (sort.desc ? ', highest first' : ', lowest first') : ''}`}
                onClick={() => setSort({ key: c.key, desc: active ? !sort.desc : c.key !== 'name' })}
                className={cn(
                  'flex items-center gap-1 uppercase transition-colors hover:text-foreground',
                  c.numeric && 'justify-end',
                  active && 'text-foreground',
                )}
              >
                {c.label}
                {active ? sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : null}
              </button>
            );
          })}
          <span>Trend</span>
          <span className="sr-only">Actions</span>
        </div>
        <ul aria-label="Team members" className="divide-y">
          {members.map((m) => (
            <li
              key={m.id}
              className={cn('grid grid-cols-2 items-center gap-x-3 gap-y-2 rounded-lg px-2 py-3 hover:bg-muted/30', grid)}
            >
              <div className="col-span-2 flex min-w-0 items-center gap-2.5 lg:col-span-1">
                <MemberAvatar id={m.id} name={m.name} className="size-8 text-xs" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{m.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{m.headline || m.email}</span>
                </span>
              </div>
              <div className="min-w-0 text-left lg:text-right">
                <span className="text-xs text-muted-foreground lg:hidden">Applied: </span>
                <span className="text-sm font-semibold tabular-nums">{fmt.format(m.stats.applied)}</span>
                <div className="mt-1 hidden h-1.5 overflow-hidden rounded-full bg-muted lg:block" aria-hidden>
                  <div
                    className="ml-auto h-full rounded-full bg-status-ready transition-[width] duration-500"
                    style={{ width: `${(m.stats.applied / topApplied) * 100}%` }}
                  />
                </div>
              </div>
              <Num label="Jobs added" value={m.stats.jobs_added} />
              <Num label="Interview updates" value={m.stats.interview_updates} />
              <Num
                label="Active interviews"
                value={m.stats.active_interviews}
                hint={m.stats.upcoming_interviews ? `${m.stats.upcoming_interviews} upcoming` : undefined}
              />
              <span className="text-xs text-muted-foreground">
                <span className="lg:hidden">Last active: </span>
                {relativeAgo(m.stats.last_active_at) ?? 'No activity yet'}
              </span>
              <Sparkline values={m.series.applied} label={`${m.name}'s applications per day`} />
              <div className="col-span-2 flex justify-end gap-1 lg:col-span-1">
                <Button variant="outline" size="xs" onClick={() => onOpenMember(m.id)} aria-label={`View ${m.name}'s insights`}>
                  <BarChart3 /> Insights
                </Button>
                <Link
                  to={`/app/team/${encodeURIComponent(data.space.id)}/members/${encodeURIComponent(m.id)}`}
                  className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                  aria-label={`Open ${m.name}'s report`}
                >
                  Report
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Num({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <span className="text-left lg:text-right">
      <span className="text-xs text-muted-foreground lg:hidden">{label}: </span>
      <span className="text-sm font-semibold tabular-nums">{fmt.format(value)}</span>
      {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
    </span>
  );
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(0, ...values);
  return (
    <span role="img" aria-label={label} className="flex h-7 w-full max-w-36 items-end gap-px">
      {values.map((v, i) => (
        <span
          key={i}
          className={cn('min-w-px flex-1 rounded-t-[2px]', v > 0 ? 'bg-status-ready/80' : 'bg-muted')}
          style={{ height: max > 0 && v > 0 ? `${Math.max(12, (v / max) * 100)}%` : '8%' }}
        />
      ))}
    </span>
  );
}

function TeamSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading team insights">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-2xl border bg-card/80 p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-14" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border bg-card/80 p-5">
        <Skeleton className="mb-4 h-4 w-32" />
        <Skeleton className="h-[280px] w-full rounded-xl" />
      </div>
      <div className="space-y-2 rounded-2xl border bg-card/80 p-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
