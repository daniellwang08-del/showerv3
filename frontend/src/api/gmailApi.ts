import { API_BASE_URL, apiClient } from './client';
import type { GmailConfig, GmailMessageSummary, GmailSearchResult, GmailStatus } from '../types/gmail';

export async function fetchGmailStatus(): Promise<GmailStatus> {
  const { data } = await apiClient.get<GmailStatus>('/gmail/status');
  return data;
}

export async function fetchGmailConfig(): Promise<GmailConfig> {
  const { data } = await apiClient.get<GmailConfig>('/gmail/config');
  return data;
}

/** Full-page navigation so the browser follows Google's OAuth redirects with cookies. */
export function startGmailConnect(): void {
  window.location.assign(`${API_BASE_URL}/gmail/connect`);
}

export async function setGmailEnabled(is_enabled: boolean): Promise<GmailConfig & { success: boolean }> {
  const { data } = await apiClient.patch<GmailConfig & { success: boolean }>('/gmail/config/enabled', {
    is_enabled,
  });
  return data;
}

export async function disconnectGmail(): Promise<{ success: boolean; disconnected: boolean }> {
  const { data } = await apiClient.delete<{ success: boolean; disconnected: boolean }>('/gmail/config');
  return data;
}

export async function searchGmail(q: string, max_results = 15): Promise<GmailSearchResult> {
  const { data } = await apiClient.post<GmailSearchResult>('/gmail/search', {
    q: q.trim(),
    max_results,
  });
  return data;
}

export async function fetchGmailMessage(messageId: string): Promise<GmailMessageSummary> {
  const { data } = await apiClient.get<GmailMessageSummary>(`/gmail/messages/${encodeURIComponent(messageId)}`);
  return data;
}
