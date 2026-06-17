import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { SubmittedUrlItem } from '../types/ui';
import type { SubmissionResponse } from '../types';
import { parseServerDateTime } from '../utils/serverDate';
import { logger } from '../utils/logger';
import {
  JOB_PAGE_SIZE,
  mapDuplicatedJobRow,
  mapJobRow,
  mergeDuplicatedJobs,
  mergeActiveJobs,
  type DuplicatedJobApiRow,
  type JobApiRow,
} from '../utils/jobListPagination';
import { runWithConcurrencyLimit } from '../utils/asyncPool';
import type { AttachmentFlowStatus } from '../types/ui';
import { useScraperStore } from './scraperStore';

/** Extract a renderable error string from an Axios error (FastAPI 422 returns detail as an array of objects). */
function extractErrorMessage(err: any, fallback: string): string {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0];
    return typeof first === 'string' ? first : (first?.msg ?? fallback);
  }
  return fallback;
}

const ATTACHMENT_SUBMIT_CONCURRENCY = 30;

async function syncDashboardAfterSubmit(): Promise<void> {
  try {
    await useScraperStore.getState().refreshAfterJobSubmit();
  } catch {
    // Dashboard refresh is best-effort; jobsStore lists still updated separately.
  }
}

let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_DEBOUNCE_MS = 400;

type InvalidCounts = {
  duplicates: number;
  non_us: number;
  low_score: number;
  extraction_failed: number;
  total: number;
};

type JobsState = {
  uniqueUrls: SubmittedUrlItem[];
  duplicateUrls: SubmittedUrlItem[];
  nonUsUrls: SubmittedUrlItem[];
  lowScoreUrls: SubmittedUrlItem[];
  extractionFailedUrls: SubmittedUrlItem[];
  invalidCounts: InvalidCounts;

  loadingLists: boolean;
  isInitialLoad: boolean;

  validNextOffset: number;
  validHasMore: boolean;
  loadingMoreValid: boolean;

  invalidNextOffset: number;
  invalidHasMore: boolean;
  loadingMoreInvalid: boolean;

  nonUsNextOffset: number;
  nonUsHasMore: boolean;
  loadingMoreNonUs: boolean;

  lowScoreNextOffset: number;
  lowScoreHasMore: boolean;
  loadingMoreLowScore: boolean;

  extractionFailedNextOffset: number;
  extractionFailedHasMore: boolean;
  loadingMoreExtractionFailed: boolean;

  url: string;
  loading: boolean;
  submitError: string;
  submitNotice: string;
  submitNoticeKind: 'success' | 'warning';

  attachmentFlow: AttachmentFlowStatus;

  batchDeletePending: SubmittedUrlItem[] | null;
  batchDeleteSubmitting: boolean;
  batchDeleteError: string;

  setUrl: (url: string) => void;
  clearSubmitFeedback: () => void;

  refreshLists: (opts?: { showLoading?: boolean; reset?: boolean }) => Promise<void>;
  refreshValid: () => Promise<void>;
  refreshInvalidCounts: () => Promise<void>;
  debouncedRefresh: () => void;
  loadMoreValidJobs: () => Promise<void>;
  loadMoreInvalidJobs: () => Promise<void>;
  loadMoreNonUsJobs: () => Promise<void>;
  loadMoreLowScoreJobs: () => Promise<void>;
  loadMoreExtractionFailedJobs: () => Promise<void>;

  submitJob: (submittedUrl: string) => Promise<void>;
  submitAttachmentFiles: (files: File[]) => Promise<void>;

  markApplied: (items: SubmittedUrlItem[]) => Promise<void>;
  markUnapplied: (items: SubmittedUrlItem[]) => Promise<void>;
  rescrapeJob: (item: SubmittedUrlItem) => Promise<void>;
  recordJobClick: (item: SubmittedUrlItem) => Promise<void>;
  openSelectedUrls: (items: SubmittedUrlItem[]) => Promise<void>;

  /** Remove entries from invalid panels immediately (optimistic UI). */
  removeDuplicateUrlsByIds: (ids: string[]) => void;
  removeNonUsUrlsByIds: (ids: string[]) => void;
  removeLowScoreUrlsByIds: (ids: string[]) => void;
  removeExtractionFailedUrlsByIds: (ids: string[]) => void;

  batchDeleteValid: (items: SubmittedUrlItem[]) => Promise<void>;
  openBatchDeleteConfirm: (items: SubmittedUrlItem[]) => void;
  closeBatchDeleteConfirm: () => void;
  executeBatchDeleteInvalid: () => Promise<void>;

  triggerJobMatch: (item: SubmittedUrlItem, opts?: { force?: boolean }) => Promise<void>;
  rerunMatchAnalysis: (items: SubmittedUrlItem[]) => Promise<void>;
  batchRescrapePipeline: (items: SubmittedUrlItem[]) => Promise<void>;

  postToSheet: (items: SubmittedUrlItem[]) => Promise<void>;

  updateValidJob: (id: string, patch: Partial<SubmittedUrlItem>) => void;

  /** Remove a per-user policy exclusion so the job re-appears in the active pool. */
  restoreExcludedJob: (item: SubmittedUrlItem) => Promise<void>;
};

export const useJobsStore = create<JobsState>((set, get) => ({
  uniqueUrls: [],
  duplicateUrls: [],
  nonUsUrls: [],
  lowScoreUrls: [],
  extractionFailedUrls: [],
  invalidCounts: { duplicates: 0, non_us: 0, low_score: 0, extraction_failed: 0, total: 0 },
  loadingLists: false,
  isInitialLoad: true,

  validNextOffset: 0,
  validHasMore: false,
  loadingMoreValid: false,

  invalidNextOffset: 0,
  invalidHasMore: false,
  loadingMoreInvalid: false,

  nonUsNextOffset: 0,
  nonUsHasMore: false,
  loadingMoreNonUs: false,

  lowScoreNextOffset: 0,
  lowScoreHasMore: false,
  loadingMoreLowScore: false,

  extractionFailedNextOffset: 0,
  extractionFailedHasMore: false,
  loadingMoreExtractionFailed: false,

  url: '',
  loading: false,
  submitError: '',
  submitNotice: '',
  submitNoticeKind: 'success',

  attachmentFlow: null,

  batchDeletePending: null,
  batchDeleteSubmitting: false,
  batchDeleteError: '',

  setUrl: (url) => set({ url }),
  clearSubmitFeedback: () => set({ submitError: '', submitNotice: '' }),

  refreshLists: async (opts = {}) => {
    const showLoading = opts.showLoading !== false;
    const reset = opts.reset === true;
    const { isInitialLoad } = get();
    const shouldShowLoading = showLoading && isInitialLoad;

    try {
      if (shouldShowLoading) set({ loadingLists: true });

      const [validRes, invalidRes, nonUsRes, lowScoreRes, extractionFailedRes, countsRes] = await Promise.all([
        apiClient.get<JobApiRow[]>(`/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=0`),
        apiClient.get<DuplicatedJobApiRow[]>(
          `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=0&category=duplicates`,
        ),
        apiClient.get<DuplicatedJobApiRow[]>(
          `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=0&category=non_us`,
        ),
        apiClient.get<DuplicatedJobApiRow[]>(
          `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=0&category=low_score`,
        ),
        apiClient.get<DuplicatedJobApiRow[]>(
          `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=0&category=extraction_failed`,
        ),
        apiClient.get<InvalidCounts>('/jobs/invalid/counts'),
      ]);

      const mappedValid = (validRes.data ?? []).map((j) => mapJobRow(j));
      const mappedInvalid = (invalidRes.data ?? []).map((j) => mapDuplicatedJobRow(j));
      const mappedNonUs = (nonUsRes.data ?? []).map((j) => mapDuplicatedJobRow(j));
      const mappedLowScore = (lowScoreRes.data ?? []).map((j) => mapDuplicatedJobRow(j));
      const mappedExtractionFailed = (extractionFailedRes.data ?? []).map((j) => mapDuplicatedJobRow(j));
      const counts = countsRes.data ?? {
        duplicates: mappedInvalid.length,
        non_us: mappedNonUs.length,
        low_score: mappedLowScore.length,
        extraction_failed: mappedExtractionFailed.length,
        total: mappedInvalid.length + mappedNonUs.length + mappedLowScore.length + mappedExtractionFailed.length,
      };

      if (reset) {
        set({
          uniqueUrls: mappedValid,
          duplicateUrls: mappedInvalid,
          nonUsUrls: mappedNonUs,
          lowScoreUrls: mappedLowScore,
          extractionFailedUrls: mappedExtractionFailed,
          invalidCounts: counts,
          validNextOffset: mappedValid.length,
          validHasMore: mappedValid.length === JOB_PAGE_SIZE,
          invalidNextOffset: mappedInvalid.length,
          invalidHasMore: mappedInvalid.length === JOB_PAGE_SIZE,
          nonUsNextOffset: mappedNonUs.length,
          nonUsHasMore: mappedNonUs.length === JOB_PAGE_SIZE,
          lowScoreNextOffset: mappedLowScore.length,
          lowScoreHasMore: mappedLowScore.length === JOB_PAGE_SIZE,
          extractionFailedNextOffset: mappedExtractionFailed.length,
          extractionFailedHasMore: mappedExtractionFailed.length === JOB_PAGE_SIZE,
        });
      } else {
        set((state) => ({
          uniqueUrls: mergeActiveJobs(state.uniqueUrls, mappedValid),
          duplicateUrls: mergeDuplicatedJobs(state.duplicateUrls, mappedInvalid),
          nonUsUrls: mergeDuplicatedJobs(state.nonUsUrls, mappedNonUs),
          lowScoreUrls: mergeDuplicatedJobs(state.lowScoreUrls, mappedLowScore),
          extractionFailedUrls: mergeDuplicatedJobs(state.extractionFailedUrls, mappedExtractionFailed),
          invalidCounts: counts,
        }));
      }
      set({ isInitialLoad: false });
    } catch {
      // silent
    } finally {
      if (shouldShowLoading) set({ loadingLists: false });
    }
  },

  refreshValid: async () => {
    try {
      const [validRes, countsRes] = await Promise.all([
        apiClient.get<JobApiRow[]>(`/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=0`),
        apiClient.get<InvalidCounts>('/jobs/invalid/counts'),
      ]);
      const mappedValid = (validRes.data ?? []).map((j) => mapJobRow(j));
      const counts = countsRes.data;
      set((state) => ({
        uniqueUrls: mergeActiveJobs(state.uniqueUrls, mappedValid),
        ...(counts ? { invalidCounts: counts } : {}),
      }));
    } catch {
      // silent
    }
  },

  refreshInvalidCounts: async () => {
    try {
      const countsRes = await apiClient.get<InvalidCounts>('/jobs/invalid/counts');
      if (countsRes.data) set({ invalidCounts: countsRes.data });
    } catch {
      // silent
    }
  },

  debouncedRefresh: () => {
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      void get().refreshLists({ showLoading: false, reset: false });
    }, REFRESH_DEBOUNCE_MS);
  },

  loadMoreValidJobs: async () => {
    const { validHasMore, loadingMoreValid, validNextOffset } = get();
    if (!validHasMore || loadingMoreValid) return;
    set({ loadingMoreValid: true });
    try {
      const res = await apiClient.get<JobApiRow[]>(
        `/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=${validNextOffset}`,
      );
      const chunk = (res.data ?? []).map((j) => mapJobRow(j));
      if (chunk.length === 0) {
        set({ validHasMore: false });
        return;
      }
      set((state) => {
        const seen = new Set(state.uniqueUrls.map((j) => j.id));
        const merged = [...state.uniqueUrls];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return {
          uniqueUrls: merged.sort((a, b) => b.created_at_ms - a.created_at_ms),
          validNextOffset: state.validNextOffset + chunk.length,
          validHasMore: chunk.length === JOB_PAGE_SIZE,
        };
      });
    } catch {
      // silent
    } finally {
      set({ loadingMoreValid: false });
    }
  },

  loadMoreInvalidJobs: async () => {
    const { invalidHasMore, loadingMoreInvalid, invalidNextOffset } = get();
    if (!invalidHasMore || loadingMoreInvalid) return;
    set({ loadingMoreInvalid: true });
    try {
      const res = await apiClient.get<DuplicatedJobApiRow[]>(
        `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=${invalidNextOffset}&category=duplicates`,
      );
      const chunk = (res.data ?? []).map((j) => mapDuplicatedJobRow(j));
      if (chunk.length === 0) {
        set({ invalidHasMore: false });
        return;
      }
      set((state) => {
        const seen = new Set(state.duplicateUrls.map((j) => j.id));
        const merged = [...state.duplicateUrls];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return {
          duplicateUrls: merged.sort((a, b) => b.created_at_ms - a.created_at_ms),
          invalidNextOffset: state.invalidNextOffset + chunk.length,
          invalidHasMore: chunk.length === JOB_PAGE_SIZE,
        };
      });
    } catch {
      // silent
    } finally {
      set({ loadingMoreInvalid: false });
    }
  },

  loadMoreNonUsJobs: async () => {
    const { nonUsHasMore, loadingMoreNonUs, nonUsNextOffset } = get();
    if (!nonUsHasMore || loadingMoreNonUs) return;
    set({ loadingMoreNonUs: true });
    try {
      const res = await apiClient.get<DuplicatedJobApiRow[]>(
        `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=${nonUsNextOffset}&category=non_us`,
      );
      const chunk = (res.data ?? []).map((j) => mapDuplicatedJobRow(j));
      if (chunk.length === 0) {
        set({ nonUsHasMore: false });
        return;
      }
      set((state) => {
        const seen = new Set(state.nonUsUrls.map((j) => j.id));
        const merged = [...state.nonUsUrls];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return {
          nonUsUrls: merged.sort((a, b) => b.created_at_ms - a.created_at_ms),
          nonUsNextOffset: state.nonUsNextOffset + chunk.length,
          nonUsHasMore: chunk.length === JOB_PAGE_SIZE,
        };
      });
    } catch {
      // silent
    } finally {
      set({ loadingMoreNonUs: false });
    }
  },

  loadMoreLowScoreJobs: async () => {
    const { lowScoreHasMore, loadingMoreLowScore, lowScoreNextOffset } = get();
    if (!lowScoreHasMore || loadingMoreLowScore) return;
    set({ loadingMoreLowScore: true });
    try {
      const res = await apiClient.get<DuplicatedJobApiRow[]>(
        `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=${lowScoreNextOffset}&category=low_score`,
      );
      const chunk = (res.data ?? []).map((j) => mapDuplicatedJobRow(j));
      if (chunk.length === 0) {
        set({ lowScoreHasMore: false });
        return;
      }
      set((state) => {
        const seen = new Set(state.lowScoreUrls.map((j) => j.id));
        const merged = [...state.lowScoreUrls];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return {
          lowScoreUrls: merged.sort((a, b) => b.created_at_ms - a.created_at_ms),
          lowScoreNextOffset: state.lowScoreNextOffset + chunk.length,
          lowScoreHasMore: chunk.length === JOB_PAGE_SIZE,
        };
      });
    } catch {
      // silent
    } finally {
      set({ loadingMoreLowScore: false });
    }
  },

  loadMoreExtractionFailedJobs: async () => {
    const { extractionFailedHasMore, loadingMoreExtractionFailed, extractionFailedNextOffset } = get();
    if (!extractionFailedHasMore || loadingMoreExtractionFailed) return;
    set({ loadingMoreExtractionFailed: true });
    try {
      const res = await apiClient.get<DuplicatedJobApiRow[]>(
        `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=${extractionFailedNextOffset}&category=extraction_failed`,
      );
      const chunk = (res.data ?? []).map((j) => mapDuplicatedJobRow(j));
      if (chunk.length === 0) {
        set({ extractionFailedHasMore: false });
        return;
      }
      set((state) => {
        const seen = new Set(state.extractionFailedUrls.map((j) => j.id));
        const merged = [...state.extractionFailedUrls];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return {
          extractionFailedUrls: merged.sort((a, b) => b.created_at_ms - a.created_at_ms),
          extractionFailedNextOffset: state.extractionFailedNextOffset + chunk.length,
          extractionFailedHasMore: chunk.length === JOB_PAGE_SIZE,
        };
      });
    } catch {
      // silent
    } finally {
      set({ loadingMoreExtractionFailed: false });
    }
  },

  submitJob: async (submittedUrl: string) => {
    if (!submittedUrl) {
      set({ submitError: 'URL is required', submitNotice: '' });
      return;
    }
    try {
      set({ loading: true, submitNotice: '' });
      const axiosResponse = await apiClient.post<SubmissionResponse>('/jobs/submit', { url: submittedUrl });
      const response = axiosResponse.data;
      const { duplicateUrls } = get();
      const existedInInvalidList = !!response.job_id && duplicateUrls.some((d) => d.id === response.job_id);

      if (response.success) {
        set({ submitError: '' });
        if (response.is_duplicate) {
          set({
            submitNoticeKind: 'warning',
            submitNotice: existedInInvalidList
              ? 'This job link already exists in Check Required list.'
              : (response.message || 'Duplicate job detected.'),
          });
          if (response.job_id && !existedInInvalidList) {
            set((state) => ({
              duplicateUrls: [
                {
                  id: response.job_id!,
                  url: submittedUrl,
                  message: response.message || 'Duplicate job detected',
                  job_id: response.job_id,
                  duplicate_job_id: response.duplicate_job_id,
                  created_at_ms: Date.now(),
                  table: 'duplicated' as const,
                },
                ...state.duplicateUrls,
              ],
            }));
          }
        } else {
          set({ submitNotice: '' });
        }
        await get().refreshLists({ showLoading: false, reset: false });
        await syncDashboardAfterSubmit();
      } else {
        set({ submitError: response.message || 'Error submitting job', submitNotice: '' });
      }

      if (response.success) {
        set({ url: '' });
      }
    } catch (error: any) {
      set({ submitError: extractErrorMessage(error, 'Error submitting job'), submitNotice: '' });
    } finally {
      set({ loading: false });
    }
  },

  submitAttachmentFiles: async (files: File[]) => {
    if (!files.length) return;
    set({
      submitError: '',
      submitNotice: '',
      loading: true,
      attachmentFlow: {
        phase: 'upload_extract',
        message: 'Reading files and extracting job URLs with AI\u2026',
        submitted: 0,
        total: 0,
      },
    });
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      const res = await apiClient.post<{ urls: string[]; files_processed: number; warnings: string[] }>(
        '/jobs/attachment/extract-urls',
        formData,
      );
      const { urls, warnings } = res.data;
      if (!urls?.length) {
        set({ submitError: 'No job URLs found in the attachment.' });
        throw new Error('NO_URLS_IN_ATTACHMENT');
      }
      set({
        attachmentFlow: {
          phase: 'submitting',
          message: `Submitting ${urls.length} job URL${urls.length === 1 ? '' : 's'}\u2026`,
          submitted: 0,
          total: urls.length,
        },
      });
      await runWithConcurrencyLimit(
        urls,
        ATTACHMENT_SUBMIT_CONCURRENCY,
        async (u) => {
          await apiClient.post<SubmissionResponse>('/jobs/submit', { url: u });
        },
        (done, tot) => {
          set({
            attachmentFlow: {
              phase: 'submitting',
              message: `Submitting job URLs (${done}/${tot})\u2026`,
              submitted: done,
              total: tot,
            },
          });
        },
      );
      await get().refreshLists({ showLoading: false, reset: false });
      await syncDashboardAfterSubmit();
      if (warnings?.length) {
        set({
          submitNoticeKind: 'warning',
          submitNotice: warnings.slice(0, 2).join(' \u00b7 ') + (warnings.length > 2 ? ' \u2026' : ''),
        });
      }
    } catch (error: any) {
      const msg = extractErrorMessage(error, 'Attachment processing failed');
      set({ submitError: msg });
      throw error;
    } finally {
      set({ loading: false, attachmentFlow: null });
    }
  },

  markApplied: async (items: SubmittedUrlItem[]) => {
    const job_ids = [...new Set(items.filter((i) => i.table === 'active').map((i) => i.id))];
    if (job_ids.length === 0) return;
    try {
      const res = await apiClient.post<{ marked: number; applied_by_name: string; applied_at?: string }>(
        '/jobs/valid/applied/batch',
        { job_ids },
      );
      const label = res.data?.applied_by_name?.trim() ?? '';
      const serverAt = res.data?.applied_at ? parseServerDateTime(res.data.applied_at) : undefined;
      const appliedMs = serverAt ?? Date.now();
      set((state) => ({
        uniqueUrls: state.uniqueUrls.map((job) =>
          job_ids.includes(job.id)
            ? { ...job, appliedAt: appliedMs, appliedBy: label || job.appliedBy }
            : job,
        ),
      }));
    } catch (error: any) {
      set({ submitError: extractErrorMessage(error, 'Failed to save applied status') });
      throw error;
    }
  },

  markUnapplied: async (items: SubmittedUrlItem[]) => {
    const job_ids = [...new Set(items.filter((i) => i.table === 'active').map((i) => i.id))];
    if (job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/unapplied/batch', { job_ids });
      set((state) => ({
        uniqueUrls: state.uniqueUrls.map((job) =>
          job_ids.includes(job.id) ? { ...job, appliedAt: undefined, appliedBy: undefined } : job,
        ),
      }));
    } catch (error: any) {
      set({ submitError: extractErrorMessage(error, 'Failed to clear applied status') });
      throw error;
    }
  },

  rescrapeJob: async (item: SubmittedUrlItem) => {
    try {
      await apiClient.post(`/jobs/valid/${item.id}/rescrape`, { url: item.url });
      await get().refreshValid();
    } catch (error: any) {
      set({ submitError: extractErrorMessage(error, 'Failed to rescrape job') });
    }
  },

  recordJobClick: async (item: SubmittedUrlItem) => {
    if (item.table !== 'active') return;
    const jobId = item.id;
    const prevCount = item.click_count ?? 0;
    set((state) => ({
      uniqueUrls: state.uniqueUrls.map((u) => (u.id === jobId ? { ...u, click_count: prevCount + 1 } : u)),
    }));
    try {
      const res = await apiClient.post<{ click_count: number }>(`/jobs/valid/${jobId}/click`);
      const serverCount = res.data?.click_count ?? prevCount + 1;
      set((state) => ({
        uniqueUrls: state.uniqueUrls.map((u) => (u.id === jobId ? { ...u, click_count: serverCount } : u)),
      }));
    } catch {
      // keep optimistic
    }
  },

  openSelectedUrls: async (items: SubmittedUrlItem[]) => {
    if (!items.length) return;
    const uniqueItems = items.filter(
      (item, index, arr) => arr.findIndex((x) => x.url === item.url) === index,
    );
    uniqueItems.forEach((item) => {
      window.open(item.url, '_blank', 'noopener,noreferrer');
    });

    set((state) => ({
      uniqueUrls: state.uniqueUrls.map((job) => {
        const opened = uniqueItems.find((item) => item.id === job.id);
        if (!opened) return job;
        return { ...job, click_count: (job.click_count ?? 0) + 1 };
      }),
    }));

    await Promise.all(
      uniqueItems.map(async (item) => {
        if (item.table !== 'active') return;
        try {
          const res = await apiClient.post<{ click_count: number }>(`/jobs/valid/${item.id}/click`);
          const serverCount = res.data?.click_count;
          if (typeof serverCount !== 'number') return;
          set((state) => ({
            uniqueUrls: state.uniqueUrls.map((job) => (job.id === item.id ? { ...job, click_count: serverCount } : job)),
          }));
        } catch {
          // keep optimistic
        }
      }),
    );
  },

  removeDuplicateUrlsByIds: (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((state) => ({
      duplicateUrls: state.duplicateUrls.filter((d) => !idSet.has(d.id)),
      invalidCounts: {
        ...state.invalidCounts,
        duplicates: Math.max(0, state.invalidCounts.duplicates - ids.length),
        total: Math.max(0, state.invalidCounts.total - ids.length),
      },
    }));
  },

  removeNonUsUrlsByIds: (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((state) => ({
      nonUsUrls: state.nonUsUrls.filter((d) => !idSet.has(d.id)),
      invalidCounts: {
        ...state.invalidCounts,
        non_us: Math.max(0, state.invalidCounts.non_us - ids.length),
        total: Math.max(0, state.invalidCounts.total - ids.length),
      },
    }));
  },

  removeLowScoreUrlsByIds: (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((state) => ({
      lowScoreUrls: state.lowScoreUrls.filter((d) => !idSet.has(d.id)),
      invalidCounts: {
        ...state.invalidCounts,
        low_score: Math.max(0, state.invalidCounts.low_score - ids.length),
        total: Math.max(0, state.invalidCounts.total - ids.length),
      },
    }));
  },

  removeExtractionFailedUrlsByIds: (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((state) => ({
      extractionFailedUrls: state.extractionFailedUrls.filter((d) => !idSet.has(d.id)),
      invalidCounts: {
        ...state.invalidCounts,
        extraction_failed: Math.max(0, state.invalidCounts.extraction_failed - ids.length),
        total: Math.max(0, state.invalidCounts.total - ids.length),
      },
    }));
  },

  batchDeleteValid: async (itemsToDelete: SubmittedUrlItem[]) => {
    logger.info('ui_batch_delete_started', { count: itemsToDelete.length });
    try {
      set({ loadingLists: true });
      const validIds = itemsToDelete.filter((i) => i.table === 'active').map((i) => i.id);
      const invalidIds = itemsToDelete.filter((i) => i.table === 'duplicated').map((i) => i.id);

      const requests: Promise<unknown>[] = [];
      if (validIds.length > 0) {
        requests.push(apiClient.post('/jobs/valid/delete/batch', { job_ids: validIds }));
      }
      if (invalidIds.length > 0) {
        requests.push(apiClient.post('/jobs/invalid/dismiss/batch', { user_job_status_ids: invalidIds }));
      }
      await Promise.all(requests);
      await get().refreshLists({ showLoading: false, reset: true });
    } catch (error) {
      logger.error('ui_batch_delete_failed', { error: String(error) });
      set({ submitError: 'Error deleting jobs' });
    } finally {
      set({ loadingLists: false });
    }
  },

  openBatchDeleteConfirm: (items: SubmittedUrlItem[]) => {
    if (items.length === 0) return;
    set({ batchDeleteError: '', batchDeletePending: items });
  },

  closeBatchDeleteConfirm: () => {
    if (get().batchDeleteSubmitting) return;
    set({ batchDeletePending: null, batchDeleteError: '' });
  },

  executeBatchDeleteInvalid: async () => {
    const { batchDeletePending } = get();
    if (!batchDeletePending?.length) return;

    const idsToRemove = batchDeletePending.map((i) => i.id);
    set({ batchDeleteSubmitting: true, batchDeleteError: '' });

    try {
      await apiClient.post('/jobs/invalid/dismiss/batch', {
        user_job_status_ids: idsToRemove,
      });

      get().removeDuplicateUrlsByIds(idsToRemove);
      get().removeNonUsUrlsByIds(idsToRemove);
      get().removeLowScoreUrlsByIds(idsToRemove);
      get().removeExtractionFailedUrlsByIds(idsToRemove);
      set({ batchDeletePending: null });
      await get().refreshLists({ showLoading: false, reset: true });
    } catch (error: any) {
      set({ batchDeleteError: extractErrorMessage(error, 'Failed to dismiss duplicate jobs') });
    } finally {
      set({ batchDeleteSubmitting: false });
    }
  },

  triggerJobMatch: async (item: SubmittedUrlItem, opts?: { force?: boolean }) => {
    try {
      await apiClient.post(`/jobs/valid/${item.id}/match`, null, {
        params: { force: opts?.force === true },
      });
      void get().refreshValid();
    } catch {
      // ignore
    }
  },

  rerunMatchAnalysis: async (items: SubmittedUrlItem[]) => {
    const job_ids = [...new Set(items.map((i) => i.id).filter(Boolean))];
    if (job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/match/rerun', { job_ids });
      void get().refreshValid();
    } catch {
      // ignore
    }
  },

  batchRescrapePipeline: async (items: SubmittedUrlItem[]) => {
    const job_ids = [...new Set(items.filter((i) => i.table === 'active').map((i) => i.id))];
    if (job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/rescrape/batch', { job_ids });
      await get().refreshValid();
    } catch (error: any) {
      set({ submitError: extractErrorMessage(error, 'Failed to queue re-scrape') });
    }
  },

  postToSheet: async (items: SubmittedUrlItem[]) => {
    const job_ids = [...new Set(items.filter((i) => i.table === 'active').map((i) => i.id))];
    if (job_ids.length === 0) return;

    const { useUIStore } = await import('./uiStore');
    const notify = useUIStore.getState().notify;

    try {
      const { data } = await apiClient.post('/sheets/post-jobs', { job_ids });
      const posted: number = data.posted_count ?? 0;
      const alreadyInSheet: number = data.skipped_already_in_sheet ?? 0;

      if (posted > 0 && alreadyInSheet === 0) {
        notify('success', `Posted ${posted} job${posted > 1 ? 's' : ''} to Google Sheet`);
      } else if (posted > 0 && alreadyInSheet > 0) {
        notify('warning', `${posted} job${posted > 1 ? 's' : ''} posted newly, ${alreadyInSheet} already in the sheet — skipped.`);
      } else if (posted === 0 && alreadyInSheet > 0) {
        notify('info', `${alreadyInSheet === 1 ? 'This job is' : `All ${alreadyInSheet} jobs are`} already in the sheet.`);
      } else {
        notify('warning', 'No jobs were posted to the sheet.');
      }

      await get().refreshValid();
    } catch (error: any) {
      notify('error', extractErrorMessage(error, 'Failed to post to Google Sheet'), 8000);
    }
  },

  restoreExcludedJob: async (item: SubmittedUrlItem) => {
    const jobId = item.valid_job_id_for_restore;
    if (!jobId) return;
    const { useUIStore: _uiStore } = await import('./uiStore');
    const notify = _uiStore.getState().notify;
    try {
      await apiClient.delete(`/jobs/user-exclusions/${jobId}`);
      if (item.exclusion_type === 'below_min_score') {
        get().removeLowScoreUrlsByIds([item.id]);
      } else if (item.exclusion_type === 'non_us_location') {
        get().removeNonUsUrlsByIds([item.id]);
      } else if (item.exclusion_type === 'extraction_failed') {
        get().removeExtractionFailedUrlsByIds([item.id]);
      } else {
        get().removeDuplicateUrlsByIds([item.id]);
      }
      notify('success', 'Job restored to your active pool');
      void get().refreshValid();
    } catch (err: any) {
      notify('error', extractErrorMessage(err, 'Failed to restore job'));
    }
  },

  updateValidJob: (id: string, patch: Partial<SubmittedUrlItem>) => {
    set((state) => ({
      uniqueUrls: state.uniqueUrls.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    }));
  },
}));
