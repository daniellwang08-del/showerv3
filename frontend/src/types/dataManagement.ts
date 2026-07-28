export interface DataManagementMonth {
  year: number;
  month: number;
  label: string;
}

export interface AppliedVsPostedDay {
  date: string;
  applied_count: number;
  posted_count: number;
}

export interface AppliedVsPostedSeries {
  year: number;
  month: number;
  timezone: string;
  days: AppliedVsPostedDay[];
  totals: {
    applied_count: number;
    posted_count: number;
  };
}

export interface RemoteVsPostedDay {
  date: string;
  remote_count: number;
  posted_count: number;
}

export interface RemoteVsPostedSeries {
  year: number;
  month: number;
  timezone: string;
  days: RemoteVsPostedDay[];
  totals: {
    remote_count: number;
    posted_count: number;
  };
}

export interface AnalysisUser {
  id: string;
  email: string;
  name: string;
}

export type UserActivityMetric = 'jobs_added' | 'applied' | 'sheet_posted' | 'pumble_posted';

export interface MultiSeriesMeta {
  key: string;
  label: string;
  user_id?: string;
  metric?: string;
  platform?: string | null;
  kind?: string;
}

export interface MultiSeriesResult {
  year: number;
  month: number;
  timezone: string;
  days: Array<Record<string, string | number>>;
  series: MultiSeriesMeta[];
  totals: Record<string, number>;
  platforms?: string[];
}

export type DataManagementDateField = 'created_at' | 'posted_date' | 'added_at';
export type DataManagementVisibility = 'visible' | 'hidden' | 'all';
export type DataManagementWorkMode = 'any' | 'remote' | 'hybrid' | 'onsite';
export type DataManagementTriState = 'any' | 'true' | 'false';

export interface DataManagementFilters {
  date_field: DataManagementDateField;
  date_from: string;
  date_to: string;
  timezone: string;
  visibility: DataManagementVisibility;
  work_mode: DataManagementWorkMode;
  extraction_status: string;
  is_job_posting: DataManagementTriState;
  source: string | null;
  min_match_score: number | null;
  max_match_score: number | null;
  has_application: DataManagementTriState;
  confirm?: boolean;
}

export interface DataManagementSampleJob {
  job_id: string;
  title: string | null;
  company: string | null;
  source_url: string | null;
  created_at: string | null;
  posted_date: string | null;
  extraction_status: string | null;
  match_score: number | null;
}

export interface DataManagementPreview {
  matched_count: number;
  capped: boolean;
  limit: number;
  date_start_utc: string;
  date_end_utc: string;
  sample: DataManagementSampleJob[];
}

export interface DataManagementDeleteResult {
  success: boolean;
  matched_count: number;
  deleted: number;
  failed: number;
  capped: boolean;
}

export interface DataManagementRescrapeResult {
  status: string;
  matched_count: number;
  enqueued: number;
  jobs: Array<{ job_id: string; extraction_id: string }>;
  skipped: Array<{ id: string; reason: string }>;
  capped: boolean;
}

export interface DataManagementMatchRerunResult {
  status: string;
  matched_count: number;
  enqueued: number;
  enqueued_ids?: string[];
  skipped: Array<{ id: string; reason: string }>;
  capped: boolean;
  message?: string;
}

export interface DataManagementReconcileResult {
  success: boolean;
  matched_count: number;
  scanned: number;
  moved_non_us: number;
  moved_unknown: number;
  restored: number;
  capped: boolean;
}
