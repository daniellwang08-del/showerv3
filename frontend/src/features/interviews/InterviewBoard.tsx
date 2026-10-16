import { useState, type ReactNode } from 'react';
import { AlertCircle, CalendarClock, ChevronDown, ExternalLink, Mail, PanelRightOpen, PenLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InterviewProcess } from '@/types/interviews';
import {
  buildBoard,
  dayLabel,
  eventTitle,
  PIPELINE_STAGES,
  relativeAgo,
  STAGE_META,
  stageIndex,
  timeLabel,
} from './interviewsModel';

export function CompanyAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand/20 to-fuchsia-500/10 text-sm font-semibold text-brand',
        className,
      )}
    >
      {name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

export function StageChip({ stage }: { stage: InterviewProcess['stage'] }) {
  const meta = STAGE_META[stage];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', meta.tone)}>
      <span aria-hidden className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}

export function StageProgress({ stage, className }: { stage: InterviewProcess['stage']; className?: string }) {
  const index = stageIndex(stage);
  return (
    <div
      className={cn('flex gap-0.5', className)}
      role="img"
      aria-label={index >= 0 ? `Stage ${index + 1} of ${PIPELINE_STAGES.length}` : STAGE_META[stage].label}
    >
      {PIPELINE_STAGES.map((s, i) => (
        <span
          key={s}
          className={cn(
            'h-1 flex-1 rounded-full transition-colors',
            index < 0 ? 'bg-muted' : i <= index ? STAGE_META[stage].dot : 'bg-muted',
          )}
        />
      ))}
    </div>
  );
}

export function processLabel(process: Pick<InterviewProcess, 'company' | 'role_title'>): string {
  return `${process.company}${process.role_title ? `, ${process.role_title}` : ''}`;
}

/**
 * The main click target of a row or card: opens the email in the user's
 * mailbox when we have a link, otherwise opens the details sheet.
 */
export function OpenEmailTarget({
  href,
  label,
  onDetails,
  className,
  children,
}: {
  href: string | null | undefined;
  label: string;
  onDetails: () => void;
  className?: string;
  children: ReactNode;
}) {
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${label}. Open email`}
        title="Open the email in your mailbox"
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onDetails} aria-label={label} className={className}>
      {children}
    </button>
  );
}

/** Secondary control that always opens the details sheet. */
export function DetailsButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Details for ${label}`}
      title="Details"
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      <PanelRightOpen className="size-4" aria-hidden />
    </button>
  );
}

function ProcessCard({ process, onOpen }: { process: InterviewProcess; onOpen: () => void }) {
  const next = process.next_event;
  const label = processLabel(process);
  return (
    <div className="group relative transition-transform hover:-translate-y-0.5">
      <OpenEmailTarget
        href={process.email_url}
        label={label}
        onDetails={onOpen}
        className="block w-full rounded-xl border bg-card/95 p-3 pb-2.5 text-left shadow-xs transition-all outline-none group-hover:border-brand/30 group-hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-start gap-2.5">
          <CompanyAvatar name={process.company} className="size-8 text-xs" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{process.company}</p>
            <p className="truncate text-xs text-muted-foreground">{process.role_title || 'Role not specified'}</p>
          </div>
          {process.needs_action ? (
            <AlertCircle className="size-4 shrink-0 text-amber-500" aria-label="Needs your action" />
          ) : null}
        </div>
        <StageProgress stage={process.stage} className="mt-3" />
        {next?.scheduled_at ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-xs font-medium text-brand">
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {dayLabel(next.scheduled_at)} · {timeLabel(next.scheduled_at)} · {eventTitle(next)}
            </span>
          </p>
        ) : process.next_step ? (
          <p className="mt-2.5 line-clamp-2 text-xs text-muted-foreground">{process.next_step}</p>
        ) : null}
        <p className="mt-2 flex items-center gap-1 pr-8 text-[11px] text-muted-foreground/80">
          {process.source === 'manual' ? <PenLine className="size-3" aria-hidden /> : <Mail className="size-3" aria-hidden />}
          {relativeAgo(process.last_activity_at) ?? 'No activity yet'}
          {process.email_url ? (
            <ExternalLink className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          ) : null}
        </p>
      </OpenEmailTarget>
      <DetailsButton label={label} onClick={onOpen} className="absolute right-1.5 bottom-1.5" />
    </div>
  );
}

export function InterviewBoard({
  processes,
  onOpen,
}: {
  processes: InterviewProcess[];
  onOpen: (id: string) => void;
}) {
  const { columns, closed } = buildBoard(processes);
  const [showClosed, setShowClosed] = useState(false);

  return (
    <div className="space-y-4">
      <div className="no-scrollbar -mx-1 overflow-x-auto px-1 pb-1">
        <div className="grid min-w-[960px] grid-cols-5 gap-3">
          {columns.map((col) => {
            const meta = STAGE_META[col.stages[col.stages.length - 1]];
            return (
              <section
                key={col.id}
                aria-label={`${col.label} column`}
                className="flex min-w-0 flex-col rounded-2xl border bg-muted/30 p-2.5"
              >
                <header className="mb-2 flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-xs font-semibold">
                    <span aria-hidden className={cn('size-2 rounded-full', meta.dot)} />
                    {col.label}
                  </span>
                  <span className="rounded-full bg-background px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                    {col.processes.length}
                  </span>
                </header>
                <div className="flex flex-col gap-2">
                  {col.processes.length ? (
                    col.processes.map((p) => <ProcessCard key={p.id} process={p} onOpen={() => onOpen(p.id)} />)
                  ) : (
                    <p className="rounded-xl border border-dashed px-2 py-6 text-center text-[11px] text-muted-foreground">
                      Nothing here
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {closed.length ? (
        <div className="rounded-2xl border bg-card/80 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            aria-expanded={showClosed}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Closed processes ({closed.length})
            <ChevronDown className={cn('size-4 transition-transform', showClosed && 'rotate-180')} aria-hidden />
          </button>
          {showClosed ? (
            <ul className="divide-y border-t">
              {closed.map((p) => (
                <li key={p.id} className="flex items-center gap-1 pr-2 hover:bg-muted/40">
                  <OpenEmailTarget
                    href={p.email_url}
                    label={processLabel(p)}
                    onDetails={() => onOpen(p.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <CompanyAvatar name={p.company} className="size-7 text-xs" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{p.company}</span>
                      {p.role_title ? <span className="text-muted-foreground"> · {p.role_title}</span> : null}
                    </span>
                    <StageChip stage={p.stage} />
                  </OpenEmailTarget>
                  <DetailsButton label={processLabel(p)} onClick={() => onOpen(p.id)} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
