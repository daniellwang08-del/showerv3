import type { WeeklyProgress } from '@/api/scraperApi';
import type { ReportApplication, ReportShare } from '@/types/reportShare';
import { relativeAgo } from '../interviews/interviewsModel';

export const REPORT_SHARES_KEY = ['report-shares'] as const;
export const INCOMING_SHARES_KEY = ['report-shares', 'incoming'] as const;

export const EXPIRY_OPTIONS: { value: number | null; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: null, label: 'No end date' },
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Splits pasted text ("a@x.com, Sam <b@y.org>; c@z") into unique valid emails and the leftovers. */
export function parseEmails(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const part = raw.replace(/^[<("']+|[>)"']+$/g, '').trim().toLowerCase();
    if (!part) continue;
    if (isEmail(part)) {
      if (!valid.includes(part)) valid.push(part);
    } else if (part.includes('@')) {
      invalid.push(part);
    }
  }
  return { valid, invalid };
}

export function shareUrl(token: string, origin = window.location.origin): string {
  return `${origin}/shared/${token}`;
}

export function mailtoLink({
  email,
  url,
  ownerName,
  message,
}: {
  email: string;
  url: string;
  ownerName?: string | null;
  message?: string | null;
}): string {
  const who = ownerName?.trim() || 'I';
  const subject = ownerName?.trim() ? `${ownerName.trim()} shared their job search report` : 'My job search report';
  const lines = [
    message?.trim() || `Hi, ${who === 'I' ? 'I am' : `${who} is`} sharing a live, read-only view of the job search with you.`,
    '',
    'It shows interview processes, upcoming interviews, what needs attention, and every application with its current status.',
    '',
    url,
  ];
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : DATE_FMT.format(d);
}

export function accessLabel(share: Pick<ReportShare, 'expires_at' | 'active'>): string {
  if (!share.active) return 'Expired';
  return share.expires_at ? `Until ${shortDate(share.expires_at)}` : 'No end date';
}

export function viewLabel(share: Pick<ReportShare, 'last_viewed_at' | 'view_count'>, now = Date.now()): string {
  if (!share.last_viewed_at || !share.view_count) return 'Not opened yet';
  const views = share.view_count === 1 ? '1 view' : `${share.view_count} views`;
  return `Opened ${relativeAgo(share.last_viewed_at, now) ?? shortDate(share.last_viewed_at)} · ${views}`;
}

export function initials(value: string): string {
  const name = value.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** The last `days` of a 30-day activity series, with fresh totals. */
export function activityWindow(progress: WeeklyProgress, days: number): WeeklyProgress {
  const series = progress.series.slice(-days);
  const sum = (k: 'posted' | 'recommended' | 'applied') => series.reduce((s, d) => s + (d[k] || 0), 0);
  return {
    ...progress,
    days,
    series,
    totals: { posted: sum('posted'), recommended: sum('recommended'), applied: sum('applied') },
  };
}

export type ApplicationFilter = 'all' | 'active' | 'waiting' | 'closed';

export const APPLICATION_FILTERS: { id: ApplicationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Interviewing' },
  { id: 'waiting', label: 'No reply yet' },
  { id: 'closed', label: 'Closed' },
];

export function applicationBucket(app: ReportApplication): Exclude<ApplicationFilter, 'all'> {
  if (app.process_active) return 'active';
  if (app.process_id) return 'closed';
  return 'waiting';
}

export function applicationCounts(items: ReportApplication[], now = Date.now()) {
  const weekAgo = now - 7 * 86_400_000;
  const counts = { all: items.length, active: 0, waiting: 0, closed: 0, week: 0 };
  for (const app of items) {
    counts[applicationBucket(app)] += 1;
    if (app.applied_at && Date.parse(app.applied_at) >= weekAgo) counts.week += 1;
  }
  return counts;
}

export function filterApplications(items: ReportApplication[], filter: ApplicationFilter, query: string): ReportApplication[] {
  const q = query.trim().toLowerCase();
  return items.filter((app) => {
    if (filter !== 'all' && applicationBucket(app) !== filter) return false;
    if (!q) return true;
    return [app.company, app.title, app.location].some((v) => v?.toLowerCase().includes(q));
  });
}
