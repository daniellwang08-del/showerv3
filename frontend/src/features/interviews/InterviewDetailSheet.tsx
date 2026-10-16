import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  MapPin,
  Plus,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  addInterviewEvent,
  deleteInterview,
  deleteInterviewEvent,
  updateInterview,
  updateInterviewEvent,
} from '@/api/interviewsApi';
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
import { Input } from '@/components/ui/input';
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import type {
  EventInput,
  InterviewEvent,
  InterviewEventKind,
  InterviewProcess,
  InterviewStage,
  ProcessChanges,
} from '@/types/interviews';
import { CompanyAvatar } from './InterviewBoard';
import {
  ALL_STAGES,
  dateTimeLabel,
  EVENT_KINDS,
  EVENT_STATUS_META,
  eventTitle,
  fromLocalInput,
  KIND_LABEL,
  PIPELINE_STAGES,
  SELECT_CLASS,
  STAGE_META,
  stageIndex,
} from './interviewsModel';
import { INTERVIEWS_KEY } from './queries';

function useInterviewMutation<T>(fn: (arg: T) => Promise<unknown>, success?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INTERVIEWS_KEY });
      if (success) toast.success(success);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Something went wrong. Try again.')),
  });
}

export function InterviewDetailSheet({ process, onDeleted }: { process: InterviewProcess; onDeleted: () => void }) {
  const update = useInterviewMutation((changes: ProcessChanges) => updateInterview(process.id, changes));
  const remove = useInterviewMutation(() => deleteInterview(process.id), 'Process deleted');
  const [nextStep, setNextStep] = useState(process.next_step ?? '');
  const [notes, setNotes] = useState(process.notes ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closed = process.status === 'closed';
  const index = stageIndex(process.stage);

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b px-5 py-4">
        <div className="flex items-start gap-3 pr-8">
          <CompanyAvatar name={process.company} className="size-11 text-base" />
          <div className="min-w-0">
            <SheetTitle className="truncate text-lg">{process.company}</SheetTitle>
            <SheetDescription className="truncate">{process.role_title || 'Role not specified'}</SheetDescription>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="interview-stage">
            Stage
          </label>
          <select
            id="interview-stage"
            className={SELECT_CLASS}
            value={process.stage}
            onChange={(e) => update.mutate({ stage: e.target.value as InterviewStage })}
          >
            {ALL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_META[s].label}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => update.mutate({ status: closed ? 'active' : 'closed' })}
            disabled={update.isPending}
          >
            {closed ? 'Reopen' : 'Close process'}
          </Button>
          {process.job?.url ? (
            <a
              href={process.job.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              Job posting
            </a>
          ) : null}
        </div>
      </SheetHeader>

      <div className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <section aria-label="Progress">
          <ol className="grid grid-cols-6 gap-1">
            {PIPELINE_STAGES.map((s, i) => {
              const done = index >= 0 && i < index;
              const current = i === index;
              return (
                <li key={s} className="min-w-0 text-center">
                  <span
                    className={cn(
                      'mx-auto flex size-6 items-center justify-center rounded-full border text-[10px] font-semibold',
                      done && 'border-transparent bg-brand text-white',
                      current && 'border-brand bg-brand/10 text-brand ring-3 ring-brand/15',
                      !done && !current && 'text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      'mt-1 block truncate text-[10px]',
                      current ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {STAGE_META[s].label}
                  </span>
                </li>
              );
            })}
          </ol>
          {index < 0 ? (
            <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs font-medium', STAGE_META[process.stage].tone)}>
              This process is {STAGE_META[process.stage].label.toLowerCase()}.
            </p>
          ) : null}
        </section>

        <Block title="Next step">
          <div className="flex gap-2">
            <Input
              aria-label="Next step"
              value={nextStep}
              placeholder="e.g. Send availability for the onsite"
              onChange={(e) => setNextStep(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={nextStep === (process.next_step ?? '') || update.isPending}
              onClick={() => update.mutate({ next_step: nextStep })}
            >
              Save
            </Button>
          </div>
          {process.remaining_steps.length ? (
            <div className="mt-3">
              <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Remaining steps</p>
              <ol className="mt-1.5 flex flex-wrap gap-1.5">
                {process.remaining_steps.map((step, i) => (
                  <li key={`${step}-${i}`} className="rounded-full border bg-background/60 px-2.5 py-1 text-xs">
                    {i + 1}. {step}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </Block>

        <Block title="Timeline">
          {process.events.length ? (
            <ol className="relative space-y-4 border-l border-border/70 pl-5">
              {[...process.events].reverse().map((event) => (
                <TimelineItem key={event.id} event={event} />
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No steps yet.</p>
          )}
          <AddStepForm processId={process.id} />
        </Block>

        <Block title="Notes">
          <Textarea
            aria-label="Notes"
            value={notes}
            rows={4}
            placeholder="Prep notes, people you met, salary range..."
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={notes === (process.notes ?? '') || update.isPending}
              onClick={() => update.mutate({ notes }, { onSuccess: () => toast.success('Notes saved') })}
            >
              Save notes
            </Button>
          </div>
        </Block>
      </div>

      <div className="flex items-center justify-between border-t px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {process.source === 'manual' ? 'Added by you' : 'Built from your email'}
        </span>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}>
          <Trash2 />
          Delete process
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {process.company}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the process and its timeline. Emails already read are not added back on the next sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => remove.mutate(undefined, { onSuccess: onDeleted })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function TimelineItem({ event }: { event: InterviewEvent }) {
  const update = useInterviewMutation((status: InterviewEvent['status']) => updateInterviewEvent(event.id, { status }));
  const remove = useInterviewMutation(() => deleteInterviewEvent(event.id));
  const meta = EVENT_STATUS_META[event.status];
  const open = event.status === 'scheduled' || event.status === 'needs_scheduling' || event.status === 'action_required';
  const when = event.scheduled_at ?? event.email_date;

  return (
    <li className="relative">
      <span
        aria-hidden
        className={cn(
          'absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-card',
          event.status === 'scheduled' ? 'bg-brand' : open ? 'bg-amber-500' : 'bg-muted-foreground/40',
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{eventTitle(event)}</p>
        <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', meta.tone)}>{meta.label}</span>
      </div>
      {when ? (
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {event.scheduled_at ? dateTimeLabel(event.scheduled_at) : `Email ${dateTimeLabel(when)}`}
          {event.duration_minutes ? ` · ${event.duration_minutes} min` : ''}
        </p>
      ) : null}
      {event.summary ? <p className="mt-1 text-sm text-muted-foreground">{event.summary}</p> : null}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {event.meeting_url ? (
          <a href={event.meeting_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            <Video className="size-3.5" aria-hidden />
            Join link
          </a>
        ) : null}
        {event.location ? (
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3.5" aria-hidden />
            {event.location}
          </span>
        ) : null}
        {event.interviewers ? (
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" aria-hidden />
            {event.interviewers}
          </span>
        ) : null}
        {event.email_subject ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={event.email_from ?? undefined}>
            <Mail className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{event.email_subject}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {open ? (
          <Button size="xs" variant="outline" onClick={() => update.mutate('completed')} disabled={update.isPending}>
            <Check />
            Mark done
          </Button>
        ) : null}
        {event.status === 'scheduled' ? (
          <Button size="xs" variant="ghost" onClick={() => update.mutate('cancelled')} disabled={update.isPending}>
            <X />
            Cancelled
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={`Remove ${eventTitle(event)}`}
          onClick={() => remove.mutate(undefined)}
          disabled={remove.isPending}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

function AddStepForm({ processId }: { processId: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<InterviewEventKind>('technical');
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [duration, setDuration] = useState('');
  const [link, setLink] = useState('');
  const add = useInterviewMutation((body: EventInput) => addInterviewEvent(processId, body), 'Step added');

  const reset = () => {
    setTitle('');
    setWhen('');
    setDuration('');
    setLink('');
    setOpen(false);
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="mt-4" onClick={() => setOpen(true)}>
        <Plus />
        Add step
      </Button>
    );
  }

  return (
    <form
      aria-label="Add step"
      className="mt-4 space-y-2.5 rounded-xl border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          {
            kind,
            title: title.trim() || null,
            scheduled_at: fromLocalInput(when),
            duration_minutes: duration ? Number(duration) : null,
            meeting_url: link.trim() || null,
          },
          { onSuccess: reset },
        );
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs font-medium">
          Type
          <select className={cn(SELECT_CLASS, 'w-full')} value={kind} onChange={(e) => setKind(e.target.value as InterviewEventKind)}>
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">
          When
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
      </div>
      <Input aria-label="Step title" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
        <Input
          aria-label="Duration in minutes"
          type="number"
          min={5}
          max={600}
          placeholder="Minutes"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
        <div className="relative">
          <Link2 className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Meeting link"
            type="url"
            placeholder="Meeting link"
            className="pl-8"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={add.isPending}>
          {add.isPending ? <Loader2 className="animate-spin" /> : null}
          Add step
        </Button>
      </div>
    </form>
  );
}
