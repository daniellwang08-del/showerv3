import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Briefcase, ExternalLink, Inbox, Loader2, MailCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { fetchMailApplications, syncInterviews } from '@/api/interviewsApi';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { MailApplicationsOverview } from '@/types/interviews';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { browserTimezone, relativeAgo, syncDoneMessage } from '@/features/interviews/interviewsModel';
import { INTERVIEWS_KEY, MAIL_APPLICATIONS_KEY } from '@/features/interviews/queries';
import type { ApplicationsSeries } from './InsightsCharts';
import {
  APPLICATION_RANGES,
  buildApplicationRows,
  busiestDay,
  exactDateTime,
  longDate,
  type ApplicationRange,
} from './inboxApplications';

let chartsModule: Promise<typeof import('./InsightsCharts')> | undefined;
const ApplicationsChart = lazy(() =>
  (chartsModule ??= import('./InsightsCharts')).then((m) => ({ default: m.ApplicationsChart })),
);

const SERIES: ApplicationsSeries[] = [
  { key: 'applications', label: 'Applications', color: 'var(--status-applied)', kind: 'bar' },
  { key: 'average', label: '7-day average', color: 'var(--chart-1)', kind: 'line' },
];

/** `memberId` reads a member of a team space the caller leads. */
export function useMailApplications(days: number, memberId?: string) {
  return useQuery({
    queryKey: memberId ? [...MAIL_APPLICATIONS_KEY, days, 'member', memberId] : [...MAIL_APPLICATIONS_KEY, days],
    queryFn: () => (memberId ? fetchMailApplications(days, browserTimezone(), memberId) : fetchMailApplications(days, browserTimezone())),
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.connection?.sync_status === 'running' ? 3000 : false),
  });
}

/** With `member`, a read-only view of a team member's inbox applications for their lead. */
export function InboxApplicationsCard({ member }: { member?: { id: string; name: string } } = {}) {
  const qc = useQueryClient();
  const [days, setDays] = useState<ApplicationRange>(30);
  const query = useMailApplications(days, member?.id);
  const data = query.data;
  const conn = data?.connection ?? null;
  const readOnly = !!member;

  const sync = useMutation({
    mutationFn: () => syncInterviews(browserTimezone()),
    onSuccess: (res) => {
      if (!res.started) toast.message('A sync is already running.');
      void qc.invalidateQueries({ queryKey: MAIL_APPLICATIONS_KEY });
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not start the sync.')),
  });

  const status = conn?.sync_status;
  const prevStatus = useRef(status);
  useEffect(() => {
    if (!readOnly && prevStatus.current === 'running' && status && status !== 'running') {
      if (status === 'error') toast.error(conn?.last_sync_error || 'Sync failed.');
      else toast.success(syncDoneMessage(conn?.last_sync_stats));
      void qc.invalidateQueries({ queryKey: INTERVIEWS_KEY });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    }
    prevStatus.current = status;
  }, [readOnly, status, conn?.last_sync_error, conn?.last_sync_stats, qc]);

  const syncing = sync.isPending || status === 'running';
  const rows = buildApplicationRows(data);
  const peak = busiestDay(rows);
  const syncedExact = exactDateTime(conn?.last_synced_at);
  const syncedAgo = relativeAgo(conn?.last_synced_at);
  const title = member ? `Applications from ${member.name}'s inbox` : 'Applications from your inbox';

  return (
    <section
      aria-label={title}
      className="jobs-summary-card min-w-0 rounded-2xl border bg-card/85 shadow-xs backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <MailCheck className="size-4 text-status-applied" aria-hidden />
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {conn
              ? `Counted from application confirmation emails in ${conn.email}.`
              : readOnly
                ? 'Counted from application confirmation emails once they connect an inbox.'
                : 'Every "thanks for applying" email counts, even for jobs you applied to outside NAO.'}
          </p>
        </div>
        {conn ? (
          <div className="flex flex-wrap items-center gap-2">
            <RangeTabs value={days} onChange={setDays} />
            {readOnly ? null : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => sync.mutate()}
                disabled={syncing || conn.status === 'needs_reauth'}
                aria-label={syncing ? 'Syncing inbox' : 'Sync inbox now'}
              >
                <RefreshCw className={cn(syncing && 'animate-spin')} />
                {syncing ? 'Syncing...' : 'Sync now'}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <div className="px-5 pt-3 pb-5">
        {query.isPending ? (
          <Skeleton className="h-[300px] w-full rounded-xl" />
        ) : query.isError || !data ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
            <span className="flex items-center gap-2">
              <AlertCircle className="size-4 text-destructive" aria-hidden />
              {readOnly ? 'Could not load their inbox applications.' : 'Could not load your inbox applications.'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : !conn ? (
          member ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed bg-background/40 px-6 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Inbox className="size-5" aria-hidden />
              </span>
              <p className="mt-3 text-sm font-medium">{member.name} has not connected an inbox</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Applications they send outside NAO appear here once they connect their email on the Interviews page.
              </p>
            </div>
          ) : (
            <ConnectPrompt configured={data.server.server_configured} />
          )
        ) : (
          <>
            <SyncStatus
              readOnly={readOnly}
              syncing={syncing}
              progress={
                status === 'running' && conn.last_sync_stats?.candidates
                  ? `${conn.last_sync_stats.processed ?? 0} of ${conn.last_sync_stats.candidates} emails read`
                  : null
              }
              exact={syncedExact}
              ago={syncedAgo}
              error={status === 'error' ? conn.last_sync_error : null}
              needsReauth={conn.status === 'needs_reauth'}
            />
            <Kpis data={data} days={days} />
            {data.totals.range === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {syncing
                  ? 'Reading your inbox. Applications appear here as they are found.'
                  : `No application confirmations in the last ${days} days.`}
              </p>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div className="min-w-0">
                  <Suspense fallback={<Skeleton className="h-[240px] w-full rounded-xl" />}>
                    <ApplicationsChart data={rows} series={SERIES} />
                  </Suspense>
                  <p className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                    <span>
                      {(data.totals.range / Math.max(rows.length, 1)).toFixed(1)} applications per day on average
                    </span>
                    {peak ? (
                      <span>
                        Busiest day: {longDate(peak.date)} ({peak.applications})
                      </span>
                    ) : null}
                  </p>
                </div>
                <RecentList data={data} />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RangeTabs({ value, onChange }: { value: ApplicationRange; onChange: (d: ApplicationRange) => void }) {
  return (
    <div role="tablist" aria-label="Applications range" className="inline-flex rounded-lg bg-muted p-0.5">
      {APPLICATION_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={value === r}
          onClick={() => onChange(r)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition',
            value === r ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {r} days
        </button>
      ))}
    </div>
  );
}

function SyncStatus({
  readOnly,
  syncing,
  progress,
  exact,
  ago,
  error,
  needsReauth,
}: {
  readOnly: boolean;
  syncing: boolean;
  progress: string | null;
  exact: string | null;
  ago: string | null;
  error: string | null | undefined;
  needsReauth: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs',
        error || needsReauth ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'bg-background/50 text-muted-foreground',
      )}
    >
      {syncing ? (
        <span className="flex items-center gap-1.5 font-medium text-brand">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {readOnly ? 'Syncing their inbox...' : progress ? `Syncing your inbox: ${progress}` : 'Syncing your inbox...'}
        </span>
      ) : null}
      {needsReauth && readOnly ? (
        <span>Their email connection expired. Counts resume when they reconnect.</span>
      ) : needsReauth ? (
        <span>
          Your email connection expired.{' '}
          <Link to="/app/interviews" className="font-medium underline">
            Reconnect
          </Link>
        </span>
      ) : error ? (
        <span>Last sync failed: {error}</span>
      ) : null}
      <span className="tabular-nums">
        {exact ? (
          <>
            Last synced <span className="font-medium text-foreground">{exact}</span>
            {ago ? ` (${ago})` : null}
          </>
        ) : (
          'Not synced yet'
        )}
      </span>
    </div>
  );
}

function Kpis({ data, days }: { data: MailApplicationsOverview; days: number }) {
  const items = [
    { label: 'Today', value: data.totals.today },
    { label: 'Last 7 days', value: data.totals.week },
    { label: `Last ${days} days`, value: data.totals.range },
    { label: 'Companies', value: data.totals.companies },
  ];
  return (
    <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 rounded-xl border bg-background/50 px-3 py-2">
          <dt className="truncate text-[11px] font-medium text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 text-lg leading-tight font-semibold tabular-nums">{item.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function RecentList({ data }: { data: MailApplicationsOverview }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground">
        Recent applications
        {data.totals.linked_jobs ? (
          <span className="font-normal">{data.totals.linked_jobs} matched to jobs in NAO</span>
        ) : null}
      </h3>
      <ul aria-label="Recent applications" className="-mx-2 max-h-[264px] space-y-0.5 overflow-y-auto">
        {data.recent.map((app) => {
          const body = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{app.company}</span>
                <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  {app.job ? <Briefcase className="size-3 shrink-0" aria-label="Matched to a job in NAO" /> : null}
                  <span className="truncate">{app.role_title || app.email_subject || 'Role not given'}</span>
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title={exactDateTime(app.applied_at) ?? undefined}>
                {relativeAgo(app.applied_at)}
              </span>
              {app.email_url ? <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
            </>
          );
          return (
            <li key={app.id}>
              {app.email_url ? (
                <a
                  href={app.email_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${app.company}${app.role_title ? `, ${app.role_title}` : ''}. Open email`}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {body}
                </a>
              ) : (
                <div className="flex items-center gap-3 px-2 py-1.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConnectPrompt({ configured }: { configured: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed bg-background/40 px-6 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
        <Inbox className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">Count your applications from your email</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">
        Connect your inbox and NAO counts every application confirmation, marks matching jobs as applied and keeps this
        chart current.
      </p>
      {configured ? (
        <Button size="sm" className="mt-4" nativeButton={false} render={<Link to="/app/interviews" />}>
          Connect email
        </Button>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Email connection is not available on this server yet.</p>
      )}
    </div>
  );
}
