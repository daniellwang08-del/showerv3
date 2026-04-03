import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { SubmittedUrlItem } from '../types/ui';
import type { SubmissionResponse } from '../types';
import { parseServerDateTime } from '../utils/serverDate';
import { logger } from '../utils/logger';
import {
  JOB_PAGE_SIZE,
  mapInvalidJobRow,
  mapValidJobRow,
  mergeInvalidJobs,
  mergeValidJobs,
  type InvalidJobApiRow,
  type ValidJobApiRow,
} from '../utils/jobListPagination';
import { runWithConcurrencyLimit } from '../utils/asyncPool';
import type { AttachmentFlowStatus } from '../types/ui';

const ATTACHMENT_SUBMIT_CONCURRENCY = 30;

let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_DEBOUNCE_MS = 400;

type JobsState = {
  uniqueUrls: SubmittedUrlItem[];
  duplicateUrls: SubmittedUrlItem[];

  loadingLists: boolean;
  isInitialLoad: boolean;

  validNextOffset: number;
  validHasMore: boolean;
  loadingMoreValid: boolean;

  invalidNextOffset: number;
  invalidHasMore: boolean;
  loadingMoreInvalid: boolean;

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
  debouncedRefresh: () => void;
  loadMoreValidJobs: () => Promise<void>;
  loadMoreInvalidJobs: () => Promise<void>;

  submitJob: (submittedUrl: string) => Promise<void>;
  submitAttachmentFiles: (files: File[]) => Promise<void>;

  markApplied: (items: SubmittedUrlItem[]) => Promise<void>;
  markUnapplied: (items: SubmittedUrlItem[]) => Promise<void>;
  rescrapeJob: (item: SubmittedUrlItem) => Promise<void>;
  recordJobClick: (item: SubmittedUrlItem) => Promise<void>;
  openSelectedUrls: (items: SubmittedUrlItem[]) => Promise<void>;

  batchDeleteValid: (items: SubmittedUrlItem[]) => Promise<void>;
  openBatchDeleteConfirm: (items: SubmittedUrlItem[]) => void;
  closeBatchDeleteConfirm: () => void;
  executeBatchDeleteInvalid: () => Promise<void>;

  triggerJobMatch: (item: SubmittedUrlItem, opts?: { force?: boolean }) => Promise<void>;
  rerunMatchAnalysis: (items: SubmittedUrlItem[]) => Promise<void>;
  batchRescrapePipeline: (items: SubmittedUrlItem[]) => Promise<void>;

  updateValidJob: (id: string, patch: Partial<SubmittedUrlItem>) => void;
};

export const useJobsStore = create<JobsState>((set, get) => ({
  uniqueUrls: [],
  duplicateUrls: [],
  loadingLists: false,
  isInitialLoad: true,

  validNextOffset: 0,
  validHasMore: false,
  loadingMoreValid: false,

  invalidNextOffset: 0,
  invalidHasMore: false,
  loadingMoreInvalid: false,

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

      const [validRes, invalidRes] = await Promise.all([
        apiClient.get<ValidJobApiRow[]>(`/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=0`),
        apiClient.get<InvalidJobApiRow[]>(`/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=0`),
      ]);

      const mappedValid = (validRes.data ?? []).map((j) => mapValidJobRow(j));
      const mappedInvalid = (invalidRes.data ?? []).map((j) => mapInvalidJobRow(j));

      if (reset) {
        set({
          uniqueUrls: mappedValid,
          duplicateUrls: mappedInvalid,
          validNextOffset: mappedValid.length,
          validHasMore: mappedValid.length === JOB_PAGE_SIZE,
          invalidNextOffset: mappedInvalid.length,
          invalidHasMore: mappedInvalid.length === JOB_PAGE_SIZE,
        });
      } else {
        set((state) => ({
          uniqueUrls: mergeValidJobs(state.uniqueUrls, mappedValid),
          duplicateUrls: mergeInvalidJobs(state.duplicateUrls, mappedInvalid),
        }));
      }
      set({ isInitialLoad: false });
    } catch {
      // silent
    } finally {
      if (shouldShowLoading) set({ loadingLists: false });
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
      const res = await apiClient.get<ValidJobApiRow[]>(
        `/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=${validNextOffset}`,
      );
      const chunk = (res.data ?? []).map((j) => mapValidJobRow(j));
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
      const res = await apiClient.get<InvalidJobApiRow[]>(
        `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=${invalidNextOffset}`,
      );
      const chunk = (res.data ?? []).map((j) => mapInvalidJobRow(j));
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
                  table: 'invalid' as const,
                },
                ...state.duplicateUrls,
              ],
            }));
          }
        } else {
          set({ submitNotice: '' });
        }
        await get().refreshLists({ showLoading: false, reset: false });
      } else {
        set({ submitError: response.message || 'Error submitting job', submitNotice: '' });
      }

      if (response.success) {
        set({ url: '' });
      }
    } catch (error: any) {
      set({ submitError: error.response?.data?.detail || 'Error submitting job', submitNotice: '' });
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
      if (warnings?.length) {
        set({
          submitNoticeKind: 'warning',
          submitNotice: warnings.slice(0, 2).join(' \u00b7 ') + (warnings.length > 2 ? ' \u2026' : ''),
        });
      }
    } catch (error: any) {
      const msg = error.response?.data?.detail || 'Attachment processing failed';
      set({ submitError: msg });
      throw error;
    } finally {
      set({ loading: false, attachmentFlow: null });
    }
  },

  markApplied: async (items: SubmittedUrlItem[]) => {
    const valid_job_ids = [...new Set(items.filter((i) => i.table === 'valid').map((i) => i.id))];
    if (valid_job_ids.length === 0) return;
    try {
      const res = await apiClient.post<{ marked: number; applied_by_name: string; applied_at?: string }>(
        '/jobs/valid/applied/batch',
        { valid_job_ids },
      );
      const label = res.data?.applied_by_name?.trim() ?? '';
      const serverAt = res.data?.applied_at ? parseServerDateTime(res.data.applied_at) : undefined;
      const appliedMs = serverAt ?? Date.now();
      set((state) => ({
        uniqueUrls: state.uniqueUrls.map((job) =>
          valid_job_ids.includes(job.id)
            ? { ...job, appliedAt: appliedMs, appliedBy: label || job.appliedBy }
            : job,
        ),
      }));
      await get().refreshLists({ showLoading: false, reset: false });
    } catch (error: any) {
      set({ submitError: error.response?.data?.detail || 'Failed to save applied status' });
      throw error;
    }
  },

  markUnapplied: async (items: SubmittedUrlItem[]) => {
    const valid_job_ids = [...new Set(items.filter((i) => i.table === 'valid').map((i) => i.id))];
    if (valid_job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/unapplied/batch', { valid_job_ids });
      set((state) => ({
        uniqueUrls: state.uniqueUrls.map((job) =>
          valid_job_ids.includes(job.id) ? { ...job, appliedAt: undefined, appliedBy: undefined } : job,
        ),
      }));
      await get().refreshLists({ showLoading: false, reset: false });
    } catch (error: any) {
      set({ submitError: error.response?.data?.detail || 'Failed to clear applied status' });
      throw error;
    }
  },

  rescrapeJob: async (item: SubmittedUrlItem) => {
    try {
      await apiClient.post(`/jobs/valid/${item.id}/rescrape`, { url: item.url });
      await get().refreshLists({ showLoading: false, reset: false });
    } catch (error: any) {
      set({ submitError: error.response?.data?.detail || 'Failed to rescrape job' });
    }
  },

  recordJobClick: async (item: SubmittedUrlItem) => {
    if (item.table !== 'valid') return;
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
        if (item.table !== 'valid') return;
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

  batchDeleteValid: async (itemsToDelete: SubmittedUrlItem[]) => {
    logger.info('ui_batch_delete_started', { count: itemsToDelete.length });
    try {
      set({ loadingLists: true });
      for (const item of itemsToDelete) {
        const table = item.table || 'valid';
        try {
          await apiClient.delete(`/jobs/${table}/${item.id}`);
        } catch (error) {
          logger.error('ui_batch_delete_item_failed', { job_id: item.id, table, error: String(error) });
        }
      }
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
    set({ batchDeleteSubmitting: true, batchDeleteError: '' });
    try {
      await apiClient.post('/jobs/invalid/delete/batch', {
        invalid_job_ids: batchDeletePending.map((i) => i.id),
      });
      set({ batchDeletePending: null });
      await get().refreshLists({ showLoading: false, reset: true });
    } catch (error: any) {
      set({ batchDeleteError: error.response?.data?.detail || 'Failed to delete duplicate jobs' });
    } finally {
      set({ batchDeleteSubmitting: false });
    }
  },

  triggerJobMatch: async (item: SubmittedUrlItem, opts?: { force?: boolean }) => {
    try {
      await apiClient.post(`/jobs/valid/${item.id}/match`, null, {
        params: { force: opts?.force === true },
      });
      void get().refreshLists({ showLoading: false, reset: false });
    } catch {
      // ignore
    }
  },

  rerunMatchAnalysis: async (items: SubmittedUrlItem[]) => {
    const valid_job_ids = [...new Set(items.map((i) => i.id).filter(Boolean))];
    if (valid_job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/match/rerun', { valid_job_ids });
      void get().refreshLists({ showLoading: false, reset: false });
    } catch {
      // ignore
    }
  },

  batchRescrapePipeline: async (items: SubmittedUrlItem[]) => {
    const valid_job_ids = [...new Set(items.filter((i) => i.table === 'valid').map((i) => i.id))];
    if (valid_job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/rescrape/batch', { valid_job_ids });
      await get().refreshLists({ showLoading: false, reset: false });
    } catch (error: any) {
      set({ submitError: error.response?.data?.detail || 'Failed to queue re-scrape' });
    }
  },

  updateValidJob: (id: string, patch: Partial<SubmittedUrlItem>) => {
    set((state) => ({
      uniqueUrls: state.uniqueUrls.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    }));
  },
}));
