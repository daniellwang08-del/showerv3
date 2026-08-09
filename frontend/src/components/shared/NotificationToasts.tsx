import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X, AlertTriangle } from 'lucide-react';
import { useUIStore, type NotificationKind } from '../../stores/uiStore';

const TONE: Record<
  NotificationKind,
  { wrap: string; icon: typeof CheckCircle2 }
> = {
  success: {
    wrap: 'bg-emerald-600 text-white shadow-emerald-900/30 ring-emerald-400/40',
    icon: CheckCircle2,
  },
  warning: {
    wrap: 'bg-amber-500 text-white shadow-amber-900/25 ring-amber-300/50',
    icon: AlertTriangle,
  },
  error: {
    wrap: 'bg-rose-600 text-white shadow-rose-900/30 ring-rose-400/40',
    icon: AlertCircle,
  },
  info: {
    wrap: 'bg-slate-800 text-white shadow-slate-900/30 ring-slate-400/30',
    icon: Info,
  },
};

/**
 * Global toast stack for `useUIStore.notify` — used after background paste
 * submits, sheet posts, and WebSocket error surfaces.
 */
export function NotificationToasts() {
  const notifications = useUIStore((s) => s.notifications);
  const dismiss = useUIStore((s) => s.dismissNotification);

  if (typeof document === 'undefined' || notifications.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[200] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {notifications.map((n) => {
        const tone = TONE[n.kind];
        const Icon = tone.icon;
        return (
          <div
            key={n.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm font-medium shadow-lg ring-1 ${tone.wrap}`}
            role="status"
          >
            <Icon size={18} className="mt-0.5 shrink-0 opacity-95" aria-hidden />
            <p className="min-w-0 flex-1 leading-snug">{n.message}</p>
            <button
              type="button"
              onClick={() => dismiss(n.id)}
              aria-label="Dismiss"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/15 transition hover:bg-white/25"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
