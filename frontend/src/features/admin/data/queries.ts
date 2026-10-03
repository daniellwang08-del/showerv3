import { useQuery } from '@tanstack/react-query';
import {
  fetchAnalysisPlatforms,
  fetchAnalysisUsers,
  fetchAppliedVsFetchedSeries,
  fetchDataManagementMonths,
  fetchDistributionSeries,
  fetchGrowthSeries,
  fetchPipelineSeries,
  fetchPlatformVsAppliedSeries,
  fetchRemoteVsFetchedSeries,
  fetchScrapeHealthSeries,
  fetchUserActivitySeries,
} from '@/api/dataManagementApi';
import type { UserActivityMetric } from '@/types/dataManagement';

type Period = { year: number; month: number; timezone: string };

export const adminDataKeys = {
  all: ['admin-data'] as const,
  months: (timezone: string) => ['admin-data', 'months', timezone] as const,
  users: () => ['admin-data', 'users'] as const,
  platforms: () => ['admin-data', 'platforms'] as const,
  series: (kind: string, p: Period | null, extra?: unknown) => ['admin-data', 'series', kind, p, extra] as const,
};

const STALE = 60_000;

export function useMonths(timezone: string) {
  return useQuery({
    queryKey: adminDataKeys.months(timezone),
    queryFn: () => fetchDataManagementMonths(timezone),
    staleTime: STALE,
  });
}

export function useAnalysisUsers() {
  return useQuery({ queryKey: adminDataKeys.users(), queryFn: fetchAnalysisUsers, staleTime: STALE });
}

export function useAnalysisPlatforms() {
  return useQuery({ queryKey: adminDataKeys.platforms(), queryFn: fetchAnalysisPlatforms, staleTime: STALE });
}

const MONTHLY = {
  'applied-vs-fetched': fetchAppliedVsFetchedSeries,
  'remote-vs-fetched': fetchRemoteVsFetchedSeries,
  pipeline: fetchPipelineSeries,
  distribution: fetchDistributionSeries,
  growth: fetchGrowthSeries,
  'scrape-health': fetchScrapeHealthSeries,
} as const;

type MonthlyKind = keyof typeof MONTHLY;

export function useMonthlySeries<K extends MonthlyKind>(kind: K, period: Period | null) {
  return useQuery({
    queryKey: adminDataKeys.series(kind, period),
    queryFn: () => {
      const p = period!;
      return MONTHLY[kind](p.year, p.month, p.timezone) as Promise<Awaited<ReturnType<(typeof MONTHLY)[K]>>>;
    },
    enabled: period != null,
    staleTime: STALE,
  });
}

export function useUserActivitySeries(period: Period | null, userIds: string[], metrics: UserActivityMetric[]) {
  return useQuery({
    queryKey: adminDataKeys.series('user-activity', period, { userIds, metrics }),
    queryFn: () => fetchUserActivitySeries({ ...period!, user_ids: userIds, metrics }),
    enabled: period != null && userIds.length > 0 && metrics.length > 0,
    staleTime: STALE,
  });
}

export function usePlatformSeries(period: Period | null, platforms: string[] | null) {
  return useQuery({
    queryKey: adminDataKeys.series('platform-vs-applied', period, platforms),
    queryFn: () => fetchPlatformVsAppliedSeries({ ...period!, platforms }),
    enabled: period != null,
    staleTime: STALE,
  });
}
