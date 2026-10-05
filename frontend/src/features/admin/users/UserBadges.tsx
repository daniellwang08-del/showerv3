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

export type AccountStatus = 'active' | 'disabled' | 'pending' | 'rejected';

export function accountStatus(user: AdminUser): AccountStatus {
  if (!user.is_active) return 'disabled';
  if (user.approval_status === 'pending') return 'pending';
  if (user.approval_status === 'rejected') return 'rejected';
  return 'active';
}

const STATUS_STYLE: Record<AccountStatus, { label: string; badge: string; dot: string }> = {
  active: { label: 'Active', badge: 'bg-status-ready/10 text-status-ready', dot: 'bg-status-ready' },
  disabled: { label: 'Disabled', badge: 'bg-status-failed/10 text-status-failed', dot: 'bg-status-failed' },
  pending: { label: 'Pending approval', badge: 'bg-brand-soft text-brand', dot: 'bg-brand' },
  rejected: { label: 'Rejected', badge: 'bg-status-failed/10 text-status-failed', dot: 'bg-status-failed' },
};

export function StatusBadge({ user, className }: { user: AdminUser; className?: string }) {
  const style = STATUS_STYLE[accountStatus(user)];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium', style.badge, className)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', style.dot)} />
      {style.label}
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
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}
