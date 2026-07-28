import { apiClient } from './client';
import type {
  AnalysisUser,
  AppliedVsPostedSeries,
  DataManagementDeleteResult,
  DataManagementFilters,
  DataManagementMatchRerunResult,
  DataManagementMonth,
  DataManagementPreview,
  DataManagementReconcileResult,
  DataManagementRescrapeResult,
  MultiSeriesResult,
  RemoteVsPostedSeries,
  UserActivityMetric,
} from '../types/dataManagement';

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function getClientTimezone(): string {
  return localTimezone();
}

export async function fetchDataManagementMonths(
  timezone?: string,
): Promise<{ timezone: string; months: DataManagementMonth[] }> {
  const { data } = await apiClient.get<{ timezone: string; months: DataManagementMonth[] }>(
    '/data-management/months',
    { params: { timezone: timezone || localTimezone(), n: 12 } },
  );
  return data;
}

export async function fetchAppliedVsPostedSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<AppliedVsPostedSeries> {
  const { data } = await apiClient.get<AppliedVsPostedSeries>(
    '/data-management/series/applied-vs-posted',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

export async function fetchRemoteVsPostedSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<RemoteVsPostedSeries> {
  const { data } = await apiClient.get<RemoteVsPostedSeries>(
    '/data-management/series/remote-vs-posted',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

export async function fetchAnalysisUsers(): Promise<AnalysisUser[]> {
  const { data } = await apiClient.get<{ users: AnalysisUser[] }>('/data-management/users');
  return data.users ?? [];
}

export async function fetchAnalysisPlatforms(): Promise<string[]> {
  const { data } = await apiClient.get<{ platforms: string[] }>('/data-management/platforms');
  return data.platforms ?? [];
}

export async function fetchUserActivitySeries(body: {
  year: number;
  month: number;
  timezone?: string;
  user_ids: string[];
  metrics: UserActivityMetric[];
}): Promise<MultiSeriesResult> {
  const { data } = await apiClient.post<MultiSeriesResult>(
    '/data-management/series/user-activity',
    {
      ...body,
      timezone: body.timezone || localTimezone(),
    },
  );
  return data;
}

export async function fetchPlatformVsAppliedSeries(body: {
  year: number;
  month: number;
  timezone?: string;
  platforms?: string[] | null;
}): Promise<MultiSeriesResult> {
  const { data } = await apiClient.post<MultiSeriesResult>(
    '/data-management/series/platform-vs-applied',
    {
      ...body,
      timezone: body.timezone || localTimezone(),
    },
  );
  return data;
}

function toBody(filters: DataManagementFilters, confirm = false) {
  return {
    ...filters,
    source: filters.source?.trim() || null,
    confirm,
  };
}

export async function previewDataManagement(
  filters: DataManagementFilters,
): Promise<DataManagementPreview> {
  const { data } = await apiClient.post<DataManagementPreview>(
    '/data-management/preview',
    toBody(filters, false),
  );
  return data;
}

export async function deleteDataManagementJobs(
  filters: DataManagementFilters,
): Promise<DataManagementDeleteResult> {
  const { data } = await apiClient.post<DataManagementDeleteResult>(
    '/data-management/delete',
    toBody(filters, true),
  );
  return data;
}

export async function rescrapeDataManagementJobs(
  filters: DataManagementFilters,
): Promise<DataManagementRescrapeResult> {
  const { data } = await apiClient.post<DataManagementRescrapeResult>(
    '/data-management/rescrape',
    toBody(filters, true),
  );
  return data;
}

export async function matchRerunDataManagementJobs(
  filters: DataManagementFilters,
): Promise<DataManagementMatchRerunResult> {
  const { data } = await apiClient.post<DataManagementMatchRerunResult>(
    '/data-management/match-rerun',
    toBody(filters, true),
  );
  return data;
}

export async function reconcileLocationsDataManagement(
  filters: DataManagementFilters,
): Promise<DataManagementReconcileResult> {
  const { data } = await apiClient.post<DataManagementReconcileResult>(
    '/data-management/reconcile-locations',
    toBody(filters, true),
  );
  return data;
}
