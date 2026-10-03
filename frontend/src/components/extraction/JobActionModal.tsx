import { ModalState } from '../../types/ui';
import { createPortal } from 'react-dom';
import { Edit2, XCircle, Copy, Trash2, RefreshCw, ClipboardCheck } from 'lucide-react';
import { Z_INDEX } from '../../constants/zIndex';

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

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 p-3 sm:p-4 backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.jobActionModal }}
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="border-b border-border px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex items-center gap-2 text-base font-bold text-foreground">
            {modal.kind === 'edit' && <Edit2 className="h-5 w-5 text-brand" />}
            {modal.kind === 'reportInvalid' && <XCircle className="h-5 w-5 text-destructive" />}
            {modal.kind === 'reportDuplicate' && <Copy className="h-5 w-5 text-status-preparing" />}
            {modal.kind === 'delete' && <Trash2 className="h-5 w-5 text-destructive" />}
            {modal.kind === 'replaceJob' && <RefreshCw className="h-5 w-5 text-brand" />}
            {modal.kind === 'promoteInvalidToValid' && <ClipboardCheck className="h-5 w-5 text-status-ready" />}
            <span>
              {modal.kind === 'edit' && 'Edit job URL'}
              {modal.kind === 'reportInvalid' && 'Report as invalid job'}
              {modal.kind === 'reportDuplicate' && 'Report as duplicated job'}
              {modal.kind === 'delete' && (modal.table === 'duplicated' ? 'Dismiss duplicate' : 'Delete job')}
              {modal.kind === 'replaceJob' && 'Replace job URL'}
              {modal.kind === 'promoteInvalidToValid' && 'Report as valid job'}
            </span>
          </div>
          {modal.kind !== 'replaceJob' && 'currentUrl' in modal && (
            <div className="mt-1 truncate text-xs text-muted-foreground" title={modal.currentUrl}>
              {modal.currentUrl}
            </div>
          )}
        </div>

        <div className="px-4 py-3 sm:px-5 sm:py-4">
          {modal.kind === 'edit' && (
            <div>
              <label className="block text-sm font-semibold text-foreground">New URL</label>
              <input
                value={modalUrl}
                onChange={(e) => onModalUrlChange(e.target.value)}
                className="mt-2 rounded-lg border border-input focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30 block w-full bg-card px-3 py-2 text-sm text-foreground outline-none"
                placeholder="https://..."
                autoFocus
              />
            </div>
          )}

          {modal.kind === 'reportInvalid' && (
            <div>
              <label className="block text-sm font-semibold text-foreground">Reason (optional)</label>
              <input
                value={modalReason}
                onChange={(e) => onModalReasonChange(e.target.value)}
                className="mt-2 rounded-lg border border-input focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30 block w-full bg-card px-3 py-2 text-sm text-foreground outline-none"
                placeholder="Why is this invalid?"
                autoFocus
              />
            </div>
          )}

          {modal.kind === 'reportDuplicate' && (
            <div className="grid gap-3">
              <div>
                <label className="block text-sm font-semibold text-foreground">Duplicate of job_id (optional)</label>
                <input
                  value={modalDuplicateOf}
                  onChange={(e) => onModalDuplicateOfChange(e.target.value)}
                  className="mt-2 rounded-lg border border-input focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30 block w-full bg-card px-3 py-2 text-sm text-foreground outline-none"
                  placeholder="UUID"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground">Reason (optional)</label>
                <input
                  value={modalReason}
                  onChange={(e) => onModalReasonChange(e.target.value)}
                  className="mt-2 rounded-lg border border-input focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30 block w-full bg-card px-3 py-2 text-sm text-foreground outline-none"
                  placeholder="Why is this duplicated?"
                />
              </div>
            </div>
          )}

          {modal.kind === 'delete' && (
            <div className="text-sm leading-relaxed text-foreground">
              {modal.table === 'duplicated' ? (
                <>
                  This hides the duplicate entry from your list. The underlying job data is preserved and
                  other users are not affected.
                </>
              ) : (
                <>
                  This removes the job from your To do list. AI match data for this job is deleted, and stored
                  extraction text is removed when no other job shares it. This cannot be undone.
                </>
              )}
            </div>
          )}

          {modal.kind === 'replaceJob' && (
            <div className="grid gap-3 text-sm text-foreground">
              <div>
                <div className="text-xs font-semibold text-foreground">Original (in To do list)</div>
                <div className="mt-1 break-all border border-brand/30 bg-brand-soft p-2 text-xs">{modal.validUrl}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-foreground">Replace with (duplicated link)</div>
                <div className="mt-1 break-all border border-status-preparing/30 bg-status-preparing/10 p-2 text-xs">{modal.invalidUrl}</div>
              </div>
              <div className="text-xs text-muted-foreground">This will update the original job URL and then delete this duplicated entry.</div>
            </div>
          )}

          {modal.kind === 'promoteInvalidToValid' && (
            <div>
              <label className="block text-sm font-semibold text-foreground">Reason</label>
              <p className="mt-1 text-xs text-muted-foreground">
                Shown as a badge on the job match analysis header after this URL is moved to To do jobs.
              </p>
              <textarea
                value={modalReason}
                onChange={(e) => onModalReasonChange(e.target.value)}
                className="mt-2 rounded-lg border border-input focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30 min-h-[88px] w-full resize-y bg-card px-3 py-2 text-sm text-foreground outline-none"
                placeholder="Why should this posting be on your To do list?"
                autoFocus
              />
            </div>
          )}

          {modalError && <div className="mt-3 text-sm font-medium text-destructive">{modalError}</div>}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-5">
          <button
            type="button"
            className="rounded-lg border border-brand/30 bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-brand-soft"
            onClick={onClose}
            disabled={modalSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-70"
            onClick={onConfirm}
            disabled={modalSubmitting}
          >
            {modalSubmitting ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
