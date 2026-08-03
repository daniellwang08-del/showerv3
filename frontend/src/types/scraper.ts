/** Extraction pipeline stages returned by the jobs-list endpoint.
 *  pending    → queued for extraction
 *  processing → extraction worker running
 *  extracted  → raw text captured, waiting for LLM structuring
 *  completed  → LLM analysis done, structured output stored
 */
export type ExtractionStatus = 'pending' | 'processing' | 'extracted' | 'completed';

export interface ScrapedJob {
  id: string;
  source: string;
  source_job_id: string;
  url: string;
  origin_url: string | null;
  title: string;
  company_name: string | null;
  location: string | null;
  is_remote: boolean;
  salary_raw: string | null;
  salary_min_cents: number | null;
  salary_max_cents: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  description: string | null;
  job_type: string | null;
  experience_level: string | null;
  tags: string[] | null;
  posted_at: string | null;
  scraped_at: string | null;
  updated_at: string | null;
  promoted_extraction_id: string | null;
  promoted_at: string | null;

  /** Processing pipeline status fields (joined server-side) */
  extraction_status: ExtractionStatus | null;
  job_id: string | null;
  resume_build_status: string | null;
  /** Phase B tailored content generation status */
  content_generation_status: string | null;
  /** AI match overall score 0-100 for the current user; null if not yet analysed */
  match_score: number | null;
  /** True while analyze_job_match is running for this user */
  match_in_progress: boolean | null;
  /** True when this job is excluded from the user's active valid pool */
  is_excluded_for_user: boolean | null;
}

export interface DashboardJob {
  id: string;
  source_url: string;
  normalized_url: string;
  domain: string;
  title: string | null;
  company: string;
  location: string | null;
  description: string | null;
  posted_date: string | null;
  experience_level: string | null;
  industry: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  extraction_id: string | null;
  extraction_status: ExtractionStatus | null;
  is_job_posting: boolean | null;
  match_overall_score: number | null;
  match_in_progress: boolean;
  resume_build_status: string | null;
  content_generation_status: string | null;
  resume_build_id: string | null;
  resume_pdf_status: string | null;
  resume_pdf_path: string | null;
  cover_letter_pdf_status: string | null;
  cover_letter_pdf_path: string | null;
  applied_at: string | null;
  applied_by_name: string | null;
  sheet_posted_at: string | null;
  pumble_posted_at: string | null;
  user_status: string | null;
  source: string | null;
  is_remote: boolean;
  work_mode: string | null;
  salary_raw: string | null;
  job_type: string | null;
  /** True when this user added the job via URL/attachment. */
  from_me?: boolean;
  /** How the job entered the pool: manual | job_sites. */
  added_from?: 'manual' | 'job_sites' | string | null;
}

export interface DashboardJobsPage {
  items: DashboardJob[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface ScrapedJobUpdatePayload {
  url?: string;
  origin_url?: string | null;
  title?: string;
  company_name?: string | null;
  location?: string | null;
}

export interface RerunExtractionResponse {
  status: string;
  scraped_job_id: string;
  extraction_id: string | null;
  job_id: string | null;
  target_url: string | null;
  enqueued: boolean;
  message: string;
  /** Returned when the extraction was already enqueued/in-progress */
  extraction_status?: ExtractionStatus | null;
}

export interface DeleteScrapedJobResponse {
  status: string;
  scraped_job_id: string;
  message: string;
}

export interface ScrapedJobsPage {
  items: ScrapedJob[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface SourceStats {
  source: string;
  count: number;
  latest_scraped: string | null;
}

export interface ScraperStats {
  total_jobs: number;
  total_remote: number;
  today_scraped: number;
  today_remote: number;
  today_posted: number;
  my_jobs: number;
  extracted_jobs: number;
  ready_jobs: number;
  /** Match score >= 75 (Strong). Optional for older backends. */
  best_jobs?: number;
  /** Match score 50-74 (Good). Optional for older backends. */
  good_jobs?: number;
  /** Match score at/above preference minimum. Optional for older backends. */
  qualified_jobs?: number;
  /** Jobs with any match score. Optional for older backends. */
  scored_jobs?: number;
  /** Average match score across scored jobs. Optional for older backends. */
  avg_match_score?: number;
  /** Visible jobs not yet marked applied. Optional for older backends. */
  available_jobs?: number;
  /** Visible jobs marked applied. Optional for older backends. */
  applied_jobs?: number;
  /** Marked applied today. Optional for older backends. */
  applied_today?: number;
  /** Posted to Google Sheets. Optional for older backends. */
  sheet_posted_jobs?: number;
  /** Posted to Pumble. Optional for older backends. */
  pumble_posted_jobs?: number;
  /** Last-7-day daily series for the four main side tiles. */
  trends?: {
    labels?: string[];
    ready?: number[];
    best?: number[];
    remote?: number[];
    available?: number[];
  };
  sources: SourceStats[];
  recent_runs: ScrapeRun[];
}

export interface ScrapeRun {
  id: string;
  spider_name: string;
  started_at: string | null;
  finished_at: string | null;
  items_scraped: number;
  items_new: number;
  items_updated: number;
  errors: number;
  status: string;
}

export interface SyncStatus {
  status: 'queued' | 'running' | 'idle';
  spider_name: string | null;
  message: string;
  items_scraped?: number;
  items_new?: number;
  items_updated?: number;
  started_at?: string | null;
  elapsed_seconds?: number | null;
}

export interface SyncProgress {
  spiderName: string | null;
  current: number;
  total: number;
  itemsScraped: number;
  itemsNew: number;
  elapsedSeconds: number;
  message: string;
}

/** Closable post-sync summary shown under the Jobs Dashboard header. */
export interface SyncResultNotice {
  id: string;
  kind: 'success' | 'warning' | 'error';
  /** Total listings scraped across platforms. */
  itemsScraped: number;
  /** Newly inserted listings (subset of scraped). */
  itemsNew: number;
  /** Updated existing listings. */
  itemsUpdated: number;
  /** Spider names that ran (e.g. remoterocketship). */
  platforms: string[];
  syncMode: 'incremental' | 'date_backfill' | string;
  postedSince: string | null;
  postedUntil: string | null;
  /** Optional failure / stop detail. */
  error: string | null;
  message: string;
  completedAt: string;
}

export interface SyncPlatformResult {
  spider?: string;
  success?: boolean;
  items_scraped?: number;
  items_new?: number;
  items_updated?: number;
  error?: string;
  message?: string;
}

export interface SyncCompletionSummary {
  spider?: string;
  sync_mode?: string;
  posted_since?: string | null;
  posted_until?: string | null;
  platforms?: string[];
  items_scraped?: number;
  items_new?: number;
  items_updated?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
  error?: string;
  message?: string;
  results?: SyncPlatformResult[];
}

export interface SyncPlatform {
  name: string;
  label: string;
  requires_auth: boolean;
}

export interface SyncCheckpoint {
  spider_name: string;
  marker_job_ids: string[] | Record<string, string[]>;
  updated_at: string | null;
}

export interface SyncTriggerOptions {
  spider_name?: string;
  sync_mode?: 'incremental' | 'date_backfill';
  spider_names?: string[];
  posted_since?: string;
  posted_until?: string;
}

export interface JobSyncSchedule {
  enabled: boolean;
  cadence: 'interval' | 'daily';
  interval_hours: number;
  daily_time: string;
  timezone: string;
  sync_mode: 'incremental' | 'date_backfill';
  lookback_days: number;
  spider_names: string[] | null;
  run_as_user_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_message: string | null;
  next_run_at: string | null;
  allowed_timezones: string[];
}

export type JobSyncScheduleUpdate = Pick<
  JobSyncSchedule,
  | 'enabled'
  | 'cadence'
  | 'interval_hours'
  | 'daily_time'
  | 'timezone'
  | 'sync_mode'
  | 'lookback_days'
  | 'spider_names'
>;

export interface SpiderInfo {
  name: string;
  label: string;
  requires_auth: boolean;
  auth_configured: boolean;
  auth_saved_at: string | null;
  auth_setup_command: string | null;
}
