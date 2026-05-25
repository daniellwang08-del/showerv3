/**
 * Centered modal that wraps DetailContentPanel for quick in-place job analysis
 * viewing from the scraper dashboard.  The modal occupies 70 % of the viewport
 * width and 85 % of the viewport height, matching the full-screen drawer layout
 * that the extraction page uses.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { DetailContentPanel } from '../extraction/DetailContentPanel';

interface JobAnalysisModalProps {
  validJobId: string;
  onClose: () => void;
}

export function JobAnalysisModal({ validJobId, onClose }: JobAnalysisModalProps) {
  /* ── Keyboard: Escape to close ─────────────────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /* ── Prevent body scroll while open ───────────────────────────────── */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    /* ── Full-screen backdrop ────────────────────────────────────────── */
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-6 animate-modal-backdrop-in"
      role="dialog"
      aria-modal="true"
      aria-label="Job analysis"
    >
      {/* Dimmed backdrop — click outside to close */}
      <div
        className="absolute inset-0 bg-slate-900/55 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* ── Modal panel ─────────────────────────────────────────────── */}
      <div
        className="relative z-10 flex h-[85vh] w-[70vw] min-w-[520px] max-w-[1200px] animate-modal-in flex-col overflow-hidden rounded-2xl shadow-2xl ring-1 ring-slate-900/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close (×) button — top-right corner, above the panel header */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-white/80 text-slate-500 shadow-sm ring-1 ring-slate-200/80 backdrop-blur-sm transition-colors hover:bg-red-50 hover:text-red-600 hover:ring-red-200"
        >
          <X size={14} strokeWidth={2.5} />
        </button>

        {/*
         * DetailContentPanel owns the scrollable content, header, and data
         * fetching.  Passing `onClose` so the panel's "← Back" button also
         * dismisses the modal.
         */}
        <DetailContentPanel validJobId={validJobId} onClose={onClose} />
      </div>
    </div>
  );
}
