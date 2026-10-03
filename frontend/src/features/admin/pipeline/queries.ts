import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchAdminScraperStats, fetchDashboardJobs, fetchJobSyncSchedule } from '@/api/scraperApi';
import { fetchUserSettings } from '@/api/settingsApi';
import { fetchLlmModels, type ListFilters } from './pipelineApi';

/**
 * List and stats live under `['jobs', …]` so the app-wide websocket handler, which invalidates
 * `['jobs']` on every pipeline/sync event, refreshes them live.
 */
export const pipelineKeys = {
  root: ['jobs', 'admin-pipeline'] as const,
  stats: () => ['jobs', 'admin-pipeline', 'stats'] as const,
  lists: () => ['jobs', 'admin-pipeline', 'list'] as const,
  list: (params: ListFilters & { page: number; perPage: number }) => ['jobs', 'admin-pipeline', 'list', params] as const,
  schedule: () => ['admin-pipeline', 'sync-schedule'] as const,
  settings: () => ['admin-pipeline', 'llm-settings'] as const,
  models: () => ['admin-pipeline', 'llm-models'] as const,
};

const POLL_MS = 20_000;

export function useAdminStats(poll: boolean) {
  return useQuery({
    queryKey: pipelineKeys.stats(),
    queryFn: fetchAdminScraperStats,
    staleTime: 15_000,
    refetchInterval: poll ? POLL_MS : false,
  });
}

export function useAdminJobs(params: ListFilters & { page: number; perPage: number }, poll: boolean) {
  return useQuery({
    queryKey: pipelineKeys.list(params),
    queryFn: () =>
      fetchDashboardJobs({
        page: params.page,
        per_page: params.perPage,
        view: params.view,
        source: params.source || undefined,
        q: params.q || undefined,
        sort: params.sort,
        order: params.order,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    refetchInterval: poll ? POLL_MS : false,
  });
}

export function useSyncSchedule() {
  return useQuery({ queryKey: pipelineKeys.schedule(), queryFn: fetchJobSyncSchedule, staleTime: 60_000 });
}

export function useLlmSettings() {
  return useQuery({ queryKey: pipelineKeys.settings(), queryFn: fetchUserSettings, staleTime: 5 * 60_000 });
}

export function useLlmModels(enabled: boolean) {
  return useQuery({ queryKey: pipelineKeys.models(), queryFn: fetchLlmModels, enabled, staleTime: 5 * 60_000 });
}
