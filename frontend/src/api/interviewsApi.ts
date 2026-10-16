import { API_BASE_URL, apiClient } from './client';
import type {
  EventInput,
  InterviewEventStatus,
  InterviewsOverview,
  InterviewStage,
  MailApplicationsOverview,
  ProcessChanges,
} from '../types/interviews';

export async function fetchInterviews(): Promise<InterviewsOverview> {
  const { data } = await apiClient.get<InterviewsOverview>('/interviews');
  return data;
}

/** Full-page navigation so the browser follows the Nylas sign-in redirects with cookies. */
export function startMailConnect(): void {
  window.location.assign(`${API_BASE_URL}/mail/connect`);
}

export async function disconnectMail(): Promise<void> {
  await apiClient.delete('/mail/config');
}

export async function fetchMailApplications(days: number, timezone: string): Promise<MailApplicationsOverview> {
  const { data } = await apiClient.get<MailApplicationsOverview>('/interviews/applications', {
    params: { days, timezone },
  });
  return data;
}

export async function syncInterviews(timezone: string): Promise<{ started: boolean }> {
  const { data } = await apiClient.post<{ started: boolean }>('/interviews/sync', { timezone });
  return data;
}

export async function createInterview(body: {
  company: string;
  role_title?: string | null;
  stage: InterviewStage;
  notes?: string | null;
}): Promise<{ id: string }> {
  const { data } = await apiClient.post<{ id: string }>('/interviews', body);
  return data;
}

export async function updateInterview(id: string, changes: ProcessChanges): Promise<void> {
  await apiClient.patch(`/interviews/${encodeURIComponent(id)}`, changes);
}

export async function deleteInterview(id: string): Promise<void> {
  await apiClient.delete(`/interviews/${encodeURIComponent(id)}`);
}

export async function addInterviewEvent(processId: string, body: EventInput): Promise<{ id: string }> {
  const { data } = await apiClient.post<{ id: string }>(`/interviews/${encodeURIComponent(processId)}/events`, body);
  return data;
}

export async function updateInterviewEvent(
  eventId: string,
  changes: Partial<EventInput> & { status?: InterviewEventStatus },
): Promise<void> {
  await apiClient.patch(`/interviews/events/${encodeURIComponent(eventId)}`, changes);
}

export async function deleteInterviewEvent(eventId: string): Promise<void> {
  await apiClient.delete(`/interviews/events/${encodeURIComponent(eventId)}`);
}
