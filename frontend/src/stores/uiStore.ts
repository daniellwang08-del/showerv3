import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { SubmittedUrlItem } from '../types/ui';
import { useJobsStore } from './jobsStore';
import { useModalStore } from './modalStore';

type OpenMenu = { table: 'active' | 'duplicated'; id: string } | null;

export type NotificationKind = 'success' | 'warning' | 'error' | 'info';
export type Notification = {
  id: string;
  kind: NotificationKind;
  message: string;
};

type UIState = {
  openMenu: OpenMenu;
  compareValidJobId: string | null;
  pendingScrollValidJobId: string | null;
  jobAnalysisValidJobId: string | null;
  wsRefreshKey: number;
  notifications: Notification[];

  setOpenMenu: (menu: OpenMenu) => void;
  toggleMenu: (table: 'active' | 'duplicated', id: string) => void;
  setJobAnalysisValidJobId: (id: string | null) => void;
  closeDetail: () => void;
  bumpWsRefreshKey: () => void;

  notify: (kind: NotificationKind, message: string, autoDismissMs?: number) => void;
  dismissNotification: (id: string) => void;

  scrollToValidJob: (jobId: string) => void;
  clearPendingScroll: () => void;

  openJobAnalysis: (item: SubmittedUrlItem) => void;
  matchStored: () => void;

  compareDuplicate: (item: SubmittedUrlItem) => void;
  replaceDuplicate: (item: SubmittedUrlItem) => void;
};

let _notifCounter = 0;

export const useUIStore = create<UIState>((set, get) => ({
  openMenu: null,
  compareValidJobId: null,
  pendingScrollValidJobId: null,
  jobAnalysisValidJobId: null,
  wsRefreshKey: 0,
  notifications: [],

  setOpenMenu: (menu) => set({ openMenu: menu }),

  toggleMenu: (table, id) => {
    set((state) => {
      if (state.openMenu?.table === table && state.openMenu.id === id) {
        return { openMenu: null };
      }
      return { openMenu: { table, id } };
    });
  },

  setJobAnalysisValidJobId: (id) => set({ jobAnalysisValidJobId: id }),

  closeDetail: () => set({ jobAnalysisValidJobId: null }),

  bumpWsRefreshKey: () => set((s) => ({ wsRefreshKey: s.wsRefreshKey + 1 })),

  notify: (kind, message, autoDismissMs = 5000) => {
    const id = `notif-${++_notifCounter}`;
    set((s) => ({ notifications: [...s.notifications, { id, kind, message }] }));
    if (autoDismissMs > 0) {
      window.setTimeout(() => get().dismissNotification(id), autoDismissMs);
    }
  },

  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  scrollToValidJob: (jobId: string) => {
    set({ compareValidJobId: jobId, pendingScrollValidJobId: jobId });
    window.setTimeout(() => set({ compareValidJobId: null }), 3000);
  },

  clearPendingScroll: () => set({ pendingScrollValidJobId: null }),

  openJobAnalysis: (item) => {
    if (item.table === 'active' && item.extraction_id) {
      set({ jobAnalysisValidJobId: item.id });
    }
  },

  matchStored: () => {
    void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
  },

  compareDuplicate: (item) => {
    const targetId = item.duplicate_job_id;
    if (!targetId) {
      useJobsStore.setState({ submitError: 'Cannot compare: missing duplicate_job_id' });
      return;
    }
    const jobs = useJobsStore.getState();
    const inList = jobs.uniqueUrls.find((u) => u.id === targetId);
    if (inList) {
      get().scrollToValidJob(inList.id);
      return;
    }
    (async () => {
      try {
        const res = await apiClient.get(`/jobs/valid/${targetId}`);
        const job = res.data as { id: string; source_url: string };
        if (!job?.source_url) {
          useJobsStore.setState({ submitError: 'Cannot compare: original job not found in To do list' });
          return;
        }
        await jobs.refreshLists({ showLoading: false, reset: false });
        get().scrollToValidJob(targetId);
      } catch {
        useJobsStore.setState({ submitError: 'Cannot compare: original job not found in To do list' });
      }
    })();
  },

  replaceDuplicate: (item) => {
    const targetId = item.duplicate_job_id;
    if (!targetId) {
      useJobsStore.setState({ submitError: 'Cannot replace: missing duplicate_job_id' });
      return;
    }
    const jobs = useJobsStore.getState();
    const modal = useModalStore.getState();
    const inList = jobs.uniqueUrls.find((u) => u.id === targetId);
    if (inList) {
      modal.openReplaceModal(item.id, item.url, inList.id, inList.url);
      return;
    }
    (async () => {
      try {
        const res = await apiClient.get(`/jobs/valid/${targetId}`);
        const job = res.data as { id: string; source_url: string };
        if (!job?.source_url) {
          useJobsStore.setState({ submitError: 'Cannot replace: original job not found in To do list' });
          return;
        }
        modal.openReplaceModal(item.id, item.url, targetId, job.source_url);
      } catch {
        useJobsStore.setState({ submitError: 'Cannot replace: original job not found in To do list' });
      }
    })();
  },
}));
