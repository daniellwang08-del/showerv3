import { Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdminUser } from '@/types/admin';

export function RoleBadge({ user, className }: { user: AdminUser; className?: string }) {
  return user.is_admin ? (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand',
        className,
      )}
    >
      <Shield className="size-3" aria-hidden /> Admin
    </span>
  ) : (
    <span
      className={cn('inline-flex rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground', className)}
    >
      User
    </span>
  );
}

export function StatusBadge({ user, className }: { user: AdminUser; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium',
        user.is_active ? 'bg-status-ready/10 text-status-ready' : 'bg-status-failed/10 text-status-failed',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', user.is_active ? 'bg-status-ready' : 'bg-status-failed')}
      />
      {user.is_active ? 'Active' : 'Disabled'}
    </span>
  );
}

export function YouBadge() {
  return (
    <span className="rounded bg-muted px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
      You
    </span>
  );
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}
