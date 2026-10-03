import { useEffect, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryClient } from '@/lib/queryClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useUIStore, type Notification } from '@/stores/uiStore';

/** Routes legacy `useUIStore().notify(...)` calls into sonner. */
function NotificationBridge() {
  useEffect(() => {
    const shown = new Set<string>();
    const show = (n: Notification) => {
      if (shown.has(n.id)) return;
      shown.add(n.id);
      const fn = n.kind === 'success' ? toast.success
        : n.kind === 'warning' ? toast.warning
        : n.kind === 'error' ? toast.error
        : toast.info;
      fn(n.message, { id: n.id, onDismiss: () => useUIStore.getState().dismissNotification(n.id) });
    };
    useUIStore.getState().notifications.forEach(show);
    return useUIStore.subscribe((s) => s.notifications.forEach(show));
  }, []);
  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={300}>
        {children}
        <NotificationBridge />
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
