import { useEffect, useRef } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import type { NotificationKind } from '../stores/uiStore';

const STYLES: Record<NotificationKind, { bar: string; icon: string; IconComp: typeof CheckCircle2 }> = {
  success: {
    bar: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    icon: 'text-emerald-500',
    IconComp: CheckCircle2,
  },
  warning: {
    bar: 'border-amber-300 bg-amber-50 text-amber-800',
    icon: 'text-amber-500',
    IconComp: AlertTriangle,
  },
  error: {
    bar: 'border-red-300 bg-red-50 text-red-800',
    icon: 'text-red-500',
    IconComp: XCircle,
  },
  info: {
    bar: 'border-blue-300 bg-blue-50 text-blue-800',
    icon: 'text-blue-500',
    IconComp: Info,
  },
};

export function NotificationBar() {
  const notifications = useUIStore((s) => s.notifications);
  const dismiss = useUIStore((s) => s.dismissNotification);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [notifications.length]);

  if (notifications.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="pointer-events-none fixed inset-x-0 top-4 z-[200] mx-auto flex max-w-xl flex-col items-center gap-2 px-4"
    >
      {notifications.map((n) => {
        const s = STYLES[n.kind];
        const Icon = s.IconComp;
        return (
          <div
            key={n.id}
            className={`pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-300 ${s.bar}`}
          >
            <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.icon}`} />
            <p className="flex-1 text-sm font-medium leading-snug">{n.message}</p>
            <button
              onClick={() => dismiss(n.id)}
              className="shrink-0 rounded-md p-0.5 opacity-60 transition hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
