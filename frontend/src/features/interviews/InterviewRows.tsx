import { Clock, MapPin, Video } from 'lucide-react';
import { CompanyAvatar, DetailsButton, IgnoreButton, OpenEmailTarget, StageChip, type IgnoreHandler } from './InterviewBoard';
import { dateTimeLabel, dayLabel, eventTitle, relativeAgo, timeLabel, type UpcomingItem } from './interviewsModel';

export function UpcomingRow({ item, onOpen }: { item: UpcomingItem; onOpen: (id: string) => void }) {
  const { event, process } = item;
  const at = event.scheduled_at!;
  const label = `${process.company}, ${eventTitle(event)}`;
  return (
    <li className="flex items-center gap-1 rounded-xl pr-1 transition-colors hover:bg-muted/50">
      <OpenEmailTarget
        href={event.email_url ?? process.email_url}
        label={label}
        onDetails={() => onOpen(process.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-brand/10 py-1 text-brand">
          <span className="text-[10px] font-semibold uppercase">{dayLabel(at)}</span>
          <span className="text-xs font-semibold tabular-nums">{timeLabel(at)}</span>
        </span>
        <CompanyAvatar name={process.company} className="size-8 text-xs" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {process.company} · {eventTitle(event)}
          </span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            {event.meeting_url ? <Video className="size-3 shrink-0" aria-hidden /> : null}
            {!event.meeting_url && event.location ? <MapPin className="size-3 shrink-0" aria-hidden /> : null}
            <span className="truncate">
              {[process.role_title, event.location, event.duration_minutes ? `${event.duration_minutes} min` : null]
                .filter(Boolean)
                .join(' · ') || 'Details in the email'}
            </span>
          </span>
        </span>
        <StageChip stage={process.stage} />
      </OpenEmailTarget>
      <DetailsButton label={label} onClick={() => onOpen(process.id)} />
    </li>
  );
}

export function ActionRow({
  item,
  hint,
  now,
  onOpen,
  onIgnore,
}: {
  item: UpcomingItem;
  hint: string;
  now: number;
  onOpen: (id: string) => void;
  onIgnore?: IgnoreHandler;
}) {
  const { event, process } = item;
  const ago = relativeAgo(event.email_date, now);
  const label = `${process.company}, ${eventTitle(event)}`;
  return (
    <li className="flex items-center gap-1 rounded-xl pr-1 transition-colors hover:bg-muted/50">
      <OpenEmailTarget
        href={event.email_url ?? process.email_url}
        label={label}
        onDetails={() => onOpen(process.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {process.company} · {eventTitle(event)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{event.summary || process.next_step || hint}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            {hint}
          </span>
          {ago ? (
            <span
              className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
              title={event.email_date ? `Email received ${dateTimeLabel(event.email_date)}` : undefined}
            >
              <Clock className="size-3" aria-hidden />
              {ago}
            </span>
          ) : null}
        </span>
      </OpenEmailTarget>
      {onIgnore ? <IgnoreButton label={label} onClick={() => onIgnore([event.id], label)} /> : null}
      <DetailsButton label={label} onClick={() => onOpen(process.id)} />
    </li>
  );
}
