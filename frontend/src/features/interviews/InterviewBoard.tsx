import { useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDashed,
  ExternalLink,
  Mail,
  PanelRightOpen,
  PenLine,
  Repeat,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InterviewEventStatus, InterviewProcess } from '@/types/interviews';
import {
  buildBoard,
  dateTimeLabel,
  dayLabel,
  eventTitle,
  interviewLanes,
  PIPELINE_STAGES,
  plannedSteps,
  relativeAgo,
  ROUND_META,
  STAGE_META,
  stageIndex,
  timeLabel,
  type InterviewLane,
  type ProcessStep,
  type RoundType,
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

const STEP_STATUS: Record<InterviewEventStatus, { label: string; tone: string }> = {
  scheduled: { label: 'Scheduled', tone: 'text-brand' },
  needs_scheduling: { label: 'Pick a time', tone: 'text-amber-600 dark:text-amber-400' },
  action_required: { label: 'Action needed', tone: 'text-amber-600 dark:text-amber-400' },
  completed: { label: 'Done', tone: 'text-emerald-600 dark:text-emerald-400' },
  cancelled: { label: 'Cancelled', tone: 'text-muted-foreground' },
  info: { label: 'Update', tone: 'text-muted-foreground' },
};

function stepStatus(step: ProcessStep, now: number): { label: string; tone: string; Icon: typeof Check } {
  if (step.rescheduled) return { label: 'Rescheduled', tone: 'text-muted-foreground', Icon: Repeat };
  if (step.status === 'scheduled' && step.at && Date.parse(step.at) < now) {
    return { label: 'Log outcome', tone: 'text-amber-600 dark:text-amber-400', Icon: CircleDashed };
  }
  const Icon = step.status === 'completed' ? Check : step.status === 'cancelled' ? X : step.status === 'scheduled' ? CalendarClock : CircleDashed;
  return { ...STEP_STATUS[step.status], Icon };
}

function StepCard({
  step,
  index,
  process,
  isNext,
  now,
  onOpen,
}: {
  step: ProcessStep;
  index: number;
  process: InterviewProcess;
  isNext: boolean;
  now: number;
  onOpen: () => void;
}) {
  const round = ROUND_META[step.type];
  const status = stepStatus(step, now);
  const muted = step.status === 'cancelled';
  const when = step.at
    ? `${dayLabel(step.at, new Date(now))} · ${timeLabel(step.at)}`
    : step.date
      ? `Email ${dayLabel(step.date, new Date(now))}`
      : 'No date yet';
  return (
    <li className="relative w-44 shrink-0 snap-start">
      <OpenEmailTarget
        href={step.event.email_url ?? process.email_url}
        label={`Step ${index + 1}, ${step.title}, ${process.company}`}
        onDetails={onOpen}
        className={cn(
          'flex h-full w-full flex-col rounded-lg border bg-background/80 p-2 text-left transition-colors outline-none hover:border-brand/40 focus-visible:ring-2 focus-visible:ring-ring/50',
          isNext && 'border-brand/50 bg-brand/5 shadow-[0_0_0_1px] shadow-brand/20',
          muted && 'opacity-60',
        )}
      >
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <span className="tabular-nums">Step {index + 1}</span>
          <span aria-hidden className={cn('size-1.5 rounded-full', round.dot)} />
          <span className="truncate">{round.label}</span>
        </span>
        <span className={cn('mt-1 line-clamp-2 text-xs leading-snug font-medium', muted && 'line-through')}>{step.title}</span>
        <span className="mt-auto flex items-center justify-between gap-1 pt-1.5 text-[11px]">
          <span className="truncate text-muted-foreground tabular-nums" title={step.at ? dateTimeLabel(step.at) : undefined}>
            {when}
          </span>
          <span className={cn('flex shrink-0 items-center gap-0.5 font-medium', status.tone)}>
            <status.Icon className="size-3" aria-hidden />
            {status.label}
          </span>
        </span>
      </OpenEmailTarget>
    </li>
  );
}

function PlannedStepCard({ title, type, index }: { title: string; type: RoundType; index: number }) {
  const round = ROUND_META[type];
  return (
    <li className="w-44 shrink-0 snap-start rounded-lg border border-dashed p-2" title="Mentioned as a later step in the emails">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        <span className="tabular-nums">Step {index + 1}</span>
        <span aria-hidden className={cn('size-1.5 rounded-full opacity-60', round.dot)} />
        <span className="truncate">{round.label}</span>
      </span>
      <span className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">{title}</span>
      <span className="mt-1.5 block text-[11px] text-muted-foreground/80">Coming up</span>
    </li>
  );
}

function InterviewLaneRow({ lane, now, onOpen }: { lane: InterviewLane; now: number; onOpen: () => void }) {
  const { process, steps, next } = lane;
  const planned = plannedSteps(process, steps);
  const label = processLabel(process);
  const done = steps.filter((s) => s.status === 'completed').length;
  return (
    <div className="group/lane rounded-xl border bg-card/95 shadow-xs transition-colors hover:border-brand/25">
      <div className="flex items-center gap-1 p-2 pb-0">
        <OpenEmailTarget
          href={process.email_url}
          label={label}
          onDetails={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CompanyAvatar name={process.company} className="size-8 text-xs" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{process.company}</span>
            <span className="block truncate text-xs text-muted-foreground">{process.role_title || 'Role not specified'}</span>
          </span>
          {process.needs_action ? <AlertCircle className="size-4 shrink-0 text-amber-500" aria-label="Needs your action" /> : null}
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {steps.length ? `${done} of ${steps.length + planned.length} done` : 'No rounds yet'}
          </span>
        </OpenEmailTarget>
        <DetailsButton label={label} onClick={onOpen} />
      </div>
      {steps.length || planned.length ? (
        <ol
          aria-label={`${process.company} interview steps`}
          className="scrollbar-thin flex snap-x gap-2 overflow-x-auto p-2.5 pt-2"
        >
          {steps.map((step, i) => (
            <StepCard
              key={step.key}
              step={step}
              index={i}
              process={process}
              isNext={next?.key === step.key}
              now={now}
              onOpen={onOpen}
            />
          ))}
          {planned.map((p, i) => (
            <PlannedStepCard key={`planned-${i}`} title={p.title} type={p.type} index={steps.length + i} />
          ))}
        </ol>
      ) : (
        <p className="px-3.5 pt-1 pb-3 text-xs text-muted-foreground">{process.next_step || 'Rounds appear here as invites arrive.'}</p>
      )}
    </div>
  );
}

function InterviewingColumn({
  processes,
  now,
  onOpen,
  className,
}: {
  processes: InterviewProcess[];
  now: number;
  onOpen: (id: string) => void;
  className?: string;
}) {
  const groups = interviewLanes(processes, now);
  const types = new Map<RoundType, number>();
  for (const g of groups) for (const lane of g.lanes) for (const s of lane.steps) types.set(s.type, (types.get(s.type) ?? 0) + 1);
  return (
    <section
      aria-label="Interviewing column"
      className={cn('flex min-w-0 flex-col rounded-2xl border border-violet-500/20 bg-violet-500/[0.03] p-2.5', className)}
    >
      <header className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <span aria-hidden className={cn('size-2 rounded-full', STAGE_META.interviewing.dot)} />
          Interviewing
        </span>
        <span className="rounded-full bg-background px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
          {processes.length}
        </span>
        {types.size ? (
          <ul aria-label="Rounds by type" className="ml-auto flex flex-wrap gap-1">
            {[...types.entries()].map(([type, count]) => (
              <li key={type} className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums', ROUND_META[type].tone)}>
                {ROUND_META[type].label} {count}
              </li>
            ))}
          </ul>
        ) : null}
      </header>
      {groups.length ? (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <section key={group.id} aria-label={group.label} className="space-y-2">
              <h3 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                <span
                  aria-hidden
                  className={cn('size-1.5 rounded-full', group.id === 'waiting' ? 'bg-muted-foreground/40' : ROUND_META[group.id].dot)}
                />
                {group.label}
                <span className="font-normal tabular-nums">· {group.lanes.length}</span>
              </h3>
              {group.lanes.map((lane) => (
                <InterviewLaneRow key={lane.process.id} lane={lane} now={now} onOpen={() => onOpen(lane.process.id)} />
              ))}
            </section>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed px-2 py-6 text-center text-[11px] text-muted-foreground">Nothing here</p>
      )}
    </section>
  );
}

export function InterviewBoard({
  processes,
  onOpen,
  now = Date.now(),
}: {
  processes: InterviewProcess[];
  onOpen: (id: string) => void;
  now?: number;
}) {
  const { columns, closed } = buildBoard(processes, now);
  const [showClosed, setShowClosed] = useState(false);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.6fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        {columns.map((col) => {
          if (col.id === 'interviewing') {
            return (
              <InterviewingColumn
                key={col.id}
                processes={col.processes}
                now={now}
                onOpen={onOpen}
                className="order-last sm:col-span-2 lg:col-span-4 2xl:order-none 2xl:col-span-1"
              />
            );
          }
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
