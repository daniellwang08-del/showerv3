import { useEffect, type ReactNode } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

type Props = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red destructive styling for the confirm action */
  variant?: 'danger' | 'neutral';
  loading?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'neutral',
  loading = false,
  error,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  if (!open) return null;

  const confirmClass =
    variant === 'danger'
      ? 'border border-red-200 bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-500 disabled:opacity-60'
      : 'border border-blue-200 bg-blue-600 text-white shadow-sm hover:bg-blue-700 focus-visible:ring-blue-500 disabled:opacity-60';

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div className="glass-card relative w-full max-w-md rounded-2xl border border-slate-200/80 bg-white/95 shadow-2xl ring-1 ring-slate-200/60">
        <button
          type="button"
          onClick={() => !loading && onCancel()}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
          aria-label={cancelLabel}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="border-b border-slate-100 px-5 pb-4 pt-5 pr-12">
          <div className="flex items-start gap-3">
            {variant === 'danger' ? (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 ring-1 ring-red-100">
                <AlertTriangle className="h-5 w-5" aria-hidden />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <h2 id="confirm-dialog-title" className="text-lg font-semibold text-slate-900">
                {title}
              </h2>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="text-sm leading-relaxed text-slate-600">{description}</div>
          {error ? <p className="mt-3 text-sm font-medium text-red-600">{error}</p> : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${confirmClass}`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
