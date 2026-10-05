import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Clock3, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJobLogTimeline, fetchRequestTimeline } from '@/api/systemLogsApi';
import type { SystemLogEvent } from '@/types/systemLogs';
import { LogLevelBadge } from './LogLevelBadge';
import { errDetail, formatTime, httpLine } from './logFilters';

export type LogPanel =
  | { kind: 'record'; event: SystemLogEvent; back?: LogPanel }
  | { kind: 'request' | 'job'; id: string };

interface Props {
  panel: LogPanel | null;
  hours: number;
  onPanel: (panel: LogPanel | null) => void;
}

export function LogDetailSheet({ panel, hours, onPanel }: Props) {
  return (
    <Sheet open={panel != null} onOpenChange={(open) => !open && onPanel(null)}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        {panel?.kind === 'record' ? (
          <RecordView panel={panel} onPanel={onPanel} />
        ) : panel ? (
          <TimelineView kind={panel.kind} id={panel.id} hours={hours} onPanel={onPanel} self={panel} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CopyJsonButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = JSON.stringify(value, null, 2);
    void Promise.resolve(navigator.clipboard?.writeText(text)).then(
      () => {
        setCopied(true);
        toast.success('Log record copied');
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy to clipboard'),
    );
  };
  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy JSON'}
    </Button>
  );
}

function RecordView({
  panel,
  onPanel,
}: {
  panel: Extract<LogPanel, { kind: 'record' }>;
  onPanel: (panel: LogPanel | null) => void;
}) {
  const ev = panel.event;
  const http = httpLine(ev);
  const fields: Array<[string, string | null | undefined]> = [
    ['Level', ev.level],
    ['Category', ev.category],
    ['Service', ev.service],
    ['Logger', ev.logger_name],
    ['Request ID', ev.request_id],
    ['User ID', ev.user_id],
    ['Job ID', ev.job_id],
    ['Extraction ID', ev.extraction_id],
    ['Worker job', ev.worker_job_type],
    ['Method', ev.method],
    ['Path', ev.path],
    ['Status', ev.status_code != null ? String(ev.status_code) : null],
    ['Duration', ev.duration_ms != null ? `${ev.duration_ms} ms` : null],
    ['Client IP', ev.client_ip],
  ];

  return (
    <>
      <SheetHeader className="border-b pr-12">
        {panel.back ? (
          <Button variant="ghost" size="xs" className="-ml-1 mb-1 w-fit" onClick={() => onPanel(panel.back!)}>
            <ArrowLeft /> Back to timeline
          </Button>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <LogLevelBadge level={ev.level} />
          <SheetTitle className="break-all font-mono text-sm">{ev.event}</SheetTitle>
        </div>
        <SheetDescription className="tabular-nums">
          {formatTime(ev.created_at)}
          {http ? <span className="font-mono"> · {http}</span> : null}
        </SheetDescription>
      </SheetHeader>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-xs">
          {fields.map(([k, v]) =>
            v ? (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all font-mono">{v}</dd>
              </div>
            ) : null,
          )}
        </dl>

        {ev.message ? (
          <section aria-label="Message">
            <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Message</h3>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs">{ev.message}</p>
          </section>
        ) : null}

        <section aria-label="Full record">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Full record</h3>
            <CopyJsonButton value={ev} />
          </div>
          <pre
            data-testid="log-json"
            className="scrollbar-thin max-h-[50vh] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed"
          >
            {JSON.stringify(ev, null, 2)}
          </pre>
        </section>

        {ev.request_id || ev.job_id ? (
          <div className="flex flex-wrap gap-2">
            {ev.request_id ? (
              <Button variant="outline" size="sm" onClick={() => onPanel({ kind: 'request', id: ev.request_id! })}>
                <Clock3 /> View full request timeline
              </Button>
            ) : null}
            {ev.job_id ? (
              <Button variant="outline" size="sm" onClick={() => onPanel({ kind: 'job', id: ev.job_id! })}>
                <Clock3 /> View job analysis timeline
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

function TimelineView({
  kind,
  id,
  hours,
  self,
  onPanel,
}: {
  kind: 'request' | 'job';
  id: string;
  hours: number;
  self: LogPanel;
  onPanel: (panel: LogPanel | null) => void;
}) {
  const jobHours = Math.max(hours, 72);
  const q = useQuery({
    queryKey: ['admin-logs', 'timeline', kind, id, kind === 'job' ? jobHours : null],
    queryFn: () => (kind === 'job' ? fetchJobLogTimeline(id, jobHours) : fetchRequestTimeline(id)),
  });
  const label = kind === 'job' ? 'job' : 'request';

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle>{kind === 'job' ? 'Job timeline' : 'Request timeline'}</SheetTitle>
        <SheetDescription className="break-all font-mono text-xs text-brand">{id}</SheetDescription>
      </SheetHeader>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {q.isPending ? (
          <div className="space-y-3" aria-label="Loading timeline">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {errDetail(q.error, `Failed to load ${label} timeline`)}
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              <RefreshCw /> Retry
            </Button>
          </div>
        ) : q.data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No events for this {label} id.</p>
        ) : (
          <ol className="relative space-y-1 border-l pl-4">
            {q.data.map((ev) => {
              const http = httpLine(ev);
              return (
                <li key={ev.id} className="relative">
                  <span className="absolute -left-[21px] top-3 size-2.5 rounded-full bg-brand ring-4 ring-popover" />
                  <button
                    type="button"
                    onClick={() => onPanel({ kind: 'record', event: ev, back: self })}
                    className="w-full rounded-lg px-2 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <LogLevelBadge level={ev.level} className="h-4 text-[10px]" />
                      <span className="font-mono text-xs font-medium">{ev.event}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{formatTime(ev.created_at)}</span>
                    </span>
                    {http || ev.duration_ms != null ? (
                      <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                        {http}
                        {ev.duration_ms != null ? `${http ? ' · ' : ''}${ev.duration_ms} ms` : ''}
                      </span>
                    ) : null}
                    {ev.message ? (
                      <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{ev.message}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
