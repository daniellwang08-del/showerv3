import { apiClient } from './client';
import type {
  SystemLogListResponse,
  SystemLogQuery,
  SystemLogStats,
  SystemLogEvent,
} from '../types/systemLogs';

export async function fetchSystemLogs(params: SystemLogQuery = {}): Promise<SystemLogListResponse> {
  const { data } = await apiClient.get<SystemLogListResponse>('/admin/logs', { params });
  return data;
}

export async function fetchRequestTimeline(requestId: string): Promise<SystemLogEvent[]> {
  const { data } = await apiClient.get<SystemLogEvent[]>(
    `/admin/logs/request/${encodeURIComponent(requestId)}`,
  );
  return data;
}

export async function fetchSystemLogStats(hours = 24): Promise<SystemLogStats> {
  const { data } = await apiClient.get<SystemLogStats>('/admin/logs/stats', {
    params: { hours },
  });
  return data;
}

export async function purgeSystemLogs(days?: number): Promise<{ deleted: number }> {
  const { data } = await apiClient.post<{ deleted: number }>('/admin/logs/purge', {
    days: days ?? null,
  });
  return data;
}
