import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DuplicateJobsPanel } from '../extraction/DuplicateJobsPanel';
import { useJobsStore } from '../../stores/jobsStore';
import { useModalStore } from '../../stores/modalStore';
import { Z_INDEX } from '../../constants/zIndex';

interface Props {
  onClose: () => void;
}

export function DuplicatesModal({ onClose }: Props) {
  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Close on Escape (unless a nested confirm/action dialog is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const batchPending = useJobsStore.getState().batchDeletePending;
      const jobModal = useModalStore.getState().modal;
      if (batchPending || jobModal) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-[2px]"
        style={{ zIndex: Z_INDEX.duplicatesModalBackdrop, animation: 'modal-backdrop-in 0.18s ease-out both' }}
        onClick={() => {
          const batchPending = useJobsStore.getState().batchDeletePending;
          const jobModal = useModalStore.getState().modal;
          if (batchPending || jobModal) return;
          onClose();
        }}
        aria-hidden
      />

      {/* Modal container — DuplicateJobsPanel owns the full header + close button */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Duplicate jobs"
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none"
        style={{ zIndex: Z_INDEX.duplicatesModal }}
      >
        <div
          className="glass-card pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl"
          style={{
            height: 'min(80vh, 680px)',
            animation: 'modal-in 0.2s ease-out both',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-5">
            <DuplicateJobsPanel onClosePanel={onClose}>
              <></>
            </DuplicateJobsPanel>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
