export interface Job {
  id: string;
  source_url: string;
  title: string | null;
  company: string;
  location: string | null;
  description: string | null;
  posted_date: string | null;
  experience_level: string | null;
  industry: string | null;
  status: string;
  created_at: string;
}

/**
 * exclusion_type values (null for global content-level duplicates):
 *  'applied_company'       – user already applied at this company
 *  'lower_score'           – lower match score than existing job at company
 *  'superseded_by_higher'  – replaced by a higher-scoring job at same company
 *  'no_score_comparison'   – first analyzed job at company wins; others excluded
 *  'below_min_score'       – match score below user's minimum threshold
 *  'strict_similarity'     – same title and company
 *  'same_url'              – identical URL already active for user
 *  'extraction_failed'     – expired/invalid posting could not be extracted
 *  'blocked_domain'        – domain blocked at submit
 */
export type ExclusionType =
  | 'applied_company'
  | 'lower_score'
  | 'superseded_by_higher'
  | 'no_score_comparison'
  | 'below_min_score'
  | 'strict_similarity'
  | 'same_url'
  | 'extraction_failed'
  | 'blocked_domain'
  | 'manual_invalid'
  | 'manual_duplicate'
  | null;

export interface DeduplicationSettings {
  dedup_recycle_days: number;
}

export interface JobStats {
  valid_jobs_count: number;
  duplicated_jobs_count: number;
  total_jobs: number;
}

export interface SubmissionResponse {
  success: boolean;
  job_id: string | null;
  is_duplicate: boolean;
  duplicate_job_id: string | null;
  message: string;
}
