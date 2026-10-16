import type { IncomingShare, ReportApplication, ReportShare, SharedReportResponse } from '@/types/reportShare';
import type { InterviewProcess } from '@/types/interviews';

export function makeApp(overrides: Partial<ReportApplication> = {}): ReportApplication {
  return {
    id: 'a1',
    job_id: 'j1',
    title: 'Engineer',
    company: 'Acme',
    location: null,
    url: null,
    applied_at: null,
    source: 'nao',
    match_score: null,
    stage: 'applied',
    process_id: null,
    process_active: false,
    ...overrides,
  };
}

export function makeShare(overrides: Partial<ReportShare> = {}): ReportShare {
  return {
    id: 's1',
    email: 'coach@example.com',
    viewer_name: 'Jordan Coach',
    include_notes: false,
    message: null,
    expires_at: null,
    active: true,
    last_viewed_at: null,
    view_count: 0,
    created_at: '2026-10-10T00:00:00Z',
    ...overrides,
  };
}

export function makeIncoming(overrides: Partial<IncomingShare> = {}): IncomingShare {
  return {
    id: 's1',
    owner_name: 'Sam Lee',
    owner_headline: 'Senior Engineer',
    message: null,
    shared_at: '2026-10-10T00:00:00Z',
    expires_at: null,
    last_viewed_at: null,
    ...overrides,
  };
}

export function makeReport(
  processes: InterviewProcess[] = [],
  applications: ReportApplication[] = [],
  overrides: Partial<SharedReportResponse> = {},
): SharedReportResponse {
  return {
    share: makeIncoming(),
    report: {
      owner: { name: 'Sam Lee', headline: 'Senior Engineer' },
      generated_at: new Date().toISOString(),
      include_notes: false,
      interviews: {
        connected: true,
        last_synced_at: new Date().toISOString(),
        processes,
        summary: { active: processes.length, upcoming_week: 0, needs_action: 0, offers: 0, closed: 0 },
      },
      activity: {
        timezone: 'UTC',
        days: 30,
        min_match_score: 70,
        series: Array.from({ length: 30 }, (_, i) => ({
          date: `2026-09-${String(i + 1).padStart(2, '0')}`,
          label: String(i + 1),
          posted: 3,
          recommended: 1,
          applied: i >= 23 ? 2 : 0,
        })),
        totals: { posted: 90, recommended: 30, applied: 14 },
      },
      applications: { items: applications, total: applications.length, lookback_days: 90, all_time: 120 },
      pool: {
        total_jobs: 800,
        scored_jobs: 600,
        ready_jobs: 40,
        applied_jobs: 120,
        best_jobs: 55,
        good_jobs: 150,
        today_scraped: 12,
        avg_match_score: 64,
        min_match_score: 70,
      },
    },
    ...overrides,
  };
}
