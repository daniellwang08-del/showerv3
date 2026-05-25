import { ModalState } from '../types/ui';
import { Edit2, XCircle, Copy, Trash2, RefreshCw, ClipboardCheck } from 'lucide-react';

type Props = {
  modal: ModalState;
  modalUrl: string;
  onModalUrlChange: (next: string) => void;
  modalReason: string;
  onModalReasonChange: (next: string) => void;
  modalDuplicateOf: string;
  onModalDuplicateOfChange: (next: string) => void;
  modalSubmitting: boolean;
  modalError: string;
  onClose: () => void;
  onConfirm: () => void;
};

export function JobActionModal({
  modal,
  modalUrl,
  onModalUrlChange,
  modalReason,
  onModalReasonChange,
  modalDuplicateOf,
  onModalDuplicateOfChange,
  modalSubmitting,
  modalError,
  onClose,
  onConfirm,
}: Props) {
  if (!modal) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-blue-950/30 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-card w-full max-w-lg rounded-2xl border border-blue-200/70 bg-white/90 shadow-2xl">
        <div className="border-b border-blue-200/60 px-5 py-4">
          <div className="flex items-center gap-2 text-base font-bold text-slate-900">
            {modal.kind === 'edit' && <Edit2 className="h-5 w-5 text-blue-600" />}
            {modal.kind === 'reportInvalid' && <XCircle className="h-5 w-5 text-red-600" />}
            {modal.kind === 'reportDuplicate' && <Copy className="h-5 w-5 text-orange-600" />}
            {modal.kind === 'delete' && <Trash2 className="h-5 w-5 text-red-600" />}
            {modal.kind === 'replaceInvalid' && <RefreshCw className="h-5 w-5 text-purple-600" />}
            {modal.kind === 'promoteInvalidToValid' && <ClipboardCheck className="h-5 w-5 text-emerald-600" />}
            <span>
              {modal.kind === 'edit' && 'Edit job URL'}
              {modal.kind === 'reportInvalid' && 'Report as invalid job'}
              {modal.kind === 'reportDuplicate' && 'Report as duplicated job'}
              {modal.kind === 'delete' && 'Delete job'}
              {modal.kind === 'replaceInvalid' && 'Replace job URL'}
              {modal.kind === 'promoteInvalidToValid' && 'Report as valid job'}
            </span>
          </div>
          {modal.kind !== 'replaceInvalid' && 'currentUrl' in modal && (
            <div className="mt-1 truncate text-xs text-slate-600" title={modal.currentUrl}>
              {modal.currentUrl}
            </div>
          )}
        </div>

        <div className="px-5 py-4">
          {modal.kind === 'edit' && (
            <div>
              <label className="block text-sm font-semibold text-slate-900">New URL</label>
              <input
                value={modalUrl}
                onChange={(e) => onModalUrlChange(e.target.value)}
                className="blue-outline-input mt-2 block w-full bg-white px-3 py-2 text-sm text-slate-900 outline-none"
                placeholder="https://..."
                autoFocus
              />
            </div>
          )}

          {modal.kind === 'reportInvalid' && (
            <div>
              <label className="block text-sm font-semibold text-slate-900">Reason (optional)</label>
              <input
                value={modalReason}
                onChange={(e) => onModalReasonChange(e.target.value)}
                className="blue-outline-input mt-2 block w-full bg-white px-3 py-2 text-sm text-slate-900 outline-none"
                placeholder="Why is this invalid?"
                autoFocus
              />
            </div>
          )}

          {modal.kind === 'reportDuplicate' && (
            <div className="grid gap-3">
              <div>
                <label className="block text-sm font-semibold text-slate-900">Duplicate of job_id (optional)</label>
                <input
                  value={modalDuplicateOf}
                  onChange={(e) => onModalDuplicateOfChange(e.target.value)}
                  className="blue-outline-input mt-2 block w-full bg-white px-3 py-2 text-sm text-slate-900 outline-none"
                  placeholder="UUID"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-900">Reason (optional)</label>
                <input
                  value={modalReason}
                  onChange={(e) => onModalReasonChange(e.target.value)}
                  className="blue-outline-input mt-2 block w-full bg-white px-3 py-2 text-sm text-slate-900 outline-none"
                  placeholder="Why is this duplicated?"
                />
              </div>
            </div>
          )}

          {modal.kind === 'delete' && (
            <div className="text-sm leading-relaxed text-slate-700">
              {modal.table === 'invalid' ? (
                <>
                  This removes the duplicate entry from your list. Inactive job rows and orphan extraction data tied to
                  this URL are removed when nothing else references them. This cannot be undone.
                </>
              ) : (
                <>
                  This removes the job from your To do list. AI match data for this job is deleted, and stored
                  extraction text is removed when no other job shares it. This cannot be undone.
                </>
              )}
            </div>
          )}

          {modal.kind === 'replaceInvalid' && (
            <div className="grid gap-3 text-sm text-slate-700">
              <div>
                <div className="text-xs font-semibold text-slate-900">Original (in To do list)</div>
                <div className="mt-1 break-all border border-blue-200 bg-blue-50 p-2 text-xs">{modal.validUrl}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-900">Replace with (duplicated link)</div>
                <div className="mt-1 break-all border border-orange-200 bg-orange-50 p-2 text-xs">{modal.invalidUrl}</div>
              </div>
              <div className="text-xs text-slate-600">This will update the original job URL and then delete this duplicated entry.</div>
            </div>
          )}

          {modal.kind === 'promoteInvalidToValid' && (
            <div>
              <label className="block text-sm font-semibold text-slate-900">Reason</label>
              <p className="mt-1 text-xs text-slate-500">
                Shown as a badge on the job match analysis header after this URL is moved to To do jobs.
              </p>
              <textarea
                value={modalReason}
                onChange={(e) => onModalReasonChange(e.target.value)}
                className="blue-outline-input mt-2 min-h-[88px] w-full resize-y bg-white px-3 py-2 text-sm text-slate-900 outline-none"
                placeholder="Why should this posting be on your To do list?"
                autoFocus
              />
            </div>
          )}

          {modalError && <div className="mt-3 text-sm font-medium text-red-700">{modalError}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-blue-200/60 px-5 py-3">
          <button
            type="button"
            className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-blue-50"
            onClick={onClose}
            disabled={modalSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-blue-neon rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-70"
            onClick={onConfirm}
            disabled={modalSubmitting}
          >
            {modalSubmitting ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
