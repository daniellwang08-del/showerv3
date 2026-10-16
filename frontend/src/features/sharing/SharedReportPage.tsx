import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { isAxiosError } from 'axios';
import {
  AlertTriangle,
  ArrowLeft,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarClock,
  ClipboardCheck,
  ExternalLink,
  Eye,
  Inbox,
  Link2Off,
  Lock,
  Mail,
  MessageSquareQuote,
  Search,
  Timer,
  Trophy,
} from 'lucide-react';
import { fetchReportPreview, fetchSharedReport } from '@/api/reportShareApi';
import { HeroStat, PageLayout, SectionCard } from '@/components/app/PageLayout';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ReportApplication, ReportPool, SharedReportResponse } from '@/types/reportShare';
import type { ActivitySeries } from '../insights/InsightsCharts';
import { buildActivityRows, fmt } from '../insights/insightsData';
import { CompanyAvatar, InterviewBoard, StageChip } from '../interviews/InterviewBoard';
import { InterviewDetailSheet } from '../interviews/InterviewDetailSheet';
import { ActionRow, UpcomingRow } from '../interviews/InterviewRows';
import { actionItems, awaitingOutcome, relativeAgo, upcomingInterviews } from '../interviews/interviewsModel';
import {
  activityWindow,
  APPLICATION_FILTERS,
  applicationCounts,
  filterApplications,
  INCOMING_SHARES_KEY,
  sharedBase,
  shortDate,
  type ApplicationFilter,
} from './shareModel';

const ActivityChart = lazy(() => import('../insights/InsightsCharts').then((m) => ({ default: m.ActivityChart })));

const ACTIVITY_SERIES: ActivitySeries[] = [
  { key: 'posted', label: 'New jobs', color: 'var(--chart-4)', kind: 'area' },
  { key: 'recommended', label: 'Strong enough to apply', color: 'var(--chart-1)', kind: 'line' },
  { key: 'applied', label: 'Applied', color: 'var(--status-ready)', kind: 'bar' },
];
const RANGES = [7, 30] as const;
const PAGE = 40;

/** A report another NAO user shared with the signed-in account. */
export function SharedReportPage() {
  const { shareId = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['shared-report', shareId],
    queryFn: () => fetchSharedReport(shareId),
    retry: false,
    staleTime: 60_000,
  });
  const status = isAxiosError(query.error) ? query.error.response?.status : undefined;
  const settled = query.isSuccess || status === 404;
  useEffect(() => {
    if (settled) void queryClient.invalidateQueries({ queryKey: INCOMING_SHARES_KEY });
  }, [settled, queryClient]);
  if (query.isPending) return <ReportLoading />;
  if (query.isError) return <ReportUnavailable status={status} onRetry={() => void query.refetch()} />;
  return <SharedReportView data={query.data} />;
}

/** The owner's own report, exactly as the people they share with see it. */
export function ReportPreviewPage() {
  const [params] = useSearchParams();
  const includeNotes = params.get('notes') === '1';
  const query = useQuery({
    queryKey: ['report-preview', includeNotes],
    queryFn: () => fetchReportPreview(includeNotes),
    retry: false,
  });
  if (query.isPending) return <ReportLoading />;
  if (query.isError) return <ReportUnavailable onRetry={() => void query.refetch()} />;
  return <SharedReportView data={query.data} preview />;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const PILL = 'inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2.5 py-1 backdrop-blur';

function BackLink({ preview }: { preview?: boolean }) {
  const base = sharedBase(useLocation().pathname);
  return (
    <Link
      to={preview ? '/app/interviews' : base}
      className={cn(PILL, 'font-medium text-foreground transition-colors hover:bg-muted')}
    >
      <ArrowLeft className="size-3" aria-hidden />
      {preview ? 'Interviews' : 'Shared with me'}
    </Link>
  );
}

export function SharedReportView({ data, preview = false }: { data: SharedReportResponse; preview?: boolean }) {
  const { report, share } = data;
  const now = useNow(60_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const processes = report.interviews.processes;
  const summary = report.interviews.summary;
  const upcoming = upcomingInterviews(processes);
  const actions = actionItems(processes);
  const outcome = awaitingOutcome(processes);
  const appliedWeek = activityWindow(report.activity, 7).totals.applied;
  const selected = processes.find((p) => p.id === selectedId) ?? null;
  const name = report.owner.name;

  const meta = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      <HeroStat icon={CalendarClock} label="Active processes" value={summary.active} />
      <HeroStat icon={CalendarCheck} label="Interviews this week" value={summary.upcoming_week} tone="bg-chart-2/10 text-chart-2" />
      <HeroStat
        icon={AlertTriangle}
        label="Needs action"
        value={summary.needs_action}
        tone={summary.needs_action ? 'bg-status-preparing/15 text-status-preparing' : 'bg-muted text-muted-foreground'}
      />
      <HeroStat icon={Trophy} label="Offers" value={summary.offers} tone="bg-status-ready/15 text-status-ready" />
      <HeroStat icon={ClipboardCheck} label="Applied this week" value={appliedWeek} tone="bg-indigo-500/12 text-indigo-700 dark:text-indigo-300" />
    </div>
  );

  const actionsBar = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <BackLink preview={preview} />
      {preview ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2.5 py-1 font-medium text-brand">
          <Eye className="size-3.5" aria-hidden />
          Preview: this is what people you share with see
        </span>
      ) : (
        <span className={cn(PILL, 'text-muted-foreground')}>
          <Lock className="size-3" aria-hidden />
          Read only
        </span>
      )}
      <span className={cn(PILL, 'text-muted-foreground')}>
        Updated {relativeAgo(report.generated_at, now) ?? 'just now'}
        {report.interviews.last_synced_at ? ` · email synced ${relativeAgo(report.interviews.last_synced_at, now)}` : ''}
      </span>
      {share?.expires_at ? (
        <span className={cn(PILL, 'text-muted-foreground')}>
          <Timer className="size-3" aria-hidden />
          Access until {shortDate(share.expires_at)}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      <PageLayout
        title={`${name}'s job search`}
        description={
          <>
            {report.owner.headline ? <span className="font-medium text-foreground">{report.owner.headline}. </span> : null}
            {share
              ? `Shared with you${share.shared_at ? ` on ${shortDate(share.shared_at)}` : ''}. A live view of interviews and applications.`
              : 'A live view of interviews and applications.'}
          </>
        }
        width="full"
        variant="hero"
        icon={BriefcaseBusiness}
        meta={meta}
        actions={actionsBar}
      >
        <div className="space-y-6">
          {share?.message ? (
            <figure className="flex gap-3 rounded-2xl border bg-card/90 px-4 py-3 shadow-xs">
              <MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
              <div className="min-w-0">
                <blockquote className="text-sm whitespace-pre-wrap">{share.message}</blockquote>
                <figcaption className="mt-1 text-xs text-muted-foreground">Note from {name}</figcaption>
              </div>
            </figure>
          ) : null}

          {processes.length ? (
            <>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <SectionCard
                  title="Upcoming interviews"
                  icon={CalendarCheck}
                  description={upcoming.length ? `${upcoming.length} scheduled` : undefined}
                >
                  {upcoming.length ? (
                    <ul className="-mx-2 space-y-1">
                      {upcoming.slice(0, 8).map((item) => (
                        <UpcomingRow key={item.event.id} item={item} onOpen={setSelectedId} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No interviews on the calendar right now.</p>
                  )}
                </SectionCard>
                <SectionCard
                  title="Needs action"
                  icon={AlertTriangle}
                  description={actions.length + outcome.length ? undefined : `${name} is all caught up`}
                >
                  {actions.length + outcome.length ? (
                    <ul className="-mx-2 space-y-1">
                      {actions.slice(0, 6).map((item) => (
                        <ActionRow
                          key={item.event.id}
                          item={item}
                          hint={item.event.status === 'needs_scheduling' ? 'Pick a time' : 'Action required'}
                          now={now}
                          onOpen={setSelectedId}
                        />
                      ))}
                      {outcome.slice(0, 4).map((item) => (
                        <ActionRow key={item.event.id} item={item} hint="Outcome pending" now={now} onOpen={setSelectedId} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">Scheduling requests and open tasks appear here.</p>
                  )}
                </SectionCard>
              </div>

              <section aria-label="Pipeline" className="space-y-3">
                <h2 className="text-sm font-semibold">Interview pipeline</h2>
                <InterviewBoard processes={processes} onOpen={setSelectedId} now={now} />
              </section>
            </>
          ) : (
            <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                <Inbox className="size-5" aria-hidden />
              </span>
              <h2 className="mt-3 text-sm font-semibold">No interview processes yet</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {report.interviews.connected
                  ? 'Interviews show up here as soon as recruiters reach out.'
                  : `${name} has not connected an inbox yet, so interviews are not tracked.`}
              </p>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <ActivityCard data={data} />
            <PoolCard pool={report.pool} allTime={report.applications.all_time} />
          </div>

          <ApplicationsCard data={data} now={now} onOpen={setSelectedId} />
        </div>
      </PageLayout>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          {selected ? <InterviewDetailSheet key={selected.id} process={selected} readOnly /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ActivityCard({ data }: { data: SharedReportResponse }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const range = activityWindow(data.report.activity, days);
  const rows = buildActivityRows(range);
  return (
    <SectionCard
      title="Job posts and applications"
      description={`New jobs, jobs scoring ${range.min_match_score}+ and applications sent per day.`}
      className="lg:col-span-2"
      actions={
        <div role="tablist" aria-label="Activity range" className="inline-flex rounded-lg bg-muted p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={days === r}
              onClick={() => setDays(r)}
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
        {ACTIVITY_SERIES.map((s) => (
          <div key={s.key} className="min-w-0 rounded-xl border bg-background/50 px-3 py-2">
            <div className="flex items-center gap-1.5 truncate text-[11px] font-medium text-muted-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
              {s.label}
            </div>
            <div className="mt-0.5 text-lg leading-tight font-semibold tabular-nums">{fmt(range.totals[s.key])}</div>
          </div>
        ))}
      </div>
      {rows.length ? (
        <Suspense fallback={<Skeleton className="h-[240px] w-full rounded-xl" />}>
          <ActivityChart data={rows} series={ACTIVITY_SERIES} height={240} />
        </Suspense>
      ) : (
        <p className="py-14 text-center text-sm text-muted-foreground">No activity in this window.</p>
      )}
    </SectionCard>
  );
}

function PoolCard({ pool, allTime }: { pool: ReportPool | null; allTime: number }) {
  const rows: { label: string; value: ReactNode; hint?: string }[] = pool
    ? [
        { label: 'Jobs found', value: fmt(pool.total_jobs), hint: `${fmt(pool.today_scraped)} today` },
        { label: 'Scored against the profile', value: fmt(pool.scored_jobs), hint: `average ${pool.avg_match_score}` },
        { label: 'Strong matches', value: fmt(pool.best_jobs) },
        { label: 'Tailored documents ready', value: fmt(pool.ready_jobs) },
        { label: 'Applied, all time', value: fmt(allTime) },
      ]
    : [{ label: 'Applied, all time', value: fmt(allTime) }];
  return (
    <SectionCard title="Search at a glance" icon={BriefcaseBusiness} description={pool ? `Applies at a match score of ${pool.min_match_score}+.` : undefined}>
      <dl className="divide-y">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-sm text-muted-foreground">{r.label}</dt>
            <dd className="text-right">
              <span className="text-base font-semibold tabular-nums">{r.value}</span>
              {r.hint ? <span className="block text-[11px] text-muted-foreground">{r.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

function ApplicationsCard({
  data,
  now,
  onOpen,
}: {
  data: SharedReportResponse;
  now: number;
  onOpen: (id: string) => void;
}) {
  const { items, total, lookback_days: lookback } = data.report.applications;
  const [filter, setFilter] = useState<ApplicationFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const counts = applicationCounts(items, now);
  const shown = filterApplications(items, filter, query);

  return (
    <SectionCard
      title="Applications"
      icon={ClipboardCheck}
      description={
        total > items.length
          ? `Latest ${fmt(items.length)} of ${fmt(total)} in the last ${lookback} days · ${fmt(counts.week)} this week`
          : `${fmt(total)} in the last ${lookback} days · ${fmt(counts.week)} this week`
      }
      actions={
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Search applications"
            placeholder="Search company or role"
            className="h-8 pl-8 text-sm"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
      }
    >
      <div role="tablist" aria-label="Application status" className="mb-3 flex flex-wrap gap-1.5">
        {APPLICATION_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setLimit(PAGE);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === f.id ? 'border-brand/40 bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {f.label}
            <span className="tabular-nums opacity-70">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {shown.length ? (
        <>
          <div className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_4.5rem_minmax(0,1fr)_2rem] gap-3 border-b px-2 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase md:grid">
            <span>Role</span>
            <span>Status</span>
            <span>Applied</span>
            <span className="text-right">Match</span>
            <span>Source</span>
            <span className="sr-only">Posting</span>
          </div>
          <ul aria-label="Applications list" className="divide-y">
            {shown.slice(0, limit).map((app) => (
              <ApplicationRow key={app.id} app={app} now={now} onOpen={onOpen} />
            ))}
          </ul>
          {shown.length > limit ? (
            <div className="mt-3 flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE * 2)}>
                Show more ({fmt(shown.length - limit)} left)
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {items.length ? 'No applications match this view.' : `No applications in the last ${lookback} days.`}
        </p>
      )}
    </SectionCard>
  );
}

function ApplicationRow({ app, now, onOpen }: { app: ReportApplication; now: number; onOpen: (id: string) => void }) {
  const company = app.company || 'Company not listed';
  const title = app.title || 'Role not listed';
  const label = `${company}, ${title}`;
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <CompanyAvatar name={company} className="size-8 text-xs" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {company}
            {app.location ? ` · ${app.location}` : ''}
          </span>
        </span>
      </span>
      <span className="flex items-center gap-1.5 max-md:order-first max-md:col-span-2">
        {app.process_id ? (
          <StageChip stage={app.stage} />
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
            Applied, no reply yet
          </span>
        )}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums" title={app.applied_at ? shortDate(app.applied_at) : undefined}>
        {relativeAgo(app.applied_at, now) ?? '-'}
      </span>
      <span className="text-right text-xs tabular-nums max-md:text-left">
        {app.match_score != null ? (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 font-semibold',
              app.match_score >= 80 ? 'bg-status-ready/15 text-status-ready' : app.match_score >= 60 ? 'bg-brand/10 text-brand' : 'bg-muted text-muted-foreground',
            )}
          >
            {app.match_score}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </span>
      <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
        {app.source === 'email' ? <Mail className="size-3 shrink-0" aria-hidden /> : <ClipboardCheck className="size-3 shrink-0" aria-hidden />}
        <span className="truncate">{app.source === 'email' ? 'Confirmation email' : 'Marked in NAO'}</span>
      </span>
    </>
  );
  const grid =
    'grid min-w-0 flex-1 grid-cols-2 items-center gap-x-3 gap-y-1.5 px-2 py-2.5 text-left md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_4.5rem_minmax(0,1fr)]';
  return (
    <li className="flex items-center gap-1 rounded-lg transition-colors hover:bg-muted/40">
      {app.process_id ? (
        <button
          type="button"
          className={cn(grid, 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50')}
          aria-label={`${label}. View interview details`}
          onClick={() => onOpen(app.process_id!)}
        >
          {body}
        </button>
      ) : (
        <div className={grid}>{body}</div>
      )}
      <span className="flex w-8 shrink-0 justify-center">
        {app.url ? (
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open the ${label} job posting`}
            title="Open the job posting"
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </span>
    </li>
  );
}

function ReportLoading() {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:p-8" aria-busy="true" aria-label="Loading report">
      <Skeleton className="h-36 w-full rounded-2xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-2xl" />
    </div>
  );
}

function ReportUnavailable({ status, onRetry }: { status?: number; onRetry: () => void }) {
  const gone = status === 404;
  const base = sharedBase(useLocation().pathname);
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          {gone ? <Link2Off className="size-5" aria-hidden /> : <AlertTriangle className="size-5" aria-hidden />}
        </span>
        <h1 className="mt-4 text-lg font-semibold">{gone ? 'This report is no longer shared with you' : 'Could not load the report'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {gone
            ? 'The person who shared it removed your access, or the access period ended.'
            : 'Check your connection and try again.'}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {gone ? (
            <Link to={base} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Back to Shared with me
            </Link>
          ) : (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
