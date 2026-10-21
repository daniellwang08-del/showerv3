import { API_BASE_URL, apiClient } from './client';
import type { IssueCategory, IssuePage, IssueReport, IssueStatus } from '../types/issues';

export interface IssueQuery {
  status?: IssueStatus;
  category?: IssueCategory;
  q?: string;
  offset?: number;
  limit?: number;
}

export async function fetchAdminIssues(params: IssueQuery): Promise<IssuePage> {
  const { data } = await apiClient.get<IssuePage>('/issues/admin', { params });
  return data;
}

export async function fetchAdminIssue(id: string): Promise<IssueReport> {
  const { data } = await apiClient.get<IssueReport>(`/issues/admin/${encodeURIComponent(id)}`);
  return data;
}

export async function updateIssue(
  id: string,
  body: { status?: IssueStatus; admin_note?: string | null },
): Promise<IssueReport> {
  const { data } = await apiClient.patch<IssueReport>(`/issues/admin/${encodeURIComponent(id)}`, body);
  return data;
}

export function attachmentUrl(reportId: string, attachmentId: string, download = false): string {
  const path = `${API_BASE_URL}/issues/${encodeURIComponent(reportId)}/attachments/${encodeURIComponent(attachmentId)}`;
  return download ? `${path}?download=true` : path;
}
