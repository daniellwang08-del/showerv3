import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { ModalState, SubmittedUrlItem } from '../types/ui';
import { useJobsStore } from './jobsStore';
import { useUIStore } from './uiStore';

const tableToApiPath = (t: 'active' | 'duplicated') => (t === 'duplicated' ? 'invalid' : 'valid');

type ModalStoreState = {
  modal: ModalState;
  modalUrl: string;
  modalReason: string;
  modalDuplicateOf: string;
  modalSubmitting: boolean;
  modalError: string;

  setModalUrl: (v: string) => void;
  setModalReason: (v: string) => void;
  setModalDuplicateOf: (v: string) => void;

  openModal: (next: ModalState) => void;
  closeModal: () => void;
  confirmModal: () => Promise<void>;

  openEditModal: (item: SubmittedUrlItem) => void;
  openReportInvalidModal: (item: SubmittedUrlItem) => void;
  openReportDuplicateModal: (item: SubmittedUrlItem) => void;
  openDeleteModal: (item: SubmittedUrlItem) => void;
  openPromoteModal: (item: SubmittedUrlItem) => void;
  openReplaceModal: (invalidJobId: string, invalidUrl: string, validJobId: string, validUrl: string) => void;
};

export const useModalStore = create<ModalStoreState>((set, get) => ({
  modal: null,
  modalUrl: '',
  modalReason: '',
  modalDuplicateOf: '',
  modalSubmitting: false,
  modalError: '',

  setModalUrl: (v) => set({ modalUrl: v }),
  setModalReason: (v) => set({ modalReason: v }),
  setModalDuplicateOf: (v) => set({ modalDuplicateOf: v }),

  openModal: (next: ModalState) => {
    set({
      modal: next,
      modalError: '',
      modalSubmitting: false,
      modalUrl: next
        ? next.kind === 'replaceJob'
          ? next.invalidUrl
          : 'currentUrl' in next
            ? next.currentUrl
            : ''
        : '',
      modalReason: '',
      modalDuplicateOf: '',
    });
  },

  closeModal: () => {
    set({
      modal: null,
      modalError: '',
      modalSubmitting: false,
      modalUrl: '',
      modalReason: '',
      modalDuplicateOf: '',
    });
  },

  confirmModal: async () => {
    const { modal, modalUrl, modalReason, modalDuplicateOf, closeModal } = get();
    if (!modal) return;
    if (modal.kind === 'promoteInvalidToValid' && !modalReason.trim()) {
      set({ modalError: 'Please enter a reason' });
      return;
    }

    const jobs = useJobsStore.getState();
    const ui = useUIStore.getState();

    try {
      set({ modalSubmitting: true, modalError: '' });
      jobs.clearSubmitFeedback();

      if (modal.kind === 'promoteInvalidToValid') {
        const res = await apiClient.post<{ job_id: string }>(`/jobs/invalid/${modal.id}/promote-to-valid`, {
          reason: modalReason.trim(),
        });
        jobs.removeDuplicateUrlsByIds([modal.id]);
        await jobs.refreshLists({ showLoading: false, reset: true });
        const newId = res.data?.job_id;
        closeModal();
        if (newId) ui.setJobAnalysisValidJobId(newId);
        return;
      }

      if (modal.kind === 'edit') {
        const apiPath = tableToApiPath(modal.table);
        await apiClient.patch(`/jobs/${apiPath}/${modal.id}/url`, { url: modalUrl });
      }

      if (modal.kind === 'reportInvalid') {
        const apiPath = tableToApiPath(modal.table);
        await apiClient.post(`/jobs/${apiPath}/${modal.id}/report-invalid`, {
          duplication_reason: modalReason.trim() ? modalReason.trim() : null,
        });
      }

      if (modal.kind === 'reportDuplicate') {
        const apiPath = tableToApiPath(modal.table);
        await apiClient.post(`/jobs/${apiPath}/${modal.id}/report-duplicate`, {
          duplicate_of_job_id: modalDuplicateOf.trim() ? modalDuplicateOf.trim() : null,
          duplication_reason: modalReason.trim() ? modalReason.trim() : null,
        });
      }

      if (modal.kind === 'delete') {
        if (modal.table === 'duplicated') {
          await apiClient.post('/jobs/invalid/dismiss/batch', { user_job_status_ids: [modal.id] });
          jobs.removeDuplicateUrlsByIds([modal.id]);
        } else {
          await apiClient.delete(`/jobs/valid/${modal.id}`);
        }
      }

      if (modal.kind === 'replaceJob') {
        await apiClient.patch(`/jobs/valid/${modal.validJobId}/url`, { url: modal.invalidUrl });
        await apiClient.post('/jobs/invalid/dismiss/batch', { user_job_status_ids: [modal.invalidJobId] });
        jobs.removeDuplicateUrlsByIds([modal.invalidJobId]);
      }

      await jobs.refreshLists({ showLoading: false, reset: true });
      closeModal();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const msg = typeof detail === 'string' ? detail : 'Action failed';
      set({ modalError: msg });
    } finally {
      set({ modalSubmitting: false });
      ui.setOpenMenu(null);
    }
  },

  openEditModal: (item) =>
    get().openModal({ kind: 'edit', table: 'active', id: item.id, currentUrl: item.url }),

  openReportInvalidModal: (item) =>
    get().openModal({ kind: 'reportInvalid', table: 'active', id: item.id, currentUrl: item.url }),

  openReportDuplicateModal: (item) =>
    get().openModal({ kind: 'reportDuplicate', table: 'active', id: item.id, currentUrl: item.url }),

  openDeleteModal: (item) =>
    get().openModal({
      kind: 'delete',
      table: item.table ?? 'active',
      id: item.id,
      currentUrl: item.url,
    }),

  openPromoteModal: (item) =>
    get().openModal({ kind: 'promoteInvalidToValid', id: item.id, currentUrl: item.url }),

  openReplaceModal: (invalidJobId, invalidUrl, validJobId, validUrl) =>
    get().openModal({ kind: 'replaceJob', invalidJobId, invalidUrl, validJobId, validUrl }),
}));
