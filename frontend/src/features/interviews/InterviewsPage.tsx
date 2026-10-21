import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  ChevronDown,
  Inbox,
  Loader2,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Share2,
  Trophy,
} from 'lucide-react';
import { toast } from 'sonner';
import { disconnectMail, fetchInterviews, syncInterviews } from '@/api/interviewsApi';
import { HeroStat, PageLayout, SectionCard } from '@/components/app/PageLayout';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { InterviewsOverview, MailConnection } from '@/types/interviews';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { AddInterviewDialog } from './AddInterviewDialog';
import { ConnectMailGate } from './ConnectMailGate';
import { ShareReportDialog } from '../sharing/ShareReportDialog';
import { SharedWithYouMenu } from '../sharing/SharedWithYouMenu';
import { InterviewBoard } from './InterviewBoard';
import { InterviewDetailSheet } from './InterviewDetailSheet';
import { ActionRow, UpcomingRow } from './InterviewRows';
import {
  actionItems,
  awaitingOutcome,
  browserTimezone,
  dateTimeLabel,
  mailErrorMessage,
  relativeAgo,
  shouldAutoSync,
  syncDoneMessage,
  upcomingInterviews,
} from './interviewsModel';
import { INTERVIEWS_KEY, MAIL_APPLICATIONS_KEY } from './queries';
import { useIgnoreEvents } from './useIgnoreEvents';

export function InterviewsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const query = useQuery({
    queryKey: INTERVIEWS_KEY,
    queryFn: fetchInterviews,
    refetchInterval: (q) => (q.state.data?.connection.sync_status === 'running' ? 3000 : false),
  });
  const data = query.data;
  const connection = data?.connection;
  const linked = !!connection?.connected && connection.status !== 'needs_reauth';

  const sync = useMutation({
    mutationFn: () => syncInterviews(browserTimezone()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: INTERVIEWS_KEY }),
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not start the sync.')),
  });

  const disconnect = useMutation({
    mutationFn: disconnectMail,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INTERVIEWS_KEY });
      toast.success('Email disconnected');
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not disconnect.')),
  });

  const mailParam = params.get('mail');
  useEffect(() => {
    if (!mailParam) return;
    if (mailParam === 'connected') {
      toast.success('Email connected. Looking for interviews now.');
      sync.mutate();
    } else {
      toast.error(mailErrorMessage(params.get('reason')));
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('mail');
        next.delete('reason');
        return next;
      },
      { replace: true },
    );
    // Runs once per redirect back from the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailParam]);

  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current || mailParam || !linked || !connection) return;
    autoSynced.current = true;
    if (connection.sync_status !== 'running' && shouldAutoSync(connection.last_synced_at)) sync.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, connection, mailParam]);

  const prevStatus = useRef(connection?.sync_status);
  useEffect(() => {
    const status = connection?.sync_status;
    if (prevStatus.current === 'running' && status && status !== 'running') {
      if (status === 'error') {
        toast.error(connection?.last_sync_error || 'Sync failed.');
      } else {
        toast.success(syncDoneMessage(connection?.last_sync_stats));
      }
      void qc.invalidateQueries({ queryKey: MAIL_APPLICATIONS_KEY });
    }
    prevStatus.current = status;
  }, [connection, qc]);

  const selected = data?.processes.find((p) => p.id === selectedId) ?? null;
  const syncing = sync.isPending || connection?.sync_status === 'running';
  const now = useNow(60_000);
  const syncedAgo = relativeAgo(connection?.last_synced_at, now);

  let meta: ReactNode = undefined;
  let actions: ReactNode = <SharedWithYouMenu />;
  if (data && linked) {
    const s = data.summary;
    meta = (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HeroStat icon={CalendarClock} label="Active processes" value={s.active} />
        <HeroStat icon={CalendarCheck} label="Interviews this week" value={s.upcoming_week} tone="bg-chart-2/10 text-chart-2" />
        <HeroStat
          icon={AlertTriangle}
          label="Needs your action"
          value={s.needs_action}
          tone={s.needs_action ? 'bg-status-preparing/15 text-status-preparing' : 'bg-muted text-muted-foreground'}
        />
        <HeroStat icon={Trophy} label="Offers" value={s.offers} tone="bg-status-ready/15 text-status-ready" />
      </div>
    );
    actions = (
      <div className="flex flex-wrap items-center gap-2">
        <SharedWithYouMenu />
        <Button
          variant="outline"
          size="sm"
          onClick={() => sync.mutate()}
          disabled={syncing}
          aria-label={syncing ? 'Syncing' : `Sync now, ${syncedAgo ? `last synced ${syncedAgo}` : 'never synced'}`}
          title={connection?.last_synced_at ? `Last synced ${dateTimeLabel(connection.last_synced_at)}` : undefined}
        >
          <RefreshCw className={cn(syncing && 'animate-spin')} />
          {syncing ? 'Syncing...' : 'Sync now'}
          {!syncing ? (
            <span className="font-normal text-muted-foreground">· {syncedAgo ? `synced ${syncedAgo}` : 'never synced'}</span>
          ) : null}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
          <Share2 />
          Share report
        </Button>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add process
        </Button>
        <MailAccountMenu connection={connection!} onDisconnect={() => setConfirmDisconnect(true)} />
      </div>
    );
  }

  return (
    <PageLayout
      title="Interviews"
      description="Every interview, stage and next step across your applications, kept up to date from your email."
      variant="hero"
      icon={CalendarClock}
      meta={meta}
      actions={actions}
    >
      {query.isLoading ? (
        <LoadingState />
      ) : query.isError || !data ? (
        <SectionCard title="Could not load interviews" icon={AlertCircle}>
          <p className="text-sm text-muted-foreground">{extractApiErrorMessage(query.error, 'Try again in a moment.')}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </SectionCard>
      ) : !linked ? (
        <ConnectMailGate
          serverConfigured={data.server.server_configured}
          reconnect={connection?.status === 'needs_reauth'}
        />
      ) : (
        <PipelineView data={data} syncing={syncing} now={now} onOpen={setSelectedId} onAdd={() => setAdding(true)} />
      )}

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          {selected ? (
            <InterviewDetailSheet key={selected.id} process={selected} onDeleted={() => setSelectedId(null)} />
          ) : null}
        </SheetContent>
      </Sheet>

      <AddInterviewDialog open={adding} onOpenChange={setAdding} onCreated={setSelectedId} />
      {sharing ? <ShareReportDialog open={sharing} onOpenChange={setSharing} /> : null}

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {connection?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              NAO stops reading new emails and this page locks until you connect again. Your tracked processes are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => disconnect.mutate()}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}

/** Current time, refreshed on an interval so relative labels stay fresh. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function MailAccountMenu({ connection, onDisconnect }: { connection: MailConnection; onDisconnect: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="max-w-48" aria-label="Connected email account" />}
      >
        <Mail />
        <span className="truncate max-sm:hidden">{connection.email}</span>
        <ChevronDown className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {connection.provider_label ?? 'Email'} · {connection.email}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDisconnect}>
          <LogOut />
          Disconnect email
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading interviews">
      <Skeleton className="h-12 w-full rounded-2xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-2xl" />
    </div>
  );
}

function SyncBar({ connection, syncing }: { connection: MailConnection; syncing: boolean }) {
  const stats = connection.last_sync_stats;
  const failed = connection.sync_status === 'error' && !syncing;
  if (!syncing && !failed && !stats) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-xs',
        failed ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'bg-card/80 text-muted-foreground backdrop-blur-sm',
      )}
    >
      {syncing ? (
        <span className="flex items-center gap-1.5 font-medium text-brand tabular-nums">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Reading your recent hiring emails
          {connection.sync_status === 'running' && stats?.candidates
            ? `: ${stats.processed ?? 0} of ${stats.candidates} done`
            : '...'}
        </span>
      ) : failed ? (
        <span className="flex items-center gap-1.5 font-medium">
          <AlertCircle className="size-3.5" aria-hidden />
          Last sync failed: {connection.last_sync_error || 'unknown error'}
        </span>
      ) : null}
      {stats && !syncing ? (
        <span className="flex items-center gap-1.5 tabular-nums">
          {!failed ? <Inbox className="size-3.5" aria-hidden /> : null}
          Last sync: {stats.scanned} emails
          {stats.calendar === 'ok' ? ` and ${stats.calendar_events ?? 0} calendar events` : ''} checked ·{' '}
          {stats.relevant} about your applications
          {stats.applications ? ` · ${stats.applications} new applications` : ''}
          {stats.created || stats.updated ? ` · ${stats.created} new, ${stats.updated} updated processes` : ''}
        </span>
      ) : null}
      {stats?.calendar === 'no_access' && !syncing ? (
        <span className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5" aria-hidden />
          Calendar not included. Disconnect and connect your email again to track calendar events.
        </span>
      ) : null}
    </div>
  );
}

function PipelineView({
  data,
  syncing,
  now,
  onOpen,
  onAdd,
}: {
  data: InterviewsOverview;
  syncing: boolean;
  now: number;
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const { processes, connection } = data;
  const ignore = useIgnoreEvents();
  const upcoming = upcomingInterviews(processes);
  const actions = actionItems(processes);
  const outcome = awaitingOutcome(processes);

  if (!processes.length) {
    return (
      <div className="space-y-4">
        <SyncBar connection={connection} syncing={syncing} />
        <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            {syncing ? <Loader2 className="size-6 animate-spin" aria-hidden /> : <Inbox className="size-6" aria-hidden />}
          </span>
          <h2 className="mt-4 text-base font-semibold">
            {syncing ? 'Looking for interviews in your inbox' : 'No interview processes yet'}
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {syncing
              ? 'This takes a minute on the first run. Processes appear here as they are found.'
              : 'Recruiter emails, invites and assessments from the last 60 days show up here. You can also add a process yourself.'}
          </p>
          {!syncing ? (
            <Button size="sm" className="mt-5" onClick={onAdd}>
              <Plus />
              Add process
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SyncBar connection={connection} syncing={syncing} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard
          title="Upcoming interviews"
          icon={CalendarCheck}
          description={upcoming.length ? `${upcoming.length} scheduled` : undefined}
        >
          {upcoming.length ? (
            <ul className="-mx-2 space-y-1">
              {upcoming.slice(0, 6).map((item) => (
                <UpcomingRow key={item.event.id} item={item} onOpen={onOpen} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No interviews on the calendar. Scheduled rounds show up here.</p>
          )}
        </SectionCard>

        <SectionCard
          title="Needs your action"
          icon={AlertTriangle}
          description={actions.length + outcome.length ? undefined : 'You are all caught up'}
        >
          {actions.length + outcome.length ? (
            <ul className="-mx-2 space-y-1">
              {actions.slice(0, 5).map((item) => (
                <ActionRow
                  key={item.event.id}
                  item={item}
                  hint={item.event.status === 'needs_scheduling' ? 'Pick a time' : 'Action required'}
                  now={now}
                  onOpen={onOpen}
                  onIgnore={ignore}
                />
              ))}
              {outcome.slice(0, 4).map((item) => (
                <ActionRow
                  key={item.event.id}
                  item={item}
                  hint="Log the outcome"
                  now={now}
                  onOpen={onOpen}
                  onIgnore={ignore}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Scheduling requests, assessments and rounds waiting for an outcome appear here.
            </p>
          )}
        </SectionCard>
      </div>

      <section aria-label="Pipeline" className="space-y-3">
        <h2 className="text-sm font-semibold">Pipeline</h2>
        <InterviewBoard processes={processes} onOpen={onOpen} onIgnore={ignore} now={now} />
      </section>
    </div>
  );
}
