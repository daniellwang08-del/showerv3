import type { InterviewEvent, InterviewProcess, InterviewsOverview } from '@/types/interviews';

export function makeEvent(overrides: Partial<InterviewEvent> = {}): InterviewEvent {
  return {
    id: 'e1',
    process_id: 'p1',
    kind: 'technical',
    status: 'scheduled',
    title: null,
    scheduled_at: null,
    duration_minutes: null,
    meeting_url: null,
    location: null,
    interviewers: null,
    summary: null,
    email_subject: null,
    email_from: null,
    email_date: null,
    email_url: null,
    source: 'email',
    ...overrides,
  };
}

export function makeProcess(overrides: Partial<InterviewProcess> = {}): InterviewProcess {
  return {
    id: 'p1',
    company: 'Acme',
    role_title: 'Engineer',
    stage: 'interviewing',
    status: 'active',
    next_step: null,
    remaining_steps: [],
    notes: null,
    source: 'email',
    last_activity_at: null,
    created_at: null,
    job: null,
    events: [],
    next_event: null,
    email_url: null,
    needs_action: false,
    ...overrides,
  };
}

export function makeOverview(overrides: Partial<InterviewsOverview> = {}): InterviewsOverview {
  return {
    server: { server_configured: true, providers: ['google', 'microsoft'] },
    connection: {
      connected: true,
      email: 'me@example.com',
      provider: 'google',
      provider_label: 'Gmail',
      status: 'connected',
      sync_status: 'idle',
      last_synced_at: new Date().toISOString(),
      last_sync_stats: { scanned: 120, candidates: 14, relevant: 6, created: 2, updated: 1 },
    },
    processes: [],
    summary: { active: 0, upcoming_week: 0, needs_action: 0, offers: 0, closed: 0 },
    ...overrides,
  };
}
