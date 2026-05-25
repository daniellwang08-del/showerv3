import { create } from 'zustand';
import type {
  DashboardJob,
  ScraperStats,
  SpiderInfo,
  SyncStatus,
} from '../types/scraper';
import {
  fetchDashboardJobs,
  fetchScraperStats,
  fetchSpiders,
  fetchSyncStatus,
  triggerSync,
} from '../api/scraperApi';
import { apiClient } from '../api/client';
import { toFiniteTimeMs } from '../utils/serverDate';

// ---------------------------------------------------------------------------
// Stale-poll guard
// ---------------------------------------------------------------------------
// When the user clicks "Run / Rerun" we optimistically set extraction_status
// to 'pending' in the store.  Any bgRefreshJobs call that was already in-flight
// at that moment will return data that pre-dates our optimistic update.  We
// track each rerun timestamp and, for the next GUARD_MS milliseconds, always
// prefer the more advanced status so a stale server response can never wipe
// the user's visual feedback.
const _rerunAt = new Map<string, number>();
const GUARD_MS = 12_000;

type AppliedGuardMode = 'applied' | 'unapplied';
const _appliedGuard = new Map<string, { at: number; mode: AppliedGuardMode }>();
const APPLIED_GUARD_MS = 20_000;

type AppliedSnapshot = Pick<DashboardJob, 'applied_at' | 'applied_by_name'>;

function isAppliedRow(j: Pick<DashboardJob, 'applied_at'>): boolean {
  return toFiniteTimeMs(j.applied_at) != null;
}

function touchAppliedGuard(jobIds: Iterable<string>, mode: AppliedGuardMode) {
  const at = Date.now();
  for (const id of jobIds) _appliedGuard.set(id, { at, mode });
}

function clearAppliedGuard(jobIds: Iterable<string>) {
  for (const id of jobIds) _appliedGuard.delete(id);
}

function snapshotAppliedFields(jobs: DashboardJob[], idSet: Set<string>): Map<string, AppliedSnapshot> {
  return new Map(
    jobs
      .filter((j) => idSet.has(j.id))
      .map((j) => [j.id, { applied_at: j.applied_at, applied_by_name: j.applied_by_name }]),
  );
}

function restoreAppliedFields(jobs: DashboardJob[], snapshot: Map<string, AppliedSnapshot>, idSet: Set<string>) {
  return jobs.map((j) => {
    if (!idSet.has(j.id)) return j;
    const prev = snapshot.get(j.id);
    return prev ? { ...j, ...prev } : j;
  });
}

/** Prefer optimistic applied/unapplied state while a batch mark is still in flight. */
function mergeAppliedFromLocal(local: DashboardJob, fresh: DashboardJob, now: number): DashboardJob {
  const guard = _appliedGuard.get(fresh.id);
  if (!guard || now - guard.at >= APPLIED_GUARD_MS) return fresh;

  const localApplied = isAppliedRow(local);
  const freshApplied = isAppliedRow(fresh);

  if (guard.mode === 'applied') {
    if (localApplied && !freshApplied) {
      return {
        ...fresh,
        applied_at: local.applied_at,
        applied_by_name: local.applied_by_name ?? fresh.applied_by_name,
      };
    }
    if (freshApplied) clearAppliedGuard([fresh.id]);
  } else if (!localApplied && freshApplied) {
    return { ...fresh, applied_at: null, applied_by_name: null };
  } else if (!freshApplied) {
    clearAppliedGuard([fresh.id]);
  }

  return fresh;
}

function applyAppliedPatch(
  jobs: DashboardJob[],
  idSet: Set<string>,
  patch: AppliedSnapshot,
): DashboardJob[] {
  return jobs.map((j) => (idSet.has(j.id) ? { ...j, ...patch } : j));
}

// STATUS_RANK is keyed on lowercase values.  Always call .toLowerCase() before
// looking up so we tolerate the backend returning the PostgreSQL ENUM labels in
// their original uppercase form (PENDING, PROCESSING, EXTRACTED, COMPLETED).
const STATUS_RANK: Record<string, number> = {
  pending: 1,
  processing: 2,
  extracted: 3,
  completed: 4,
};
const statusRank = (s: string | null | undefined): number =>
  STATUS_RANK[(s ?? '').toLowerCase()] ?? 0;

interface ScraperState {
  jobs: DashboardJob[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
  loading: boolean;

  stats: ScraperStats | null;
  statsLoading: boolean;

  spiders: SpiderInfo[];

  syncStatus: SyncStatus | null;
  syncing: boolean;

  sourceFilter: string;
  searchQuery: string;
  remoteOnly: boolean;
  sortField: string;
  sortOrder: 'asc' | 'desc';

  loadJobs: () => Promise<void>;
  /** Refresh job rows silently (no loading spinner) — used for background polling. */
  bgRefreshJobs: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadSpiders: () => Promise<void>;
  checkSyncStatus: () => Promise<void>;
  startSync: (spiderName?: string) => Promise<void>;

  rerunJob: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  deleteJob: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  batchDeleteJobs: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;
  batchRerunJobs: (jobIds: string[]) => Promise<{ ok: boolean; partial?: boolean; message: string }>;
  markJobsApplied: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;
  markJobsUnapplied: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;

  setPage: (page: number) => void;
  setPerPage: (perPage: number) => void;
  setSourceFilter: (source: string) => void;
  setSearchQuery: (q: string) => void;
  setRemoteOnly: (val: boolean) => void;
  setSort: (field: string) => void;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const anyErr = err as { response?: { data?: { detail?: string } }; message?: string };
    const detail = anyErr.response?.data?.detail;
    if (detail) return String(detail);
    if (anyErr.message) return String(anyErr.message);
  }
  return fallback;
}

export const useScraperStore = create<ScraperState>((set, get) => ({
  jobs: [],
  total: 0,
  page: 1,
  perPage: 50,
  pages: 1,
  loading: false,

  stats: null,
  statsLoading: false,

  spiders: [],

  syncStatus: null,
  syncing: false,

  sourceFilter: '',
  searchQuery: '',
  remoteOnly: false,
  sortField: 'match_score',
  sortOrder: 'desc',

  loadJobs: async () => {
    const s = get();
    set({ loading: true });
    try {
      const result = await fetchDashboardJobs({
        page: s.page,
        per_page: s.perPage,
        source: s.sourceFilter || undefined,
        q: s.searchQuery || undefined,
        remote_only: s.remoteOnly || undefined,
        sort: s.sortField,
        order: s.sortOrder,
      });
      set({ jobs: result.items, total: result.total, pages: result.pages, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  bgRefreshJobs: async () => {
    const s = get();
    try {
      const result = await fetchDashboardJobs({
        page: s.page,
        per_page: s.perPage,
        source: s.sourceFilter || undefined,
        q: s.searchQuery || undefined,
        remote_only: s.remoteOnly || undefined,
        sort: s.sortField,
        order: s.sortOrder,
      });

      const now = Date.now();
      const localJobs = get().jobs;
      const freshIds = new Set(result.items.map((j) => j.id));

      const mergedJobs = result.items.map((fresh) => {
        const local = localJobs.find((j) => j.id === fresh.id);
        if (!local) return fresh;
        let merged = fresh;
        const guardedAt = _rerunAt.get(fresh.id);
        if (guardedAt && now - guardedAt < GUARD_MS) {
          const localRnk = statusRank(local.extraction_status);
          const freshRnk = statusRank(fresh.extraction_status);
          if (localRnk > freshRnk) {
            merged = {
              ...fresh,
              extraction_status: local.extraction_status,
              extraction_id: local.extraction_id ?? fresh.extraction_id,
            };
          }
        }
        return mergeAppliedFromLocal(local, merged, now);
      });

      const preserved = localJobs.filter((local) => {
        if (freshIds.has(local.id)) return false;
        const guardedAt = _rerunAt.get(local.id);
        return guardedAt != null && now - guardedAt < GUARD_MS;
      });

      set({ jobs: [...mergedJobs, ...preserved], total: result.total, pages: result.pages });
    } catch {
      /* silently ignore poll errors */
    }
  },

  loadStats: async () => {
    set({ statsLoading: true });
    try {
      const stats = await fetchScraperStats();
      set({ stats, statsLoading: false });
    } catch {
      set({ statsLoading: false });
    }
  },

  loadSpiders: async () => {
    try {
      const spiders = await fetchSpiders();
      set({ spiders });
    } catch {
      /* ignore */
    }
  },

  checkSyncStatus: async () => {
    try {
      const status = await fetchSyncStatus();
      set({ syncStatus: status, syncing: status.status === 'running' });
    } catch {
      /* ignore */
    }
  },

  startSync: async (spiderName = 'all') => {
    set({ syncing: true });
    try {
      const status = await triggerSync(spiderName);
      set({ syncStatus: status });
    } catch {
      set({ syncing: false });
    }
  },

  rerunJob: async (jobId: string) => {
    const job = get().jobs.find((j) => j.id === jobId);
    const url = (job?.source_url ?? '').trim();
    if (!url) {
      return { ok: false, message: 'This job has no URL to rescrape.' };
    }
    try {
      const { data: res } = await apiClient.post(`/jobs/valid/${jobId}/rescrape`, { url });
      _rerunAt.set(jobId, Date.now());
      set({
        jobs: get().jobs.map((j) =>
          j.id === jobId
            ? {
                ...j,
                extraction_id: res.extraction_id ?? j.extraction_id,
                extraction_status: 'pending' as const,
              }
            : j,
        ),
      });
      return { ok: true, message: res.message || 'Rerun queued.' };
    } catch (err) {
      return { ok: false, message: extractErrorMessage(err, 'Failed to rerun extraction.') };
    }
  },

  deleteJob: async (jobId: string) => {
    try {
      await apiClient.delete(`/jobs/valid/${jobId}`);
      const s = get();
      const newTotal = Math.max(0, s.total - 1);
      const isLastOnPage = s.jobs.length === 1 && s.page > 1;
      set({
        jobs: s.jobs.filter((j) => j.id !== jobId),
        total: newTotal,
        ...(isLastOnPage ? { page: s.page - 1 } : {}),
      });
      void get().loadJobs();
      void get().loadStats();
      return { ok: true, message: 'Deleted.' };
    } catch (err) {
      return { ok: false, message: extractErrorMessage(err, 'Failed to delete job.') };
    }
  },

  batchDeleteJobs: async (jobIds: string[]) => {
    try {
      const results = await Promise.allSettled(
        jobIds.map((id) => apiClient.delete(`/jobs/valid/${id}`)),
      );
      const succeeded = jobIds.filter((_, i) => results[i].status === 'fulfilled');
      const deletedSet = new Set(succeeded);
      const s = get();
      const newTotal = Math.max(0, s.total - succeeded.length);
      const remainingOnPage = s.jobs.filter((j) => !deletedSet.has(j.id)).length;
      const isPageEmpty = remainingOnPage === 0 && s.page > 1;
      set({
        jobs: s.jobs.filter((j) => !deletedSet.has(j.id)),
        total: newTotal,
        ...(isPageEmpty ? { page: s.page - 1 } : {}),
      });
      void get().loadJobs();
      void get().loadStats();
      const failed = jobIds.length - succeeded.length;
      return {
        ok: failed === 0,
        message: failed === 0
          ? `Deleted ${succeeded.length} jobs.`
          : `Deleted ${succeeded.length}, failed ${failed}.`,
      };
    } catch (err) {
      return { ok: false, message: extractErrorMessage(err, 'Batch delete failed.') };
    }
  },

  batchRerunJobs: async (jobIds: string[]) => {
    const unique = [...new Set(jobIds)];
    const BATCH_LIMIT = 200;
    const enqueuedIds: string[] = [];
    const skipped: { id: string; reason: string }[] = [];

    try {
      for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
        const chunk = unique.slice(i, i + BATCH_LIMIT);
        const { data: res } = await apiClient.post<{
          status: string;
          enqueued: number;
          jobs: { job_id: string; extraction_id: string }[];
          skipped: { id: string; reason: string }[];
        }>('/jobs/valid/rescrape/batch', { job_ids: chunk });

        for (const j of res.jobs ?? []) {
          enqueuedIds.push(j.job_id);
        }
        for (const s of res.skipped ?? []) {
          skipped.push(s);
        }
      }

      const queuedSet = new Set(enqueuedIds);
      set({
        jobs: get().jobs.map((j) =>
          queuedSet.has(j.id) ? { ...j, extraction_status: 'pending' as const } : j,
        ),
      });

      const allOk = skipped.length === 0 && enqueuedIds.length === unique.length;
      const anyOk = enqueuedIds.length > 0;
      const msg =
        skipped.length === 0
          ? `Queued ${enqueuedIds.length} job${enqueuedIds.length === 1 ? '' : 's'} for rerun.`
          : `Queued ${enqueuedIds.length}, skipped ${skipped.length}.`;

      return {
        ok: allOk,
        partial: !allOk && anyOk,
        message: msg,
      };
    } catch (err) {
      return { ok: false, partial: false, message: extractErrorMessage(err, 'Batch rerun failed.') };
    }
  },

  markJobsApplied: async (jobIds: string[]) => {
    const unique = [...new Set(jobIds.filter(Boolean))];
    if (unique.length === 0) {
      return { ok: false, message: 'No jobs to mark as applied.' };
    }

    const idSet = new Set(unique);
    const snapshot = snapshotAppliedFields(get().jobs, idSet);
    const optimisticAt = new Date().toISOString();

    touchAppliedGuard(unique, 'applied');
    set({
      jobs: applyAppliedPatch(get().jobs, idSet, {
        applied_at: optimisticAt,
        applied_by_name: null,
      }),
    });

    try {
      const { data } = await apiClient.post<{
        marked: number;
        applied_by_name: string;
        applied_at?: string;
      }>('/jobs/valid/applied/batch', { job_ids: unique });
      const appliedAt = data.applied_at ?? optimisticAt;
      const label = data.applied_by_name?.trim() ?? '';
      touchAppliedGuard(unique, 'applied');
      set({
        jobs: applyAppliedPatch(get().jobs, idSet, {
          applied_at: appliedAt,
          applied_by_name: label || null,
        }),
      });
      const n = data.marked ?? unique.length;
      return {
        ok: true,
        message: `Marked ${n} job${n === 1 ? '' : 's'} as applied.`,
      };
    } catch (err) {
      clearAppliedGuard(unique);
      set({ jobs: restoreAppliedFields(get().jobs, snapshot, idSet) });
      return { ok: false, message: extractErrorMessage(err, 'Failed to mark as applied.') };
    }
  },

  markJobsUnapplied: async (jobIds: string[]) => {
    const unique = [...new Set(jobIds.filter(Boolean))];
    if (unique.length === 0) {
      return { ok: false, message: 'No jobs to unmark.' };
    }

    const idSet = new Set(unique);
    const snapshot = snapshotAppliedFields(get().jobs, idSet);

    touchAppliedGuard(unique, 'unapplied');
    set({
      jobs: applyAppliedPatch(get().jobs, idSet, {
        applied_at: null,
        applied_by_name: null,
      }),
    });

    try {
      const { data } = await apiClient.post<{ cleared: number }>(
        '/jobs/valid/unapplied/batch',
        { job_ids: unique },
      );
      touchAppliedGuard(unique, 'unapplied');
      const n = data.cleared ?? unique.length;
      return {
        ok: true,
        message: `Unmarked ${n} job${n === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      clearAppliedGuard(unique);
      set({ jobs: restoreAppliedFields(get().jobs, snapshot, idSet) });
      return { ok: false, message: extractErrorMessage(err, 'Failed to unmark as applied.') };
    }
  },

  setPage: (page) => { set({ page }); get().loadJobs(); },
  setPerPage: (perPage) => { set({ perPage, page: 1 }); get().loadJobs(); },
  setSourceFilter: (source) => { set({ sourceFilter: source, page: 1 }); get().loadJobs(); },
  setSearchQuery: (q) => { set({ searchQuery: q, page: 1 }); get().loadJobs(); },
  setRemoteOnly: (val) => { set({ remoteOnly: val, page: 1 }); get().loadJobs(); },
  setSort: (field) => {
    const s = get();
    const order = s.sortField === field && s.sortOrder === 'desc' ? 'asc' : 'desc';
    set({ sortField: field, sortOrder: order, page: 1 });
    get().loadJobs();
  },
}));
