import type {
  InterviewEvent,
  InterviewEventKind,
  InterviewEventStatus,
  InterviewProcess,
  InterviewStage,
} from '@/types/interviews';

export const PIPELINE_STAGES: InterviewStage[] = ['applied', 'screening', 'assessment', 'interviewing', 'final', 'offer'];

export const STAGE_META: Record<InterviewStage, { label: string; dot: string; tone: string }> = {
  applied: { label: 'Applied', dot: 'bg-muted-foreground/60', tone: 'bg-muted text-muted-foreground' },
  screening: { label: 'Screening', dot: 'bg-sky-500', tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  assessment: { label: 'Assessment', dot: 'bg-amber-500', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  interviewing: { label: 'Interviewing', dot: 'bg-violet-500', tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  final: { label: 'Final round', dot: 'bg-fuchsia-500', tone: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300' },
  offer: { label: 'Offer', dot: 'bg-emerald-500', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  rejected: { label: 'Rejected', dot: 'bg-rose-500', tone: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  withdrawn: { label: 'Withdrawn', dot: 'bg-muted-foreground/40', tone: 'bg-muted text-muted-foreground' },
};

export const ALL_STAGES = Object.keys(STAGE_META) as InterviewStage[];

export const KIND_LABEL: Record<InterviewEventKind, string> = {
  recruiter_screen: 'Recruiter screen',
  assessment: 'Assessment',
  technical: 'Technical interview',
  behavioral: 'Behavioral interview',
  hiring_manager: 'Hiring manager',
  onsite: 'Onsite',
  final: 'Final interview',
  offer: 'Offer',
  rejection: 'Rejection',
  scheduling: 'Scheduling',
  application_received: 'Application received',
  other: 'Update',
};

export const EVENT_KINDS = Object.keys(KIND_LABEL) as InterviewEventKind[];

export const EVENT_STATUS_META: Record<InterviewEventStatus, { label: string; tone: string }> = {
  scheduled: { label: 'Scheduled', tone: 'bg-brand/10 text-brand' },
  needs_scheduling: { label: 'Pick a time', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  action_required: { label: 'Action needed', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  completed: { label: 'Done', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  cancelled: { label: 'Cancelled', tone: 'bg-muted text-muted-foreground line-through' },
  info: { label: 'Update', tone: 'bg-muted text-muted-foreground' },
};

export type BoardColumn = { id: string; label: string; stages: InterviewStage[]; processes: InterviewProcess[] };

const COLUMNS: Omit<BoardColumn, 'processes'>[] = [
  { id: 'screening', label: 'Screening', stages: ['applied', 'screening'] },
  { id: 'assessment', label: 'Assessment', stages: ['assessment'] },
  { id: 'interviewing', label: 'Interviewing', stages: ['interviewing'] },
  { id: 'final', label: 'Final round', stages: ['final'] },
  { id: 'offer', label: 'Offer', stages: ['offer'] },
];

/** Active processes grouped into board columns; closed ones are returned separately. */
export function buildBoard(processes: InterviewProcess[]): { columns: BoardColumn[]; closed: InterviewProcess[] } {
  const active = processes.filter((p) => p.status === 'active' && !['rejected', 'withdrawn'].includes(p.stage));
  return {
    columns: COLUMNS.map((c) => ({ ...c, processes: active.filter((p) => c.stages.includes(p.stage)) })),
    closed: processes.filter((p) => !active.includes(p)),
  };
}

export type UpcomingItem = { event: InterviewEvent; process: InterviewProcess };

export function upcomingInterviews(processes: InterviewProcess[], now = new Date()): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const process of processes) {
    if (process.status !== 'active') continue;
    for (const event of process.events) {
      if (event.status === 'scheduled' && event.scheduled_at && new Date(event.scheduled_at) >= now) {
        items.push({ event, process });
      }
    }
  }
  return items.sort((a, b) => Date.parse(a.event.scheduled_at!) - Date.parse(b.event.scheduled_at!));
}

/** Rounds that already happened but are still marked scheduled: the user should log the outcome. */
export function awaitingOutcome(processes: InterviewProcess[], now = new Date()): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const process of processes) {
    if (process.status !== 'active') continue;
    for (const event of process.events) {
      if (event.status === 'scheduled' && event.scheduled_at && new Date(event.scheduled_at) < now) {
        items.push({ event, process });
      }
    }
  }
  return items.sort((a, b) => Date.parse(b.event.scheduled_at!) - Date.parse(a.event.scheduled_at!));
}

export function actionItems(processes: InterviewProcess[]): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const process of processes) {
    if (process.status !== 'active') continue;
    for (const event of process.events) {
      if (event.status === 'needs_scheduling' || event.status === 'action_required') items.push({ event, process });
    }
  }
  return items.sort((a, b) => Date.parse(b.event.email_date ?? '') - Date.parse(a.event.email_date ?? ''));
}

/** Index of the process in the six pipeline stages, or -1 when closed. */
export function stageIndex(stage: InterviewStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

export function eventTitle(event: InterviewEvent): string {
  return event.title || KIND_LABEL[event.kind];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function dayLabel(iso: string, now = new Date()): string {
  const days = Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return `In ${days} days`;
  if (days < -1 && days > -7) return `${-days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function relativeAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return null;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `<input type="datetime-local">` value for an ISO time, in the browser's zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const SELECT_CLASS =
  'h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const MAIL_ERRORS: Record<string, string> = {
  access_denied: 'Email access was not granted.',
  invalid_state: 'The sign-in link expired. Try connecting again.',
  not_configured: 'Email connection is not available on this server yet.',
  network: 'Could not reach the mail service. Try again shortly.',
};

/** Toast text for the `reason` the mail callback appends; provider descriptions pass through. */
export function mailErrorMessage(reason: string | null): string {
  if (reason && MAIL_ERRORS[reason]) return MAIL_ERRORS[reason];
  if (reason && reason.includes(' ')) return reason;
  return 'Could not connect your email. Try again.';
}

/** Sync again when the last one is older than this. */
export const AUTO_SYNC_AFTER_MS = 30 * 60_000;

export function shouldAutoSync(lastSyncedAt: string | null | undefined, now = Date.now()): boolean {
  return !lastSyncedAt || now - Date.parse(lastSyncedAt) > AUTO_SYNC_AFTER_MS;
}
