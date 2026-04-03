import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { ModalState, SubmittedUrlItem } from '../types/ui';
import { useJobsStore } from './jobsStore';
import { useUIStore } from './uiStore';

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
        ? next.kind === 'replaceInvalid'
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
        const res = await apiClient.post<{ valid_job_id: string }>(`/jobs/invalid/${modal.id}/promote-to-valid`, {
          reason: modalReason.trim(),
        });
        await jobs.refreshLists({ showLoading: false, reset: true });
        const newId = res.data?.valid_job_id;
        closeModal();
        if (newId) ui.setJobAnalysisValidJobId(newId);
        return;
      }

      if (modal.kind === 'edit') {
        await apiClient.patch(`/jobs/${modal.table}/${modal.id}/url`, { url: modalUrl });
      }

      if (modal.kind === 'reportInvalid') {
        await apiClient.post(`/jobs/${modal.table}/${modal.id}/report-invalid`, {
          duplication_reason: modalReason.trim() ? modalReason.trim() : null,
        });
      }

      if (modal.kind === 'reportDuplicate') {
        await apiClient.post(`/jobs/${modal.table}/${modal.id}/report-duplicate`, {
          duplicate_of_job_id: modalDuplicateOf.trim() ? modalDuplicateOf.trim() : null,
          duplication_reason: modalReason.trim() ? modalReason.trim() : null,
        });
      }

      if (modal.kind === 'delete') {
        await apiClient.delete(`/jobs/${modal.table}/${modal.id}`);
      }

      if (modal.kind === 'replaceInvalid') {
        await apiClient.patch(`/jobs/valid/${modal.validJobId}/url`, { url: modal.invalidUrl });
        await apiClient.delete(`/jobs/invalid/${modal.invalidJobId}`);
      }

      await jobs.refreshLists({ showLoading: false, reset: true });
      closeModal();
    } catch (e: any) {
      set({ modalError: e.response?.data?.detail || 'Action failed' });
    } finally {
      set({ modalSubmitting: false });
      ui.setOpenMenu(null);
    }
  },

  openEditModal: (item) =>
    get().openModal({ kind: 'edit', table: 'valid', id: item.id, currentUrl: item.url }),

  openReportInvalidModal: (item) =>
    get().openModal({ kind: 'reportInvalid', table: 'valid', id: item.id, currentUrl: item.url }),

  openReportDuplicateModal: (item) =>
    get().openModal({ kind: 'reportDuplicate', table: 'valid', id: item.id, currentUrl: item.url }),

  openDeleteModal: (item) =>
    get().openModal({ kind: 'delete', table: item.table ?? 'valid', id: item.id, currentUrl: item.url }),

  openPromoteModal: (item) =>
    get().openModal({ kind: 'promoteInvalidToValid', id: item.id, currentUrl: item.url }),

  openReplaceModal: (invalidJobId, invalidUrl, validJobId, validUrl) =>
    get().openModal({ kind: 'replaceInvalid', invalidJobId, invalidUrl, validJobId, validUrl }),
}));
