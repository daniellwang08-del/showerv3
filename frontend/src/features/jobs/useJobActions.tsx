import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchSheetsConfig } from '@/api/googleSheetsApi';
import { fetchPumbleConfig } from '@/api/pumbleApi';
import { applyViaExtension, detectExtension } from '@/lib/extensionBridge';
import { useScraperStore } from '@/stores/scraperStore';
import type { DashboardJob } from '@/types/scraper';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { JobActionId, JobMenuContext } from './jobMenu';
import { isApplyReady } from './jobStatus';

const PumbleDestinationModal = lazy(() =>
  import('@/components/scraper/PumbleDestinationModal').then((m) => ({ default: m.PumbleDestinationModal })),
);
const InstallExtensionModal = lazy(() =>
  import('@/components/scraper/InstallExtensionModal').then((m) => ({ default: m.InstallExtensionModal })),
);

type Result = { ok: boolean; partial?: boolean; message: string };

function notify(res: Result) {
  if (res.ok) toast.success(res.message);
  else if (res.partial) toast.warning(res.message);
  else toast.error(res.message);
}

export function useIntegrationTargets() {
  const sheets = useQuery({
    queryKey: ['integrations', 'sheets-config'],
    queryFn: fetchSheetsConfig,
    staleTime: 5 * 60_000,
  });
  const pumble = useQuery({
    queryKey: ['integrations', 'pumble-config'],
    queryFn: fetchPumbleConfig,
    staleTime: 5 * 60_000,
  });
  const pumbleIntegrations = (pumble.data?.integrations ?? []).filter((i) => i.is_enabled !== false);
  return {
    sheetsConfigured: Boolean(sheets.data?.configured),
    pumbleConfigured: pumbleIntegrations.length > 0 || Boolean(pumble.data?.configured),
    pumbleIntegrations,
  };
}

interface Options {
  openJob: (job: DashboardJob) => void;
  /** Called after any action that should drop the current selection. */
  onDone?: () => void;
}

/** Every row/bulk job action plus the dialogs they need, backed by the scraper store. */
export function useJobActions({ openJob, onDone }: Options) {
  const integrations = useIntegrationTargets();
  const [postingToSheet, setPostingToSheet] = useState(false);
  const [postingToPumble, setPostingToPumble] = useState(false);
  const [deleting, setDeleting] = useState<DashboardJob[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [pumbleTargets, setPumbleTargets] = useState<DashboardJob[] | null>(null);
  const [installFor, setInstallFor] = useState<DashboardJob | null>(null);
  const [rerunning, setRerunning] = useState<Set<string>>(() => new Set());
  const applyInFlight = useRef<string | null>(null);

  const apply = useCallback(async (job: DashboardJob) => {
    if (!isApplyReady(job)) {
      toast.warning('Finish match analysis and documents before applying.');
      return;
    }
    if (applyInFlight.current) return;
    applyInFlight.current = job.id;
    // Dispatch inside the click turn so the extension may open its side panel.
    const ack = applyViaExtension(job.id, job.source_url);
    try {
      if (await ack) {
        toast.success('Sent to the Job Application Assistant');
        return;
      }
      const info = await detectExtension();
      if (info.installed) {
        toast.warning('Extension is installed but this tab is not connected. Reload the page and try again.');
      } else {
        setInstallFor(job);
      }
    } finally {
      applyInFlight.current = null;
    }
  }, []);

  const prepare = useCallback(async (targets: DashboardJob[]) => {
    if (targets.length === 0) return;
    const ids = targets.map((t) => t.id);
    setRerunning((prev) => new Set([...prev, ...ids]));
    try {
      const store = useScraperStore.getState();
      const res =
        targets.length === 1
          ? await store.rerunJob(targets[0].id, { forceRescrape: false })
          : await store.batchRerunJobs(ids);
      notify(res);
      onDone?.();
    } finally {
      setRerunning((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [onDone]);

  const setApplied = useCallback((targets: DashboardJob[], applied: boolean) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;
    const store = useScraperStore.getState();
    flushSync(() => store.optimisticMarkJobsApplied(ids, applied));
    onDone?.();
    void (applied ? store.markJobsApplied(ids) : store.markJobsUnapplied(ids)).then((res) => {
      notify(res);
      const next = useScraperStore.getState();
      if (!res.ok) {
        next.optimisticMarkJobsApplied(ids, !applied);
        return;
      }
      // Applied state moves rows between views (e.g. off "Applied"), so re-read list and counts.
      void next.bgRefreshJobs();
      void next.loadCounts();
      void next.loadStats({ silent: true, isAdmin: false });
    });
  }, [onDone]);

  const postToSheet = useCallback((targets: DashboardJob[]) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;
    const store = useScraperStore.getState();
    flushSync(() => store.optimisticMarkJobsSheetPosted(ids));
    onDone?.();
    setPostingToSheet(true);
    void store.postJobsToSheet(ids).then((res) => {
      setPostingToSheet(false);
      notify(res);
      if (!res.ok) void useScraperStore.getState().bgRefreshJobs();
    });
  }, [onDone]);

  const executePumble = useCallback((targets: DashboardJob[], integrationIds?: string[]) => {
    const ids = targets.map((t) => t.id);
    if (ids.length === 0) return;
    const store = useScraperStore.getState();
    flushSync(() => store.optimisticMarkJobsPumblePosted(ids));
    onDone?.();
    setPostingToPumble(true);
    void store.postJobsToPumble(ids, integrationIds).then((res) => {
      setPostingToPumble(false);
      notify(res);
      if (!res.ok) void useScraperStore.getState().bgRefreshJobs();
    });
  }, [onDone]);

  const postToPumble = useCallback((targets: DashboardJob[]) => {
    if (targets.length === 0) return;
    const enabled = integrations.pumbleIntegrations;
    if (enabled.length > 1) {
      setPumbleTargets(targets);
      return;
    }
    executePumble(targets, enabled.length === 1 ? [enabled[0].id] : undefined);
  }, [executePumble, integrations.pumbleIntegrations]);

  const openUrls = useCallback((targets: DashboardJob[]) => {
    for (const t of targets) {
      if (t.source_url) window.open(t.source_url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const copyUrl = useCallback((job: DashboardJob) => {
    void navigator.clipboard.writeText(job.source_url).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy link'),
    );
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    const store = useScraperStore.getState();
    const res =
      deleting.length === 1
        ? await store.deleteJob(deleting[0].id)
        : await store.batchDeleteJobs(deleting.map((j) => j.id));
    setDeleteBusy(false);
    notify(res);
    if (res.ok) {
      setDeleting(null);
      onDone?.();
    }
  }, [deleting, onDone]);

  const run = useCallback(
    (id: JobActionId, targets: DashboardJob[]) => {
      switch (id) {
        case 'apply': return void apply(targets[0]);
        case 'open': return openJob(targets[0]);
        case 'open-url': return openUrls(targets);
        case 'copy-url': return copyUrl(targets[0]);
        case 'mark-applied': return setApplied(targets, true);
        case 'unmark-applied': return setApplied(targets, false);
        case 'post-sheet': return postToSheet(targets);
        case 'post-pumble': return postToPumble(targets);
        case 'prepare': return void prepare(targets);
        case 'delete': return setDeleting(targets);
      }
    },
    [apply, openJob, openUrls, copyUrl, setApplied, postToSheet, postToPumble, prepare],
  );

  const menuContext: JobMenuContext = {
    sheetsConfigured: integrations.sheetsConfigured,
    pumbleConfigured: integrations.pumbleConfigured,
    postingToSheet,
    postingToPumble,
  };

  const deleteCount = deleting?.length ?? 0;
  const dialogs = (
    <>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !deleteBusy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteCount > 1 ? `Delete ${deleteCount} jobs?` : 'Delete this job?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCount > 1
                ? 'They will be removed from your list along with their analysis and generated documents.'
                : `"${deleting?.[0]?.title || 'Untitled role'}" will be removed along with its analysis and generated documents.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleteBusy} onClick={() => void confirmDelete()}>
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Suspense fallback={null}>
        {pumbleTargets && (
          <PumbleDestinationModal
            open
            integrations={integrations.pumbleIntegrations}
            jobCount={pumbleTargets.length}
            posting={postingToPumble}
            onClose={() => setPumbleTargets(null)}
            onConfirm={(integrationIds) => {
              const targets = pumbleTargets;
              setPumbleTargets(null);
              if (integrationIds.length > 0) executePumble(targets, integrationIds);
            }}
          />
        )}
        {installFor && (
          <InstallExtensionModal
            open
            onClose={() => setInstallFor(null)}
            onInstalled={() => {
              const job = installFor;
              setInstallFor(null);
              void apply(job);
            }}
          />
        )}
      </Suspense>
    </>
  );

  return { run, menuContext, rerunning, dialogs };
}
