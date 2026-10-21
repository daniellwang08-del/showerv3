import type {
  InterviewEvent,
  InterviewEventKind,
  InterviewEventStatus,
  InterviewProcess,
  InterviewStage,
  SyncStats,
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

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** Column order: soonest upcoming round first, then the most recent activity. */
export function compareByDate(a: InterviewProcess, b: InterviewProcess, now = Date.now()): number {
  const upcoming = (p: InterviewProcess) => {
    const t = time(p.next_event?.scheduled_at);
    return t !== null && t >= now ? t : null;
  };
  const ua = upcoming(a);
  const ub = upcoming(b);
  if (ua !== null || ub !== null) {
    if (ua === null) return 1;
    if (ub === null) return -1;
    return ua - ub;
  }
  return (time(b.last_activity_at) ?? 0) - (time(a.last_activity_at) ?? 0);
}

/** Active processes grouped into board columns; closed ones are returned separately. */
export function buildBoard(
  processes: InterviewProcess[],
  now = Date.now(),
): { columns: BoardColumn[]; closed: InterviewProcess[] } {
  const active = processes.filter((p) => p.status === 'active' && !['rejected', 'withdrawn'].includes(p.stage));
  const byDate = (a: InterviewProcess, b: InterviewProcess) => compareByDate(a, b, now);
  return {
    columns: COLUMNS.map((c) => ({ ...c, processes: active.filter((p) => c.stages.includes(p.stage)).sort(byDate) })),
    closed: processes
      .filter((p) => !active.includes(p))
      .sort((a, b) => (time(b.last_activity_at) ?? 0) - (time(a.last_activity_at) ?? 0)),
  };
}

/** Events newest first by their date: the interview time, else when the email arrived. */
export function eventsByDate(events: InterviewEvent[]): InterviewEvent[] {
  const key = (e: InterviewEvent) => time(e.scheduled_at) ?? time(e.email_date) ?? 0;
  return [...events].sort((a, b) => key(b) - key(a) || (time(b.email_date) ?? 0) - (time(a.email_date) ?? 0));
}

// ── interview rounds ────────────────────────────────────────────────────────

export type RoundType = 'screen' | 'assessment' | 'coding' | 'design' | 'culture' | 'manager' | 'onsite' | 'other';

export const ROUND_META: Record<RoundType, { label: string; dot: string; tone: string }> = {
  screen: { label: 'Screen', dot: 'bg-sky-500', tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  assessment: { label: 'Assessment', dot: 'bg-amber-500', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  coding: { label: 'Coding', dot: 'bg-violet-500', tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  design: { label: 'System design', dot: 'bg-indigo-500', tone: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' },
  culture: { label: 'Culture fit', dot: 'bg-teal-500', tone: 'bg-teal-500/10 text-teal-700 dark:text-teal-300' },
  manager: { label: 'Hiring manager', dot: 'bg-orange-500', tone: 'bg-orange-500/10 text-orange-700 dark:text-orange-300' },
  onsite: { label: 'Onsite / panel', dot: 'bg-fuchsia-500', tone: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300' },
  other: { label: 'Interview', dot: 'bg-muted-foreground/60', tone: 'bg-muted text-muted-foreground' },
};

/** Which kind of round an event is, from its kind and wording. */
export function roundType(event: Pick<InterviewEvent, 'kind' | 'title' | 'summary'>): RoundType {
  const text = `${event.title ?? ''} ${event.summary ?? ''}`.toLowerCase();
  if (event.kind === 'recruiter_screen') return 'screen';
  if (event.kind === 'assessment') return 'assessment';
  if (event.kind === 'hiring_manager' || /hiring manager|manager (interview|round|chat|call)/.test(text)) return 'manager';
  if (/\bdesign\b|architect|whiteboard/.test(text)) return 'design';
  if (event.kind === 'behavioral' || /culture|values|behavio|team fit|bar raiser/.test(text)) return 'culture';
  if (event.kind === 'technical' || /\bcod(e|ing)\b|technical|programming|algorithm|leetcode|pair/.test(text)) return 'coding';
  if (event.kind === 'onsite' || event.kind === 'final' || /on-?site|\bloop\b|final|panel|superday/.test(text)) return 'onsite';
  if (/screen|recruiter|intro call|phone call/.test(text)) return 'screen';
  return 'other';
}

const OPEN_REQUEST = new Set<InterviewEventStatus>(['needs_scheduling', 'action_required']);

/** A request (pick a time, do an assessment, ...) the user has not dismissed. */
export function needsUser(event: Pick<InterviewEvent, 'status' | 'ignored'>): boolean {
  return OPEN_REQUEST.has(event.status) && !event.ignored;
}

/** Open requests on a process that the user has not dismissed. */
export function openRequests(process: Pick<InterviewProcess, 'events'>): InterviewEvent[] {
  return process.events.filter(needsUser);
}

export type ProcessStep = {
  key: string;
  type: RoundType;
  title: string;
  /** Interview time, when one is set. */
  at: string | null;
  /** What the step is ordered by: its interview time, else when the email arrived. */
  date: string | null;
  status: InterviewEventStatus;
  /** Cancelled because a later round of the same type replaced it. */
  rescheduled: boolean;
  /** The newest email about this step. */
  event: InterviewEvent;
  /** Every event folded into this step. */
  eventIds: string[];
  /** The user dismissed it, so it asks for nothing. */
  ignored: boolean;
};

const NOT_A_STEP = new Set<InterviewEventKind>(['application_received', 'rejection', 'offer']);
const NOISE_WORDS = /\b(reminder|rescheduled?|cancell?ed|cancellation|confirm(ed|ation)?|updated?|invit(e|ation)|re|fwd?)\b/g;
const NOISY_TITLE = /reminder|cancel|reschedul/i;

function normTitle(title: string): string {
  return title.toLowerCase().replace(NOISE_WORDS, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const byEmail = (a: InterviewEvent, b: InterviewEvent) => (time(a.email_date) ?? 0) - (time(b.email_date) ?? 0);

/**
 * A process's interview rounds, oldest first. Reminders, confirmations and
 * reschedules of one round collapse into a single step; a request to pick a
 * time drops once that round is booked, and until then sits after the booked rounds.
 */
export function processSteps(process: Pick<InterviewProcess, 'events'>): ProcessStep[] {
  const groups = new Map<string, InterviewEvent[]>();
  for (const event of process.events) {
    if (NOT_A_STEP.has(event.kind) || event.status === 'info') continue;
    if (event.ignored && OPEN_REQUEST.has(event.status) && !event.scheduled_at) continue;
    const type = roundType(event);
    const at = time(event.scheduled_at);
    const key = at !== null ? `${type}@${at}` : `${type}#${normTitle(eventTitle(event))}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  let steps: ProcessStep[] = [...groups.entries()].map(([key, events]) => {
    const sorted = [...events].sort(byEmail);
    const latest = sorted[sorted.length - 1];
    let status = latest.status;
    if (status === 'scheduled' && sorted.some((e) => e.status === 'completed')) status = 'completed';
    const named = sorted.find((e) => !NOISY_TITLE.test(eventTitle(e))) ?? sorted[0];
    const at = latest.scheduled_at ?? sorted.find((e) => e.scheduled_at)?.scheduled_at ?? null;
    return {
      key,
      type: roundType(named),
      title: eventTitle(named),
      at,
      date: at ?? sorted[0].email_date,
      status,
      rescheduled: false,
      event: latest,
      eventIds: sorted.map((e) => e.id),
      ignored: sorted.every((e) => e.ignored),
    };
  });

  const emailTime = (s: ProcessStep) => time(s.event.email_date) ?? 0;
  steps = steps.filter(
    (s) =>
      !(s.status === 'needs_scheduling' && !s.at) ||
      !steps.some((o) => o !== s && o.type === s.type && o.at && emailTime(o) >= emailTime(s)),
  );
  for (const s of steps) {
    if (s.status !== 'cancelled') continue;
    const sAt = time(s.date) ?? 0;
    s.rescheduled = steps.some((o) => o.type === s.type && o.status !== 'cancelled' && (time(o.date) ?? 0) > sAt);
  }
  const open = (s: ProcessStep) => !s.at && (s.status === 'needs_scheduling' || s.status === 'action_required');
  return steps.sort((a, b) => {
    const ta = open(a) ? null : time(a.date);
    const tb = open(b) ? null : time(b.date);
    if (ta === null || tb === null) return ta === null ? (tb === null ? 0 : 1) : -1;
    return ta - tb || emailTime(a) - emailTime(b);
  });
}

/** Rounds the emails say are still to come, as `{ type, title }`; review and wait notes are left out. */
export function plannedSteps(
  process: Pick<InterviewProcess, 'remaining_steps'>,
  steps: ProcessStep[] = [],
): { type: RoundType; title: string }[] {
  const have = new Set(steps.map((s) => normTitle(s.title)));
  return (process.remaining_steps ?? [])
    .map((text) => String(text || '').trim())
    .filter((text) => text && /interview|round|call|screen|onsite|on-site|panel|chat|meet/i.test(text))
    .filter((text) => !/\b(review|wait|hear back|update|decision)\b/i.test(text) && !have.has(normTitle(text)))
    .map((text) => ({ type: roundType({ kind: 'other', title: text, summary: null }), title: text }));
}

/** The step the candidate is heading to: the next booked round, else an open request. */
export function upcomingStep(steps: ProcessStep[], now = Date.now()): ProcessStep | null {
  const booked = steps.find((s) => s.status === 'scheduled' && s.at && Date.parse(s.at) >= now);
  if (booked) return booked;
  return steps.find((s) => !s.ignored && OPEN_REQUEST.has(s.status)) ?? null;
}

export type InterviewLane = { process: InterviewProcess; steps: ProcessStep[]; next: ProcessStep | null };
export type LaneGroup = { id: RoundType | 'waiting'; label: string; lanes: InterviewLane[] };

/**
 * Interviewing processes as sub-lists keyed by the kind of round coming up
 * (coding, system design, culture fit, ...), soonest first. Processes with
 * nothing booked or requested wait for feedback at the end.
 */
export function interviewLanes(processes: InterviewProcess[], now = Date.now()): LaneGroup[] {
  const lanes = processes.map((process) => {
    const steps = processSteps(process);
    return { process, steps, next: upcomingStep(steps, now) };
  });
  const nextTime = (l: InterviewLane) => time(l.next?.at) ?? Number.MAX_SAFE_INTEGER;
  const groups = new Map<LaneGroup['id'], InterviewLane[]>();
  for (const lane of lanes) {
    const id = lane.next ? lane.next.type : 'waiting';
    groups.set(id, [...(groups.get(id) ?? []), lane]);
  }
  return [...groups.entries()]
    .map(([id, items]) => ({
      id,
      label: id === 'waiting' ? 'Waiting on feedback' : `Up next: ${ROUND_META[id].label}`,
      lanes: items.sort((a, b) => nextTime(a) - nextTime(b) || compareByDate(a.process, b.process, now)),
    }))
    .sort((a, b) => {
      if (a.id === 'waiting' || b.id === 'waiting') return a.id === 'waiting' ? 1 : -1;
      return nextTime(a.lanes[0]) - nextTime(b.lanes[0]);
    });
}

export type UpcomingItem = { event: InterviewEvent; process: InterviewProcess };

/** One item per process and time: an invite and its confirmations are one booking. */
function bookings(processes: InterviewProcess[], keep: (event: InterviewEvent) => boolean): UpcomingItem[] {
  const items = new Map<string, UpcomingItem>();
  for (const process of processes) {
    if (process.status !== 'active') continue;
    for (const event of process.events) {
      if (event.status !== 'scheduled' || !event.scheduled_at || !keep(event)) continue;
      const key = `${process.id}@${Date.parse(event.scheduled_at)}`;
      const seen = items.get(key);
      if (!seen || (!seen.event.meeting_url && event.meeting_url)) items.set(key, { event, process });
    }
  }
  return [...items.values()];
}

export function upcomingInterviews(processes: InterviewProcess[], now = new Date()): UpcomingItem[] {
  return bookings(processes, (e) => new Date(e.scheduled_at!) >= now).sort(
    (a, b) => Date.parse(a.event.scheduled_at!) - Date.parse(b.event.scheduled_at!),
  );
}

/** Rounds that already happened but are still marked scheduled: the user should log the outcome. */
export function awaitingOutcome(processes: InterviewProcess[], now = new Date()): UpcomingItem[] {
  return bookings(processes, (e) => !e.ignored && new Date(e.scheduled_at!) < now).sort(
    (a, b) => Date.parse(b.event.scheduled_at!) - Date.parse(a.event.scheduled_at!),
  );
}

export function actionItems(processes: InterviewProcess[]): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const process of processes) {
    if (process.status !== 'active') continue;
    for (const event of process.events) {
      if (needsUser(event)) items.push({ event, process });
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

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function syncDoneMessage(stats: SyncStats | null | undefined): string {
  const parts: string[] = [];
  if (stats?.applications) parts.push(plural(stats.applications, 'new application'));
  if (stats?.created) parts.push(plural(stats.created, 'new process', 'new processes'));
  if (stats?.updated) parts.push(plural(stats.updated, 'updated process', 'updated processes'));
  if (stats?.jobs_marked) parts.push(`${plural(stats.jobs_marked, 'job')} marked applied`);
  return parts.length ? `Sync done: ${parts.join(', ')}` : 'Sync done. No new hiring emails.';
}