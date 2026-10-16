export type InterviewStage =
  | 'applied'
  | 'screening'
  | 'assessment'
  | 'interviewing'
  | 'final'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

export type InterviewEventKind =
  | 'recruiter_screen'
  | 'assessment'
  | 'technical'
  | 'behavioral'
  | 'hiring_manager'
  | 'onsite'
  | 'final'
  | 'offer'
  | 'rejection'
  | 'scheduling'
  | 'application_received'
  | 'other';

export type InterviewEventStatus =
  | 'scheduled'
  | 'needs_scheduling'
  | 'action_required'
  | 'completed'
  | 'cancelled'
  | 'info';

export interface InterviewEvent {
  id: string;
  process_id: string;
  kind: InterviewEventKind;
  status: InterviewEventStatus;
  title: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  meeting_url: string | null;
  location: string | null;
  interviewers: string | null;
  summary: string | null;
  email_subject: string | null;
  email_from: string | null;
  email_date: string | null;
  source: 'email' | 'manual';
}

export interface InterviewProcess {
  id: string;
  company: string;
  role_title: string | null;
  stage: InterviewStage;
  status: 'active' | 'closed';
  next_step: string | null;
  remaining_steps: string[];
  notes: string | null;
  source: 'email' | 'manual';
  last_activity_at: string | null;
  created_at: string | null;
  job: { id: string; title: string | null; url: string | null } | null;
  events: InterviewEvent[];
  next_event: InterviewEvent | null;
  needs_action: boolean;
}

export interface MailConnection {
  connected: boolean;
  email?: string;
  provider?: string | null;
  provider_label?: string;
  status?: 'connected' | 'needs_reauth';
  last_error?: string | null;
  sync_status?: 'idle' | 'running' | 'error';
  sync_started_at?: string | null;
  last_synced_at?: string | null;
  last_sync_error?: string | null;
  last_sync_stats?: { scanned: number; candidates: number; relevant: number; created: number; updated: number } | null;
  connected_at?: string | null;
}

export interface InterviewSummary {
  active: number;
  upcoming_week: number;
  needs_action: number;
  offers: number;
  closed: number;
}

export interface InterviewsOverview {
  server: { server_configured: boolean; providers: string[] };
  connection: MailConnection;
  processes: InterviewProcess[];
  summary: InterviewSummary;
}

export interface ProcessChanges {
  company?: string;
  role_title?: string | null;
  stage?: InterviewStage;
  status?: 'active' | 'closed';
  next_step?: string | null;
  notes?: string | null;
}

export interface EventInput {
  kind: InterviewEventKind;
  status?: InterviewEventStatus;
  title?: string | null;
  scheduled_at?: string | null;
  duration_minutes?: number | null;
  meeting_url?: string | null;
  location?: string | null;
}
