import { useQuery } from '@tanstack/react-query';
import { fetchDashboardJobs, fetchScraperStats, type DashboardView } from '@/api/scraperApi';

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const jobKeys = {
  all: ['jobs'] as const,
  stats: () => ['jobs', 'stats'] as const,
  list: (params: Record<string, unknown>) => ['jobs', 'list', params] as const,
};

/** `memberId` reads a member of a team space the caller leads. */
export function useJobStats(memberId?: string) {
  return useQuery({
    queryKey: memberId ? [...jobKeys.stats(), 'member', memberId] : jobKeys.stats(),
    queryFn: () => fetchScraperStats(memberId),
    staleTime: 60_000,
  });
}

export function useJobList(params: {
  view?: DashboardView;
  sort?: string;
  order?: 'asc' | 'desc';
  per_page?: number;
  min_match_score?: number;
}) {
  return useQuery({
    queryKey: jobKeys.list(params),
    queryFn: () => fetchDashboardJobs({ ...params, timezone: timezone() }),
    staleTime: 30_000,
  });
}
