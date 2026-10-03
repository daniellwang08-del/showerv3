import type { DashboardView } from '@/api/scraperApi';
import type { AdminScraperStats, DashboardJob, ScrapeRun, SpiderInfo } from '@/types/scraper';
import { isJdReady } from '@/features/jobs/jobStatus';

export type AdminView = Extract<
  DashboardView,
  'today' | 'all' | 'needs_extraction' | 'extracted' | 'extraction_failed' | 'manual'
>;

export const ADMIN_VIEWS: Array<{ id: AdminView; label: string; description: string }> = [
  { id: 'today', label: "Today's fetched", description: 'Jobs added to the platform today' },
  { id: 'all', label: 'All jobs', description: 'Full non-blocked job pool' },
  { id: 'needs_extraction', label: 'Extraction backlog', description: 'Unfinished JD pool' },
  { id: 'extracted', label: 'JD ready', description: 'Completed job descriptions' },
  { id: 'extraction_failed', label: 'Extraction failed', description: 'Jobs whose extraction failed' },
  { id: 'manual', label: 'Manual submissions', description: 'Jobs added by URL or attachment' },
];

export function viewCount(view: AdminView, stats: AdminScraperStats | undefined): number | undefined {
  if (!stats) return undefined;
  switch (view) {
    case 'today':
      return stats.today_fetched ?? stats.today_scraped;
    case 'all':
      return stats.total_jobs;
    case 'needs_extraction':
      return stats.needs_extraction_jobs;
    case 'extracted':
      return stats.extracted_jobs;
    case 'extraction_failed':
      return stats.extraction_failed_jobs;
    case 'manual':
      return stats.manual_jobs;
  }
}

/** Failures live on the Extraction failed board only; dismissed rows never show. */
export function isVisibleRow(job: DashboardJob, view: AdminView): boolean {
  if (view === 'extraction_failed') return true;
  if (job.user_status === 'duplicated' || job.user_status === 'manual_hidden') return false;
  return job.status !== 'extraction_failed' && String(job.extraction_status || '').toLowerCase() !== 'failed';
}

export function isExtracting(job: DashboardJob): boolean {
  return job.extraction_status === 'pending' || job.extraction_status === 'processing';
}

/** Mirrors the legacy fallback poll: anything mid-pipeline keeps the list refreshing. */
export function isRowInFlight(job: DashboardJob): boolean {
  const busy = (s: string | null | undefined) => s === 'pending' || s === 'processing';
  return (
    (job.match_overall_score == null && busy(job.extraction_status)) ||
    busy(job.content_generation_status) ||
    busy(job.resume_build_status)
  );
}

export const isNotExtracted = (job: DashboardJob) => !isJdReady(job);

export type ExtractionState = 'structured' | 'ready' | 'extracting' | 'queued' | 'failed' | 'none';

export function extractionState(job: DashboardJob): ExtractionState {
  switch ((job.extraction_status || '').toLowerCase()) {
    case 'completed':
      return 'structured';
    case 'extracted':
      return 'ready';
    case 'processing':
      return 'extracting';
    case 'pending':
      return 'queued';
    case 'failed':
      return 'failed';
    default:
      return 'none';
  }
}

export const EXTRACTION_META: Record<ExtractionState, { label: string; hint: string; tone: string; pulse?: boolean }> = {
  structured: { label: 'Structured', hint: 'Job description structured by analysis', tone: 'bg-status-ready' },
  ready: { label: 'Ready', hint: 'Shared job description scraped and ready', tone: 'bg-status-ready' },
  extracting: { label: 'Extracting', hint: 'Extracting job description from the posting', tone: 'bg-status-preparing', pulse: true },
  queued: { label: 'Queued', hint: 'Queued for job description extraction', tone: 'bg-status-preparing', pulse: true },
  failed: { label: 'Failed', hint: 'Job description extraction failed', tone: 'bg-status-failed' },
  none: { label: 'Not started', hint: 'No extraction started yet', tone: 'bg-muted-foreground/40' },
};

const ADDED_FROM: Record<string, { short: string; full: string }> = {
  manual: { short: 'FM', full: 'Manual (from me)' },
  admin_manual: { short: 'FA', full: 'Manual (from admin)' },
  job_sites: { short: 'Sites', full: 'Job sites' },
  user_site: { short: 'My site', full: 'My job site (auto-synced board)' },
  remoterocketship: { short: 'RRS', full: 'RemoteRocketship' },
  jobright: { short: 'JR.ai', full: 'Jobright.ai' },
  welcometothejungle: { short: 'WTTJ', full: 'Welcome to the Jungle' },
  adzuna: { short: 'Adzuna', full: 'Adzuna' },
  ziprecruiter: { short: 'ZR', full: 'ZipRecruiter' },
};

export function addedFrom(job: DashboardJob): { short: string; full: string; hint: string } {
  const raw = (job.added_from || '').trim().toLowerCase();
  const slug =
    raw === 'admin_manual' ? raw : raw === 'manual' || job.from_me ? 'manual' : raw && raw !== 'job_sites' ? raw : 'job_sites';
  const meta = ADDED_FROM[slug] ?? {
    short: slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    full: slug,
  };
  const hint =
    slug === 'manual'
      ? 'Added by URL or attachment (FM)'
      : slug === 'admin_manual'
        ? 'Admin added this job manually to inventory (FA)'
        : slug === 'job_sites'
          ? 'Fetched from job sites during platform sync'
          : `Fetched from ${meta.full} during platform sync`;
  return { ...meta, hint };
}

export function spiderRunnable(spider: SpiderInfo): boolean {
  return !spider.requires_auth || spider.auth_optional === true || spider.auth_configured;
}

export function spiderNeedsAuth(spider: SpiderInfo): boolean {
  return spider.requires_auth && !spider.auth_configured && spider.auth_optional !== true;
}

function toUtcMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const hasTz = /([zZ])|([+-]\d{2}:?\d{2})$/.test(value);
  const iso = value.includes('T') ? value : value.trim().replace(' ', 'T');
  const ms = Date.parse(hasTz ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

export function runTimeMs(run: ScrapeRun): number | undefined {
  return toUtcMs(run.finished_at) ?? toUtcMs(run.started_at);
}

export function relativeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null || !Number.isFinite(ms)) return 'Never synced';
  const diff = Math.max(0, now - ms);
  if (diff < 45_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function isoToMs(iso: string | null | undefined): number | undefined {
  return toUtcMs(iso);
}

export function runStatusTone(status: string | null | undefined, errors = 0): string {
  const s = (status || '').toLowerCase();
  if (s === 'running') return 'bg-status-new animate-pulse';
  if (s === 'failed' || s === 'error' || errors > 0) return 'bg-status-failed';
  if (s === 'completed' || s === 'success') return 'bg-status-ready';
  return 'bg-muted-foreground/40';
}

export const fmt = (n: number | null | undefined) =>
  (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0).toLocaleString();
