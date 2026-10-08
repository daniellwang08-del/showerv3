import { create } from 'zustand';
import { toast } from 'sonner';
import {
  createJobAddBatch,
  fetchJobAddBatches,
  fetchJobAddShareTargets,
  updateJobAddBatchShare,
} from '@/api/jobAddBatchesApi';
import type { JobAddBatch, JobAddShareUser, JobAddSource } from '@/types/jobAdd';
import type { JobShareScope } from '@/types/settings';
import { extractApiErrorMessage } from '@/utils/profileErrors';

type JobAddState = {
  batches: JobAddBatch[];
  loaded: boolean;
  loading: boolean;
  targets: JobAddShareUser[];
  targetsLoaded: boolean;
  pickerBatchId: string | null;
  load: () => Promise<void>;
  loadTargets: () => Promise<void>;
  recordAfterSubmit: (jobIds: string[], source: JobAddSource) => Promise<JobAddBatch | null>;
  share: (batchId: string, share_scope: JobShareScope, user_ids?: string[]) => Promise<JobAddBatch | null>;
  openPicker: (batchId: string) => void;
  closePicker: () => void;
};

function upsertBatch(list: JobAddBatch[], next: JobAddBatch): JobAddBatch[] {
  const idx = list.findIndex((row) => row.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export const useJobAddStore = create<JobAddState>((set, get) => ({
  batches: [],
  loaded: false,
  loading: false,
  targets: [],
  targetsLoaded: false,
  pickerBatchId: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const batches = await fetchJobAddBatches();
      set({ batches, loaded: true });
    } catch {
      set({ loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  loadTargets: async () => {
    if (get().targetsLoaded) return;
    try {
      const targets = await fetchJobAddShareTargets();
      set({ targets, targetsLoaded: true });
    } catch {
      set({ targetsLoaded: true });
    }
  },

  recordAfterSubmit: async (jobIds, source) => {
    const ids = [...new Set(jobIds.filter(Boolean))];
    if (!ids.length) return null;
    try {
      const batch = await createJobAddBatch({ job_ids: ids, source });
      if (!batch) return null;
      set((s) => ({ batches: upsertBatch(s.batches, batch), loaded: true }));
      return batch;
    } catch {
      return null;
    }
  },

  share: async (batchId, share_scope, user_ids) => {
    try {
      const batch = await updateJobAddBatchShare(batchId, { share_scope, user_ids });
      set((s) => ({ batches: upsertBatch(s.batches, batch) }));
      void import('./jobsStore')
        .then(({ useJobsStore }) => useJobsStore.getState().refreshLists({ showLoading: false, reset: false }))
        .catch(() => undefined);
      return batch;
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Could not update who can see these jobs.'));
      return null;
    }
  },

  openPicker: (batchId) => {
    set({ pickerBatchId: batchId });
    void get().loadTargets();
  },

  closePicker: () => set({ pickerBatchId: null }),
}));
