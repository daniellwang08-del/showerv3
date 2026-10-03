import type { SystemLogQuery } from '@/types/systemLogs';

export const LEVELS = ['debug', 'info', 'warning', 'error', 'critical'] as const;
export const CATEGORIES = ['http', 'worker', 'process', 'system'] as const;
export const SERVICES = [
  'api',
  'extraction',
  'analysis',
  'tailoring',
  'save',
  'resume',
  'autopost',
  'scraper',
  'encoding',
] as const;
export const HOUR_WINDOWS = [1, 6, 24, 72, 168] as const;
export const PER_PAGE_OPTIONS = [20, 50, 100] as const;
export const MATCH_TIMING_EVENT = 'job_match_analysis_timing';

export const DEFAULT_HOURS = 24;
export const DEFAULT_PER_PAGE = 50;

export interface LogFilters {
  hours: number;
  level: string;
  category: string;
  service: string;
  path: string;
  event: string;
  request: string;
  job: string;
  user: string;
  page: number;
  perPage: number;
}

/** Free-text filters: edited as drafts and committed on Enter / Apply. */
export const TEXT_KEYS = ['path', 'event', 'request', 'job', 'user'] as const;
export type TextKey = (typeof TEXT_KEYS)[number];
export type TextDrafts = Record<TextKey, string>;

const URL_KEYS: Record<keyof LogFilters, string> = {
  hours: 'hours',
  level: 'level',
  category: 'category',
  service: 'service',
  path: 'path',
  event: 'event',
  request: 'request',
  job: 'job',
  user: 'user',
  page: 'page',
  perPage: 'per',
};

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readFilters(params: URLSearchParams): LogFilters {
  const str = (k: keyof LogFilters) => params.get(URL_KEYS[k])?.trim() ?? '';
  return {
    hours: positiveInt(params.get('hours'), DEFAULT_HOURS),
    level: str('level'),
    category: str('category'),
    service: str('service'),
    path: str('path'),
    event: str('event'),
    request: str('request'),
    job: str('job'),
    user: str('user'),
    page: positiveInt(params.get('page'), 1),
    perPage: positiveInt(params.get('per'), DEFAULT_PER_PAGE),
  };
}

/** Writes filters back to the URL, omitting defaults so shared links stay short. */
export function writeFilters(filters: LogFilters): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of Object.keys(URL_KEYS) as Array<keyof LogFilters>) {
    const value = filters[key];
    if (key === 'hours' && value === DEFAULT_HOURS) continue;
    if (key === 'page' && value === 1) continue;
    if (key === 'perPage' && value === DEFAULT_PER_PAGE) continue;
    if (value === '' || value == null) continue;
    out.set(URL_KEYS[key], String(value));
  }
  return out;
}

export function toQuery(f: LogFilters): SystemLogQuery {
  return {
    page: f.page,
    per_page: f.perPage,
    hours: f.hours,
    level: f.level || undefined,
    category: f.category || undefined,
    service: f.service || undefined,
    path_contains: f.path || undefined,
    event_contains: f.event || undefined,
    request_id: f.request || undefined,
    job_id: f.job || undefined,
    user_id: f.user || undefined,
  };
}

export function draftsOf(f: LogFilters): TextDrafts {
  return { path: f.path, event: f.event, request: f.request, job: f.job, user: f.user };
}

export function hasActiveFilters(f: LogFilters): boolean {
  return Boolean(f.level || f.category || f.service || TEXT_KEYS.some((k) => f[k]));
}

export function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof msg === 'string' && msg ? msg : fallback;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function httpLine(ev: { method?: string | null; path?: string | null; status_code?: number | null }): string {
  return [ev.method, ev.path, ev.status_code != null ? `→ ${ev.status_code}` : ''].filter(Boolean).join(' ');
}
