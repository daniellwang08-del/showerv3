import type { ExtractionStatusLabel, SubmittedUrlItem } from '../types/ui';
import { parseServerDateTime, toFiniteTimeMs } from './serverDate';

/** Default page size for job lists (matches chat-style incremental loading). */
export const JOB_PAGE_SIZE = 300;

export type ValidJobApiRow = {
  id: string;
  source_url: string;
  created_at: string;
  posted_date?: string | null;
  scraped_at: string | null;
  extraction_id: string | null;
  extraction_status: string | null;
  match_overall_score: number | null;
  match_status: string | null;
  click_count?: number;
  applied_at?: string | null;
  applied_by_name?: string | null;
  appliedAt?: string | null;
  applied_by?: string | null;
};

export type InvalidJobApiRow = {
  id: string;
  source_url: string;
  duplicate_of_job_id: string | null;
  duplication_reason: string | null;
  created_at: string;
};

export function mapValidJobRow(j: ValidJobApiRow): SubmittedUrlItem {
  const scrapedMs = j.scraped_at ? parseServerDateTime(j.scraped_at) : undefined;
  const createdMs = parseServerDateTime(j.created_at) ?? 0;
  const postedDateMs = j.posted_date ? parseServerDateTime(j.posted_date) : undefined;
  const raw = j as ValidJobApiRow & { appliedAt?: string | null; applied_by?: string | null };
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
    match_overall_score: j.match_overall_score ?? undefined,
    match_status: j.match_status ?? undefined,
    click_count: j.click_count ?? 0,
    posted_date_ms: postedDateMs,
    appliedAt: appliedAtParsed,
    appliedBy: nameRaw?.trim() ? nameRaw.trim() : undefined,
    table: 'valid',
  };
}

export function mapInvalidJobRow(j: InvalidJobApiRow): SubmittedUrlItem {
  return {
    id: j.id,
    url: j.source_url,
    message: j.duplication_reason ?? 'Duplicate job detected',
    job_id: j.id,
    duplicate_job_id: j.duplicate_of_job_id,
    created_at_ms: Date.parse(j.created_at),
    table: 'invalid',
  };
}

/** Merge first-page poll into full list: upsert by id, preserve order by created_at desc. */
export function mergeValidJobs(prev: SubmittedUrlItem[], fresh: SubmittedUrlItem[]): SubmittedUrlItem[] {
  const map = new Map(prev.map((x) => [x.id, x]));
  for (const j of fresh) {
    map.set(j.id, j);
  }
  return Array.from(map.values()).sort((a, b) => b.created_at_ms - a.created_at_ms);
}

export function mergeInvalidJobs(prev: SubmittedUrlItem[], fresh: SubmittedUrlItem[]): SubmittedUrlItem[] {
  const map = new Map(prev.map((x) => [x.id, x]));
  for (const j of fresh) {
    map.set(j.id, j);
  }
  return Array.from(map.values()).sort((a, b) => b.created_at_ms - a.created_at_ms);
}
