import { apiClient } from './client';
import type {
  AiUsageMeasure,
  AiUsageOverview,
  AnalysisUser,
  AppliedVsFetchedSeries,
  DataManagementMonth,
  MultiSeriesResult,
  PipelineSeriesResult,
  RemoteVsFetchedSeries,
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

export async function fetchAppliedVsFetchedSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<AppliedVsFetchedSeries> {
  const { data } = await apiClient.get<AppliedVsFetchedSeries>(
    '/data-management/series/applied-vs-fetched',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

/** @deprecated use fetchAppliedVsFetchedSeries */
export const fetchAppliedVsPostedSeries = fetchAppliedVsFetchedSeries;

export async function fetchRemoteVsFetchedSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<RemoteVsFetchedSeries> {
  const { data } = await apiClient.get<RemoteVsFetchedSeries>(
    '/data-management/series/remote-vs-fetched',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

/** @deprecated use fetchRemoteVsFetchedSeries */
export const fetchRemoteVsPostedSeries = fetchRemoteVsFetchedSeries;

export async function fetchPipelineSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<PipelineSeriesResult> {
  const { data } = await apiClient.get<PipelineSeriesResult>(
    '/data-management/series/pipeline',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

export async function fetchDistributionSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<MultiSeriesResult> {
  const { data } = await apiClient.get<MultiSeriesResult>(
    '/data-management/series/distribution',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

export async function fetchGrowthSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<MultiSeriesResult> {
  const { data } = await apiClient.get<MultiSeriesResult>(
    '/data-management/series/growth',
    { params: { year, month, timezone: timezone || localTimezone() } },
  );
  return data;
}

export async function fetchScrapeHealthSeries(
  year: number,
  month: number,
  timezone?: string,
): Promise<MultiSeriesResult> {
  const { data } = await apiClient.get<MultiSeriesResult>(
    '/data-management/series/scrape-health',
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

export async function fetchAiUsageOverview(year: number, month: number, timezone?: string): Promise<AiUsageOverview> {
  const { data } = await apiClient.get<AiUsageOverview>('/data-management/usage/overview', {
    params: { year, month, timezone: timezone || localTimezone() },
  });
  return data;
}

export async function fetchAiUsageSeries(body: {
  year: number;
  month: number;
  timezone?: string;
  user_ids: string[];
  measure: AiUsageMeasure;
}): Promise<MultiSeriesResult> {
  const { data } = await apiClient.post<MultiSeriesResult>('/data-management/series/ai-usage', {
    ...body,
    timezone: body.timezone || localTimezone(),
  });
  return data;
}

export async function fetchTailoringRunsSeries(body: {
  year: number;
  month: number;
  timezone?: string;
  user_ids: string[];
}): Promise<MultiSeriesResult> {
  const { data } = await apiClient.post<MultiSeriesResult>('/data-management/series/tailoring-runs', {
    ...body,
    timezone: body.timezone || localTimezone(),
  });
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
