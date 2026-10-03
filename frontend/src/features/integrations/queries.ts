import { useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchJobSites } from '@/api/jobSitesApi';
import { fetchSheetsConfig, fetchSheetsStatus } from '@/api/googleSheetsApi';
import { fetchPumbleConfig, fetchPumbleStatus } from '@/api/pumbleApi';
import type { PumbleData, SheetsData } from './status';

export const integrationKeys = {
  jobSites: ['integrations', 'job-sites'] as const,
  sheets: ['integrations', 'sheets'] as const,
  pumble: ['integrations', 'pumble'] as const,
  /** Read by the Jobs page (`useIntegrationTargets`) to offer "Post to…" actions. */
  jobsSheetsConfig: ['integrations', 'sheets-config'] as const,
  jobsPumbleConfig: ['integrations', 'pumble-config'] as const,
};

export function useJobSites() {
  return useQuery({ queryKey: integrationKeys.jobSites, queryFn: fetchJobSites });
}

export function useSheets() {
  return useQuery({
    queryKey: integrationKeys.sheets,
    queryFn: async (): Promise<SheetsData> => {
      const [status, config] = await Promise.all([fetchSheetsStatus(), fetchSheetsConfig()]);
      return { status, config };
    },
  });
}

export function usePumble() {
  return useQuery({
    queryKey: integrationKeys.pumble,
    queryFn: async (): Promise<PumbleData> => {
      const [status, config] = await Promise.all([fetchPumbleStatus(), fetchPumbleConfig()]);
      return { status, config };
    },
  });
}

export function invalidateSheets(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: integrationKeys.sheets });
  void qc.invalidateQueries({ queryKey: integrationKeys.jobsSheetsConfig });
}

export function invalidatePumble(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: integrationKeys.pumble });
  void qc.invalidateQueries({ queryKey: integrationKeys.jobsPumbleConfig });
}

export function invalidateJobSites(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: integrationKeys.jobSites });
}
