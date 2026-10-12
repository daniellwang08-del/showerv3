import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  syncJobSiteNow,
  updateJobSite,
  type JobSiteCatalog,
  type JobSiteConnection,
  type JobSitePlugin,
} from '@/api/jobSitesApi';
import { integrationKeys, invalidateJobSites } from './queries';
import { errorDetail, needsReconnect, resumeLabel } from './status';

export function upsertConnection(qc: ReturnType<typeof useQueryClient>, row: JobSiteConnection) {
  qc.setQueryData<JobSiteCatalog>(integrationKeys.jobSites, (prev) =>
    prev
      ? { ...prev, connections: [...prev.connections.filter((c) => c.plugin_slug !== row.plugin_slug), row] }
      : prev,
  );
}

/** Auto-sync toggle and Sync now for one connected site, plus the derived state both depend on. */
export function useJobSiteControls(plugin: JobSitePlugin, connection: JobSiteConnection) {
  const qc = useQueryClient();

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateJobSite(plugin.slug, { enabled }),
    onSuccess: (row) => {
      upsertConnection(qc, row);
      invalidateJobSites(qc);
      toast.success(row.enabled ? `Auto-sync resumed for ${plugin.name}` : `Auto-sync paused for ${plugin.name}`);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to update this job site.')),
  });

  const sync = useMutation({
    mutationFn: () => syncJobSiteNow(plugin.slug),
    onSuccess: () => {
      toast.success('Sync started', {
        description: 'Progress shows here and on the Jobs page. New jobs appear as they are scored.',
      });
      invalidateJobSites(qc);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to start the sync.')),
  });

  const enabled = toggle.isPending ? Boolean(toggle.variables) : connection.enabled;
  const state = connection.status ?? 'connected';
  const reauth = needsReconnect(connection);
  const resume = resumeLabel(connection.next_sync_at);
  const waiting = (state === 'rate_limited' || state === 'quota_exhausted') && Boolean(resume);
  // Scoring may still run after the fetch; only a fetch in flight blocks another one.
  const fetching = sync.isPending || connection.sync?.phase === 'queued' || connection.sync?.phase === 'fetching';

  return {
    toggle,
    sync,
    enabled,
    state,
    reauth,
    resume,
    waiting,
    fetching,
    canSync: enabled && !reauth && !waiting && !fetching,
    nextSync: enabled && !reauth ? resume : null,
  };
}
