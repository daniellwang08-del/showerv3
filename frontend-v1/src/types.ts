export interface ValidJob {
  id: string;
  source_url: string;
  title: string | null;
  company: string;
  location: string | null;
  description: string | null;
  posted_date: string | null;
  experience_level: string | null;
  industry: string | null;
  created_at: string;
}

export interface InvalidJob {
  id: string;
  source_url: string;
  title: string | null;
  company: string;
  location: string | null;
  description: string | null;
  posted_date: string | null;
  experience_level: string | null;
  industry: string | null;
  duplicate_of_job_id: string | null;
  duplication_reason: string | null;
  similarity_score: number | null;
  created_at: string;
}

export interface JobStats {
  valid_jobs_count: number;
  invalid_jobs_count: number;
  total_jobs: number;
}

export interface SubmissionResponse {
  success: boolean;
  job_id: string | null;
  is_duplicate: boolean;
  duplicate_job_id: string | null;
  message: string;
}
