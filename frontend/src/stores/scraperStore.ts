import { create } from 'zustand';
import type {
  DashboardJob,
  ScraperStats,
  SpiderInfo,
  SyncStatus,
  SyncProgress,
} from '../types/scraper';
import {
  fetchDashboardJobs,
  fetchDashboardCounts,
  fetchScraperStats,
  fetchScrapeRuns,
  fetchSpiders,
  fetchSyncStatus,
  triggerSync,
  type DashboardView,
  type DashboardCounts,
} from '../api/scraperApi';
import type { ScrapeRun } from '../types/scraper';
import { postJobsToSheet as postJobsToSheetApi } from '../api/googleSheetsApi';
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

function snapshotKey(jobIds: string[]): string {
  return [...jobIds].sort().join(',');
}

const _appliedRevertSnapshots = new Map<string, Map<string, AppliedSnapshot>>();

function mergeJobRowFromRefresh(local: DashboardJob, fresh: DashboardJob, now: number): DashboardJob {
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
}

/** Keep the user's current row order during silent refresh (marking applied must not jump rows). */
function mergeRefreshPreservingOrder(
  localJobs: DashboardJob[],
  freshItems: DashboardJob[],
  now: number,
): DashboardJob[] {
  const freshById = new Map(freshItems.map((j) => [j.id, j]));
  const merged: DashboardJob[] = [];

  for (const local of localJobs) {
    const fresh = freshById.get(local.id);
    if (!fresh) continue;
    merged.push(mergeJobRowFromRefresh(local, fresh, now));
    freshById.delete(local.id);
  }

  for (const fresh of freshItems) {
    if (freshById.has(fresh.id)) merged.push(fresh);
  }

  return merged;
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

/** Dashboard filter mutations requested by the AI agent (drives the main table). */
export interface AgentDashboardFilters {
  view?: DashboardView;
  remote_only?: boolean;
  min_match_score?: number;
  source?: string;
  query?: string;
  title?: string;
  company?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  /** Clear all filters back to defaults before applying the rest. */
  reset?: boolean;
}

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
  syncProgress: SyncProgress | null;

  /** Recent scrape runs, newest first - drives "last synced" timestamps. */
  lastSyncRuns: ScrapeRun[];

  sourceFilter: string;
  searchQuery: string;
  titleFilter: string;
  companyFilter: string;
  remoteOnly: boolean;
  /** Minimum match-score filter (0 = any). */
  minScore: number;
  sortField: string;
  sortOrder: 'asc' | 'desc';

  /** Active dashboard view tab. */
  view: DashboardView;
  /** Per-tab job counts for the view switcher badges. */
  counts: DashboardCounts;

  loadJobs: () => Promise<void>;
  /** Refresh per-tab counts for the view switcher. */
  loadCounts: () => Promise<void>;
  /** Switch the active view tab, resetting to page 1 and reloading. */
  setView: (view: DashboardView) => void;
  /** Refresh job rows silently (no loading spinner) - used for background polling. */
  bgRefreshJobs: () => Promise<void>;
  /** Reload dashboard from page 1 after manual job submit. */
  refreshAfterJobSubmit: () => Promise<void>;
  /**
   * Refresh dashboard stats.
   * Pass `{ silent: true }` for background refreshes (pipeline/poll events) so the
   * stats bar never flips into its skeleton state - which would unmount/remount
   * every tile and replay the count-up animation from 0 on each job-status change.
   */
  loadStats: (opts?: { silent?: boolean }) => Promise<void>;
  loadSpiders: () => Promise<void>;
  /** Refresh the recent scrape-run history used for "last synced" labels. */
  loadLastSyncRuns: () => Promise<void>;
  checkSyncStatus: () => Promise<void>;
  handleSyncWsEvent: (event: {
    type: string;
    spider_name?: string;
    current?: number;
    total?: number;
    items_scraped?: number;
    items_new?: number;
    elapsed_seconds?: number;
    success?: boolean;
    error?: string;
  }) => void;
  startSync: (spiderName?: string) => Promise<void>;

  rerunJob: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  deleteJob: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  batchDeleteJobs: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;
  batchRerunJobs: (jobIds: string[]) => Promise<{ ok: boolean; partial?: boolean; message: string }>;
  /** Instant UI update - call synchronously (e.g. inside flushSync) before persist. */
  optimisticMarkJobsApplied: (jobIds: string[], applied: boolean) => void;
  markJobsApplied: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;
  markJobsUnapplied: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;
  optimisticMarkJobsSheetPosted: (jobIds: string[]) => void;
  postJobsToSheet: (jobIds: string[]) => Promise<{ ok: boolean; message: string }>;

  setPage: (page: number) => void;
  setPerPage: (perPage: number) => void;
  setSourceFilter: (source: string) => void;
  setSearchQuery: (q: string) => void;
  setTitleFilter: (title: string) => void;
  setCompanyFilter: (company: string) => void;
  setRemoteOnly: (val: boolean) => void;
  setMinScore: (val: number) => void;
  setSort: (field: string) => void;
  /** Apply a batch of filter/view changes from the AI agent, then reload once. */
  applyAgentDashboard: (filters: AgentDashboardFilters) => void;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
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
  syncProgress: null,

  lastSyncRuns: [],

  sourceFilter: '',
  searchQuery: '',
  titleFilter: '',
  companyFilter: '',
  remoteOnly: false,
  minScore: 0,
  sortField: 'created_at',
  sortOrder: 'desc',

  view: 'today',
  counts: { all: 0, today: 0, mine: 0, suggested: 0 },

  loadJobs: async () => {
    const s = get();
    set({ loading: true });
    try {
      const result = await fetchDashboardJobs({
        page: s.page,
        per_page: s.perPage,
        source: s.sourceFilter || undefined,
        q: s.searchQuery || undefined,
        title: s.titleFilter || undefined,
        company: s.companyFilter || undefined,
        remote_only: s.remoteOnly || undefined,
        min_match_score: s.minScore || undefined,
        sort: s.sortField,
        order: s.sortOrder,
        view: s.view,
        timezone: localTimezone(),
      });
      set({ jobs: result.items, total: result.total, pages: result.pages, loading: false });
    } catch {
      set({ loading: false });
    }
    void get().loadCounts();
  },

  loadCounts: async () => {
    const s = get();
    try {
      const counts = await fetchDashboardCounts({
        source: s.sourceFilter || undefined,
        q: s.searchQuery || undefined,
        title: s.titleFilter || undefined,
        company: s.companyFilter || undefined,
        remote_only: s.remoteOnly || undefined,
        min_match_score: s.minScore || undefined,
        timezone: localTimezone(),
      });
      set({ counts });
    } catch {
      /* ignore */
    }
  },

  setView: (view) => {
    if (get().view === view) return;
    set({ view, page: 1 });
    get().loadJobs();
  },

  bgRefreshJobs: async () => {
    const s = get();
    try {
      const result = await fetchDashboardJobs({
        page: s.page,
        per_page: s.perPage,
        source: s.sourceFilter || undefined,
        q: s.searchQuery || undefined,
        title: s.titleFilter || undefined,
        company: s.companyFilter || undefined,
        remote_only: s.remoteOnly || undefined,
        min_match_score: s.minScore || undefined,
        sort: s.sortField,
        order: s.sortOrder,
        view: s.view,
        timezone: localTimezone(),
      });

      const now = Date.now();
      const localJobs = get().jobs;
      const freshIds = new Set(result.items.map((j) => j.id));

      const mergedJobs = mergeRefreshPreservingOrder(localJobs, result.items, now);

      const preserved = localJobs.filter((local) => {
        if (freshIds.has(local.id)) return false;
        const guardedAt = _rerunAt.get(local.id);
        return guardedAt != null && now - guardedAt < GUARD_MS;
      });

      set({ jobs: [...mergedJobs, ...preserved], total: result.total, pages: result.pages });
      void get().loadCounts();
    } catch {
      /* silently ignore poll errors */
    }
  },

  refreshAfterJobSubmit: async () => {
    set({ page: 1 });
    await get().loadJobs();
    void get().loadStats();
  },

  loadStats: async (opts) => {
    // Only show the skeleton on the very first load. Background refreshes keep the
    // existing tiles mounted so unchanged numbers don't flash / re-animate.
    if (!opts?.silent && get().stats === null) set({ statsLoading: true });
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

  loadLastSyncRuns: async () => {
    try {
      const runs = await fetchScrapeRuns(60);
      set({ lastSyncRuns: runs });
    } catch {
      /* ignore */
    }
  },

  checkSyncStatus: async () => {
    try {
      const status = await fetchSyncStatus();
      const running = status.status === 'running';
      set({
        syncStatus: status,
        syncing: running,
        syncProgress: running
          ? {
              spiderName: status.spider_name,
              current: get().syncProgress?.current ?? 0,
              total: get().syncProgress?.total ?? 0,
              itemsScraped: status.items_scraped ?? 0,
              itemsNew: status.items_new ?? 0,
              elapsedSeconds: status.elapsed_seconds ?? 0,
              message: status.message,
            }
          : null,
      });
    } catch {
      /* ignore */
    }
  },

  handleSyncWsEvent: (event) => {
    if (event.type === 'sync_started') {
      set({
        syncing: true,
        syncProgress: {
          spiderName: event.spider_name ?? null,
          current: 0,
          total: event.total ?? 0,
          itemsScraped: 0,
          itemsNew: 0,
          elapsedSeconds: 0,
          message: 'Sync queued…',
        },
      });
      return;
    }

    if (event.type === 'sync_spider_started') {
      const spider = event.spider_name ?? null;
      const current = event.current ?? 0;
      const total = event.total ?? 0;
      set({
        syncing: true,
        syncProgress: {
          spiderName: spider,
          current,
          total,
          itemsScraped: 0,
          itemsNew: 0,
          elapsedSeconds: 0,
          message: total > 0
            ? `Running ${spider ?? 'spider'} (${current}/${total})…`
            : `Running ${spider ?? 'spider'}…`,
        },
      });
      return;
    }

    if (event.type === 'sync_activity') {
      const prev = get().syncProgress;
      const spider = event.spider_name ?? prev?.spiderName ?? null;
      const itemsScraped = event.items_scraped ?? prev?.itemsScraped ?? 0;
      const itemsNew = event.items_new ?? prev?.itemsNew ?? 0;
      const elapsed = event.elapsed_seconds ?? prev?.elapsedSeconds ?? 0;
      const current = prev?.current ?? 0;
      const total = prev?.total ?? 0;
      set({
        syncing: true,
        syncProgress: {
          spiderName: spider,
          current,
          total,
          itemsScraped,
          itemsNew,
          elapsedSeconds: elapsed,
          message: `${spider ?? 'Spider'}: ${itemsScraped} scraped (${itemsNew} new) · ${elapsed}s`,
        },
      });
      return;
    }

    if (event.type === 'sync_progress') {
      const prev = get().syncProgress;
      const spider = event.spider_name ?? prev?.spiderName ?? null;
      const current = event.current ?? prev?.current ?? 0;
      const total = event.total ?? prev?.total ?? 0;
      const ok = event.success !== false;
      set({
        syncing: current < total,
        syncProgress: current < total
          ? {
              spiderName: spider,
              current,
              total,
              itemsScraped: prev?.itemsScraped ?? 0,
              itemsNew: prev?.itemsNew ?? 0,
              elapsedSeconds: prev?.elapsedSeconds ?? 0,
              message: ok
                ? `Finished ${spider ?? 'spider'} (${current}/${total})`
                : `${spider ?? 'Spider'} failed (${current}/${total})`,
            }
          : prev,
      });
      return;
    }

    if (event.type === 'sync_completed' || event.type === 'sync_failed') {
      set({
        syncing: false,
        syncProgress: null,
        syncStatus: {
          status: 'idle',
          spider_name: null,
          message: event.type === 'sync_completed'
            ? 'Sync completed.'
            : (event.error ? `Sync failed: ${event.error}` : 'Sync failed.'),
        },
      });
      void get().loadLastSyncRuns();
    }
  },

  startSync: async (spiderName = 'all') => {
    set({ syncing: true, syncProgress: { spiderName: spiderName, current: 0, total: 0, itemsScraped: 0, itemsNew: 0, elapsedSeconds: 0, message: 'Queueing sync…' } });
    try {
      const status = await triggerSync(spiderName);
      set({ syncStatus: status });
    } catch {
      set({ syncing: false, syncProgress: null });
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

  optimisticMarkJobsApplied: (jobIds, applied) => {
    const unique = [...new Set(jobIds.filter(Boolean))];
    if (unique.length === 0) return;

    const idSet = new Set(unique);
    const key = snapshotKey(unique);
    _appliedRevertSnapshots.set(key, snapshotAppliedFields(get().jobs, idSet));

    if (applied) {
      touchAppliedGuard(unique, 'applied');
      set({
        jobs: applyAppliedPatch(get().jobs, idSet, {
          applied_at: new Date().toISOString(),
          applied_by_name: null,
        }),
      });
      return;
    }

    touchAppliedGuard(unique, 'unapplied');
    set({
      jobs: applyAppliedPatch(get().jobs, idSet, {
        applied_at: null,
        applied_by_name: null,
      }),
    });
  },

  markJobsApplied: async (jobIds) => {
    const unique = [...new Set(jobIds.filter(Boolean))];
    if (unique.length === 0) {
      return { ok: false, message: 'No jobs to mark as applied.' };
    }

    const idSet = new Set(unique);
    const key = snapshotKey(unique);
    const snapshot = _appliedRevertSnapshots.get(key);

    try {
      const { data } = await apiClient.post<{
        marked: number;
        applied_by_name: string;
        applied_at?: string;
      }>('/jobs/valid/applied/batch', { job_ids: unique });

      _appliedRevertSnapshots.delete(key);
      touchAppliedGuard(unique, 'applied');

      const label = data.applied_by_name?.trim() ?? '';
      if (label) {
        set((state) => ({
          jobs: state.jobs.map((j) => {
            if (!idSet.has(j.id)) return j;
            if (j.applied_by_name === label) return j;
            return { ...j, applied_by_name: label };
          }),
        }));
      }

      const n = data.marked ?? unique.length;
      return {
        ok: true,
        message: `Marked ${n} job${n === 1 ? '' : 's'} as applied.`,
      };
    } catch (err) {
      _appliedRevertSnapshots.delete(key);
      clearAppliedGuard(unique);
      if (snapshot) {
        set({ jobs: restoreAppliedFields(get().jobs, snapshot, idSet) });
      }
      return { ok: false, message: extractErrorMessage(err, 'Failed to mark as applied.') };
    }
  },

  markJobsUnapplied: async (jobIds) => {
    const unique = [...new Set(jobIds.filter(Boolean))];
    if (unique.length === 0) {
      return { ok: false, message: 'No jobs to unmark.' };
    }

    const idSet = new Set(unique);
    const key = snapshotKey(unique);
    const snapshot = _appliedRevertSnapshots.get(key);

    try {
      const { data } = await apiClient.post<{ cleared: number }>(
        '/jobs/valid/unapplied/batch',
        { job_ids: unique },
      );

      _appliedRevertSnapshots.delete(key);
      touchAppliedGuard(unique, 'unapplied');

      const n = data.cleared ?? unique.length;
      return {
        ok: true,
        message: `Unmarked ${n} job${n === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      _appliedRevertSnapshots.delete(key);
      clearAppliedGuard(unique);
      if (snapshot) {
        set({ jobs: restoreAppliedFields(get().jobs, snapshot, idSet) });
      }
      return { ok: false, message: extractErrorMessage(err, 'Failed to unmark as applied.') };
    }
  },

  optimisticMarkJobsSheetPosted: (jobIds) => {
    const idSet = new Set(jobIds.filter(Boolean));
    if (idSet.size === 0) return;
    const now = new Date().toISOString();
    set({
      jobs: get().jobs.map((j) =>
        idSet.has(j.id) ? { ...j, sheet_posted_at: j.sheet_posted_at ?? now } : j,
      ),
    });
  },

  postJobsToSheet: async (jobIds) => {
    const unique = [...new Set(jobIds.filter(Boolean))];
    if (unique.length === 0) {
      return { ok: false, message: 'No jobs selected to post.' };
    }

    try {
      const data = await postJobsToSheetApi(unique);
      const posted = data.posted_count ?? 0;
      const partial = data.partial_count ?? 0;
      const failed = data.failed_count ?? 0;
      const alreadyInSheet = data.skipped_already_in_sheet ?? 0;
      const notFound = data.skipped_not_found ?? 0;

      const fullyPostedIds = (data.results ?? [])
        .map((row) => String(row.job_id ?? ''))
        .filter(Boolean);
      if (fullyPostedIds.length > 0) {
        get().optimisticMarkJobsSheetPosted(fullyPostedIds);
      }
      void get().bgRefreshJobs();

      const parts: string[] = [];
      if (posted > 0) parts.push(`Posted ${posted} job${posted === 1 ? '' : 's'} fully`);
      if (partial > 0) {
        parts.push(`${partial} partially posted (check tab names in Settings)`);
      }
      if (failed > 0) parts.push(`${failed} failed to post`);
      if (alreadyInSheet > 0) parts.push(`${alreadyInSheet} already in sheet`);
      if (notFound > 0) parts.push(`${notFound} not found`);

      if (parts.length > 0) {
        const ok = failed === 0 && partial === 0;
        return { ok, message: `${parts.join('; ')}.` };
      }
      return { ok: false, message: 'No jobs were posted to the Google Sheet.' };
    } catch (err) {
      return { ok: false, message: extractErrorMessage(err, 'Failed to post to Google Sheet.') };
    }
  },

  setPage: (page) => { set({ page }); get().loadJobs(); },
  setPerPage: (perPage) => { set({ perPage, page: 1 }); get().loadJobs(); },
  setSourceFilter: (source) => { set({ sourceFilter: source, page: 1 }); get().loadJobs(); },
  setSearchQuery: (q) => { set({ searchQuery: q, page: 1 }); get().loadJobs(); },
  setTitleFilter: (title) => { set({ titleFilter: title, page: 1 }); get().loadJobs(); },
  setCompanyFilter: (company) => { set({ companyFilter: company, page: 1 }); get().loadJobs(); },
  setRemoteOnly: (val) => { set({ remoteOnly: val, page: 1 }); get().loadJobs(); },
  setMinScore: (val) => {
    const clamped = Math.max(0, Math.min(100, Math.round(val)));
    set({ minScore: clamped, page: 1 });
    get().loadJobs();
  },
  setSort: (field) => {
    const s = get();
    const order = s.sortField === field && s.sortOrder === 'desc' ? 'asc' : 'desc';
    set({ sortField: field, sortOrder: order, page: 1 });
    get().loadJobs();
  },

  applyAgentDashboard: (f) => {
    const s = get();
    const cleared = f.reset === true;
    set({
      view: f.view ?? (cleared ? 'all' : s.view),
      remoteOnly: f.remote_only ?? (cleared ? false : s.remoteOnly),
      minScore: f.min_match_score ?? (cleared ? 0 : s.minScore),
      sourceFilter: f.source ?? (cleared ? '' : s.sourceFilter),
      searchQuery: f.query ?? (cleared ? '' : s.searchQuery),
      titleFilter: f.title ?? (cleared ? '' : s.titleFilter),
      companyFilter: f.company ?? (cleared ? '' : s.companyFilter),
      sortField: f.sort ?? (cleared ? 'created_at' : s.sortField),
      sortOrder: f.order ?? (cleared ? 'desc' : s.sortOrder),
      page: 1,
    });
    get().loadJobs();
  },
}));
