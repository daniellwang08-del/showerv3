import { useState } from 'react';
import { AlertCircle, CalendarClock, ChevronDown, Mail, PenLine } from 'lucide-react';
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

function ProcessCard({ process, onOpen }: { process: InterviewProcess; onOpen: () => void }) {
  const next = process.next_event;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${process.company}${process.role_title ? `, ${process.role_title}` : ''}`}
      className="group w-full rounded-xl border bg-card/95 p-3 text-left shadow-xs transition-all outline-none hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50"
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
      <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground/80">
        {process.source === 'manual' ? <PenLine className="size-3" aria-hidden /> : <Mail className="size-3" aria-hidden />}
        {relativeAgo(process.last_activity_at) ?? 'No activity yet'}
      </p>
    </button>
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
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40"
                  >
                    <CompanyAvatar name={p.company} className="size-7 text-xs" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{p.company}</span>
                      {p.role_title ? <span className="text-muted-foreground"> · {p.role_title}</span> : null}
                    </span>
                    <StageChip stage={p.stage} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
