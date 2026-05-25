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
  resume_pdf_status: string | null;
  resume_pdf_path: string | null;
  cover_letter_pdf_status: string | null;
  cover_letter_pdf_path: string | null;
  applied_at: string | null;
  applied_by_name: string | null;
  user_status: string | null;
  source: string | null;
  is_remote: boolean;
  salary_raw: string | null;
  job_type: string | null;
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
  extracted_jobs: number;
  ready_jobs: number;
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
}

export interface SpiderInfo {
  name: string;
  label: string;
  requires_auth: boolean;
  auth_configured: boolean;
  auth_saved_at: string | null;
  auth_setup_command: string | null;
}
