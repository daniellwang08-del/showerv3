import { apiClient } from './client';
import type {
  IncomingShare,
  ReportShare,
  ReportSharesList,
  ShareChanges,
  ShareInput,
  SharedReportResponse,
} from '../types/reportShare';

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function fetchReportShares(): Promise<ReportSharesList> {
  const { data } = await apiClient.get<ReportSharesList>('/report-shares');
  return data;
}

export async function createReportShares(body: ShareInput): Promise<{ shares: ReportShare[] }> {
  const { data } = await apiClient.post<{ shares: ReportShare[] }>('/report-shares', body);
  return data;
}

export async function updateReportShare(id: string, changes: ShareChanges): Promise<ReportShare> {
  const { data } = await apiClient.patch<ReportShare>(`/report-shares/${encodeURIComponent(id)}`, changes);
  return data;
}

export async function deleteReportShare(id: string): Promise<void> {
  await apiClient.delete(`/report-shares/${encodeURIComponent(id)}`);
}

export async function fetchIncomingShares(): Promise<{ shares: IncomingShare[] }> {
  const { data } = await apiClient.get<{ shares: IncomingShare[] }>('/report-shares/incoming');
  return data;
}

export async function fetchReportPreview(includeNotes: boolean): Promise<SharedReportResponse> {
  const { data } = await apiClient.get<SharedReportResponse>('/report-shares/preview', {
    params: { include_notes: includeNotes, timezone: timezone() },
  });
  return data;
}

export async function fetchSharedReport(token: string): Promise<SharedReportResponse> {
  const { data } = await apiClient.get<SharedReportResponse>(`/shared-reports/${encodeURIComponent(token)}`, {
    params: { timezone: timezone() },
  });
  return data;
}
