import type { ExtractionStatusLabel, SubmittedUrlItem } from '../types/ui';
import { parseServerDateTime, toFiniteTimeMs } from './serverDate';

/** Default page size for job lists (matches chat-style incremental loading). */
export const JOB_PAGE_SIZE = 300;

export type JobApiRow = {
  id: string;
  source_url: string;
  created_at: string;
  posted_date?: string | null;
  scraped_at: string | null;
  extraction_id: string | null;
  extraction_status: string | null;
  is_job_posting?: boolean | null;
  match_overall_score: number | null;
  match_status: string | null;
  click_count?: number;
  applied_at?: string | null;
  applied_by_name?: string | null;
  appliedAt?: string | null;
  applied_by?: string | null;
  sheet_posted_at?: string | null;
};

export type DuplicatedJobApiRow = {
  user_job_status_id: string;
  job_id: string;
  source_url: string;
  domain: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  posted_date?: string | null;
  status: string;
  exclusion_type?: import('../types/index').ExclusionType;
  duplicated_because_id?: string | null;
  reason?: string | null;
  match_score_at_decision?: number | null;
  created_at: string;
};

export function mapJobRow(j: JobApiRow): SubmittedUrlItem {
  const scrapedMs = j.scraped_at ? parseServerDateTime(j.scraped_at) : undefined;
  const createdMs = parseServerDateTime(j.created_at) ?? 0;
  const postedDateMs = j.posted_date ? parseServerDateTime(j.posted_date) : undefined;
  const raw = j as JobApiRow & { appliedAt?: string | null; applied_by?: string | null };
  const appliedRaw = raw.applied_at ?? raw.appliedAt;
  const nameRaw = raw.applied_by_name ?? raw.applied_by;
  const appliedAtParsed = toFiniteTimeMs(appliedRaw ?? undefined);
  return {
    id: j.id,
    url: j.source_url,
    message: 'Job submitted successfully',
    job_id: j.id,
    duplicate_job_id: null,
    created_at_ms: createdMs,
    scraped_at_ms: scrapedMs,
    extraction_id: j.extraction_id ?? undefined,
    extraction_status: (j.extraction_status as ExtractionStatusLabel | null) ?? undefined,
    is_job_posting: j.is_job_posting ?? undefined,
    match_overall_score: j.match_overall_score ?? undefined,
    match_status: j.match_status ?? undefined,
    click_count: j.click_count ?? 0,
    posted_date_ms: postedDateMs,
    appliedAt: appliedAtParsed,
    appliedBy: nameRaw?.trim() ? nameRaw.trim() : undefined,
    sheet_posted_at: j.sheet_posted_at ? parseServerDateTime(j.sheet_posted_at) : undefined,
    table: 'active',
  };
}

export function mapDuplicatedJobRow(j: DuplicatedJobApiRow): SubmittedUrlItem {
  return {
    id: j.user_job_status_id,
    url: j.source_url,
    message: j.reason ?? 'Duplicate job detected',
    job_id: j.job_id,
    duplicate_job_id: j.duplicated_because_id ?? null,
    created_at_ms: Date.parse(j.created_at),
    table: 'duplicated',
    duplication_reason: j.reason,
    exclusion_type: j.exclusion_type ?? null,
    valid_job_id_for_restore: j.job_id,
    company: j.company ?? null,
    title: j.title ?? null,
  };
}

/** Merge first-page poll into full list: upsert by id, preserve order by created_at desc. */
function mergeWithAuthoritativeWindow(prev: SubmittedUrlItem[], fresh: SubmittedUrlItem[]): SubmittedUrlItem[] {
  if (fresh.length === 0) return prev;

  const freshIds = new Set(fresh.map((j) => j.id));
  const oldestFreshMs = fresh.reduce((min, j) => Math.min(min, j.created_at_ms), Number.POSITIVE_INFINITY);

  // Keep older paged history as-is, but for the currently-polled first page window:
  // if a previously loaded row is not returned anymore, treat it as stale and drop it.
  const keptPrev = prev.filter((j) => j.created_at_ms < oldestFreshMs || freshIds.has(j.id));

  const map = new Map(keptPrev.map((x) => [x.id, x]));
  for (const j of fresh) {
    map.set(j.id, j);
  }
  return Array.from(map.values()).sort((a, b) => b.created_at_ms - a.created_at_ms);
}

export function mergeActiveJobs(prev: SubmittedUrlItem[], fresh: SubmittedUrlItem[]): SubmittedUrlItem[] {
  return mergeWithAuthoritativeWindow(prev, fresh);
}

export function mergeDuplicatedJobs(prev: SubmittedUrlItem[], fresh: SubmittedUrlItem[]): SubmittedUrlItem[] {
  return mergeWithAuthoritativeWindow(prev, fresh);
}
