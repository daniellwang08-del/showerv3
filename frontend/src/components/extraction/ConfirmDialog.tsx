import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { Z_INDEX } from '../../constants/zIndex';

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
      if (e.key === 'Escape' && !loading) {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, loading, onCancel]);

  if (!open) return null;

  const confirmClass =
    variant === 'danger'
      ? 'border border-destructive/30 bg-destructive/10 text-destructive shadow-sm hover:bg-destructive/20 focus-visible:ring-destructive/40 disabled:opacity-60'
      : 'border border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:ring-ring/50 disabled:opacity-60';

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 p-3 sm:p-4 backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.confirmDialog }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <button
          type="button"
          onClick={() => !loading && onCancel()}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label={cancelLabel}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="border-b border-border px-4 pb-3 pt-4 pr-12 sm:px-5 sm:pb-4 sm:pt-5">
          <div className="flex items-start gap-3">
            {variant === 'danger' ? (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive ring-1 ring-destructive/30">
                <AlertTriangle className="h-5 w-5" aria-hidden />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <h2 id="confirm-dialog-title" className="text-lg font-semibold text-foreground">
                {title}
              </h2>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 sm:px-5 sm:py-4">
          <div className="text-sm leading-relaxed text-muted-foreground">{description}</div>
          {error ? <p className="mt-3 text-sm font-medium text-destructive">{error}</p> : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end sm:px-5 sm:py-4">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/50 disabled:opacity-50"
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
    </div>,
    document.body,
  );
}
