import type { WeeklyProgress } from '@/api/scraperApi';
import type { InterviewProcess, InterviewStage, InterviewSummary } from './interviews';

export interface ReportShare {
  id: string;
  /** The viewer's NAO account email. */
  email: string;
  viewer_name: string | null;
  include_notes: boolean;
  message: string | null;
  expires_at: string | null;
  active: boolean;
  last_viewed_at: string | null;
  view_count: number;
  created_at: string | null;
}

export interface ReportSharesList {
  shares: ReportShare[];
  max_shares: number;
  expiry_choices: number[];
}

export interface ShareInput {
  emails: string[];
  expires_in_days: number | null;
  include_notes: boolean;
  message?: string | null;
}

export interface ShareChanges {
  expires_in_days?: number | null;
  include_notes?: boolean;
}

export interface IncomingShare {
  id: string;
  owner_name: string;
  owner_headline: string | null;
  message: string | null;
  shared_at: string | null;
  expires_at: string | null;
  last_viewed_at: string | null;
}

export interface ReportApplication {
  id: string;
  job_id: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string | null;
  applied_at: string | null;
  /** `email`: found as a confirmation email. `nao`: marked applied in NAO. */
  source: 'email' | 'nao';
  match_score: number | null;
  stage: InterviewStage;
  process_id: string | null;
  process_active: boolean;
}

export interface ReportApplied {
  /** `email`: confirmation emails, once the inbox has synced. `nao`: jobs marked applied in NAO. */
  source: 'email' | 'nao';
  last_7_days: number;
  last_30_days: number;
  all_time: number;
  marked_in_nao: { last_7_days: number; last_30_days: number };
}

export interface ReportPool {
  total_jobs: number;
  scored_jobs: number;
  ready_jobs: number;
  applied_jobs: number;
  best_jobs: number;
  good_jobs: number;
  today_scraped: number;
  avg_match_score: number;
  min_match_score: number;
}

export interface SharedReport {
  owner: { name: string; headline: string | null };
  generated_at: string;
  include_notes: boolean;
  interviews: {
    connected: boolean;
    last_synced_at: string | null;
    processes: InterviewProcess[];
    summary: InterviewSummary;
  };
  activity: WeeklyProgress;
  /** Same source and calendar days as the `applied` series in `activity`. */
  applied: ReportApplied;
  /** `items` holds the newest applications; `total` counts all of them in the lookback window. */
  applications: {
    items: ReportApplication[];
    total: number;
    by_source: { email: number; nao: number };
    lookback_days: number;
  };
  pool: ReportPool | null;
}

export interface SharedReportResponse {
  /** Null in the owner's preview. */
  share: IncomingShare | null;
  report: SharedReport;
}
