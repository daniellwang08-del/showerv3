import type { DashboardJob } from '@/types/scraper';
import { dashboardJobMarkedApplied } from '@/utils/appliedStatus';

export { dashboardJobMarkedApplied as isApplied };

/** Original resume mode: the imported file is used as is, so only a cover letter is built. */
export function isCoverLetterOnly(job: DashboardJob): boolean {
  return job.content_generation_status === 'completed' && job.resume_build_status === 'skipped';
}

/** Tailored content or the document build is queued/running (re-runs keep stale PDFs marked completed). */
export function isDocsBuilding(job: DashboardJob): boolean {
  const cg = job.content_generation_status;
  if (cg === 'pending' || cg === 'processing') return true;
  if (cg && cg !== 'completed') return false;
  if (isCoverLetterOnly(job)) {
    return job.cover_letter_pdf_status === 'pending' || job.cover_letter_pdf_status === 'processing';
  }
  return job.resume_build_status === 'pending' || job.resume_build_status === 'processing';
}

export function isJdReady(job: DashboardJob): boolean {
  return (
    job.extraction_status === 'extracted' ||
    job.extraction_status === 'completed' ||
    job.match_overall_score != null
  );
}

/** Apply with Assistant needs a score, the job's PDFs, and nothing in flight.
 *  Cover-letter-only builds (original resume mode) need just the cover letter. */
export function isApplyReady(job: DashboardJob): boolean {
  if (job.match_overall_score == null || job.match_in_progress) return false;
  if (job.extraction_status === 'pending' || job.extraction_status === 'processing') return false;
  if (isDocsBuilding(job)) return false;
  const cover = job.cover_letter_pdf_status === 'completed';
  if (isCoverLetterOnly(job)) return cover;
  return job.resume_pdf_status === 'completed' && cover;
}

export function isInFlight(job: DashboardJob): boolean {
  return (
    (job.match_overall_score == null &&
      (job.extraction_status === 'pending' || job.extraction_status === 'processing')) ||
    job.match_in_progress ||
    isDocsBuilding(job)
  );
}

export type JobStage = 'applied' | 'ready' | 'documents' | 'matching' | 'scored' | 'jd_ready' | 'extracting' | 'failed' | 'new';

/** Single most relevant pipeline stage for a row, in the order the user cares about. */
export function jobStage(job: DashboardJob): JobStage {
  if (dashboardJobMarkedApplied(job)) return 'applied';
  if (job.extraction_status === 'failed') return 'failed';
  if (isApplyReady(job)) return 'ready';
  if (isDocsBuilding(job)) return 'documents';
  if (job.match_in_progress) return 'matching';
  if (job.match_overall_score != null) return 'scored';
  if (job.extraction_status === 'pending' || job.extraction_status === 'processing') return 'extracting';
  if (isJdReady(job)) return 'jd_ready';
  return 'new';
}

export const STAGE_META: Record<JobStage, { label: string; tone: string; pulse?: boolean }> = {
  applied: { label: 'Applied', tone: 'bg-status-applied' },
  ready: { label: 'Ready', tone: 'bg-status-ready' },
  documents: { label: 'Writing documents', tone: 'bg-status-preparing', pulse: true },
  matching: { label: 'Matching', tone: 'bg-status-new', pulse: true },
  scored: { label: 'Scored', tone: 'bg-status-new' },
  jd_ready: { label: 'JD ready', tone: 'bg-status-preparing' },
  extracting: { label: 'Reading posting', tone: 'bg-status-preparing', pulse: true },
  failed: { label: 'Extraction failed', tone: 'bg-status-failed' },
  new: { label: 'New', tone: 'bg-muted-foreground/40' },
};

export function workMode(job: DashboardJob): 'remote' | 'hybrid' | 'onsite' | null {
  const m = (job.work_mode || '').toLowerCase();
  if (m.includes('remote')) return 'remote';
  if (m.includes('hybrid')) return 'hybrid';
  if (m.includes('onsite') || m.includes('on-site') || m.includes('office')) return 'onsite';
  return job.is_remote ? 'remote' : null;
}

const SOURCE_NAMES: Record<string, string> = {
  remoterocketship: 'RemoteRocketship',
  jobright: 'Jobright',
  welcometothejungle: 'Welcome to the Jungle',
  adzuna: 'Adzuna',
  linkedin: 'LinkedIn',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  wellfound: 'Wellfound',
  remotive: 'Remotive',
  remoteok: 'Remote OK',
  jobicy: 'Jobicy',
  themuse: 'The Muse',
  ziprecruiter: 'ZipRecruiter',
  usajobs: 'USAJOBS',
  handshake: 'Handshake',
  jooble: 'Jooble',
  reed: 'Reed',
  arbeitnow: 'Arbeitnow',
  otta: 'Otta',
  jsearch: 'JSearch',
};

/** Slugs that have `/integrations/job-sites/{slug}.svg` artwork. */
const JOB_SITE_LOGO_SLUGS = new Set([
  'adzuna',
  'arbeitnow',
  'glassdoor',
  'handshake',
  'indeed',
  'jobicy',
  'jobright',
  'jooble',
  'jsearch',
  'linkedin',
  'otta',
  'reed',
  'remoteok',
  'remoterocketship',
  'remotive',
  'themuse',
  'usajobs',
  'wellfound',
  'ziprecruiter',
]);

const SOURCE_SLUG_ALIASES: Record<string, string> = {
  'remote-rocketship': 'remoterocketship',
  'remote_rocketship': 'remoterocketship',
  'remote ok': 'remoteok',
  'remote-ok': 'remoteok',
  'the muse': 'themuse',
  'the-muse': 'themuse',
  zip: 'ziprecruiter',
  angelist: 'wellfound',
  'angel.co': 'wellfound',
};

const CAREER_PAGE_HOST_RE =
  /(?:^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|smartrecruiters\.com|bamboohr\.com|applytojob\.com|recruitee\.com|personio\.de|teams\.freshteam\.com)(?:$|\/)/i;

export type SourceOriginIcon = 'user' | 'users' | 'career' | 'globe';

export type SourceOrigin = {
  /** Short tooltip / accessible name. */
  label: string;
  /** Job-site logo under /public/integrations/job-sites when available. */
  logoSrc?: string;
  /** Fallback Lucide glyph when there is no logo. */
  icon: SourceOriginIcon;
};

function normalizeSourceSlug(raw: string | null | undefined): string {
  const key = (raw || '').trim().toLowerCase();
  if (!key || key === 'job_sites' || key === 'manual' || key === 'admin_manual') return '';
  const compact = key.replace(/\s+/g, '');
  return SOURCE_SLUG_ALIASES[key] || SOURCE_SLUG_ALIASES[compact] || compact.replace(/[^a-z0-9]/g, '');
}

function isCareerPageHost(domain: string | null | undefined, url: string | null | undefined): boolean {
  const hay = `${domain || ''} ${url || ''}`.toLowerCase();
  return CAREER_PAGE_HOST_RE.test(hay);
}

/** Where the row came from: the user, the team, or a named job board. */
export function sourceLabel(job: DashboardJob): string {
  if (job.from_me) return 'Added by you';
  if (job.added_from === 'manual') return job.added_by_name ? `Added by ${job.added_by_name}` : 'Added by a teammate';
  if (job.added_from === 'admin_manual') return 'Added by team';
  const key = (job.source || job.added_from || '').toLowerCase();
  if (key && key !== 'job_sites') return SOURCE_NAMES[normalizeSourceSlug(key)] ?? SOURCE_NAMES[key] ?? job.source ?? key;
  if (isCareerPageHost(job.domain, job.source_url)) return 'Career page';
  return job.domain.replace(/^(www|jobs|careers|boards|job-boards)\./, '') || '-';
}

/** Icon-first origin for the jobs table (logo when we have one, else a simple glyph). */
export function sourceOrigin(job: DashboardJob): SourceOrigin {
  const label = sourceLabel(job);
  if (job.from_me) return { label, icon: 'user' };
  if (job.added_from === 'manual' || job.added_from === 'admin_manual') return { label, icon: 'users' };

  const slug = normalizeSourceSlug(job.source) || normalizeSourceSlug(job.added_from);
  if (slug && JOB_SITE_LOGO_SLUGS.has(slug)) {
    return { label, logoSrc: `/integrations/job-sites/${slug}.svg`, icon: 'globe' };
  }
  // ATS / company career boards (Greenhouse, Lever, Ashby, …) or bare domains.
  if (isCareerPageHost(job.domain, job.source_url) || slug === 'greenhouse' || slug === 'lever' || slug === 'ashby') {
    return { label: label === '-' ? 'Career page' : label, icon: 'career' };
  }
  return { label, icon: 'globe' };
}

export function relativeTime(dateStr: string | null | undefined, now = Date.now()): string {
  if (!dateStr) return '-';
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return '-';
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** Rows the applicant list never shows (dismissed duplicates / manual hides). */
export function isHiddenRow(job: DashboardJob, view: string): boolean {
  if (view === 'extraction_failed') return false;
  return job.user_status === 'duplicated' || job.user_status === 'manual_hidden';
}
