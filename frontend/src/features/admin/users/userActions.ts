import { useQuery, type QueryClient } from '@tanstack/react-query';
import { approveSignup, deleteAdminUser, fetchAdminUsers, patchAdminUser, rejectSignup } from '@/api/adminApi';
import type { AdminUser } from '@/types/admin';

export const adminUsersKey = ['admin-users'] as const;

export function useAdminUsers() {
  return useQuery({ queryKey: adminUsersKey, queryFn: fetchAdminUsers });
}

export type BulkKind = 'promote' | 'demote' | 'enable' | 'disable' | 'delete';

export type PendingAction =
  | { kind: 'role'; user: AdminUser; next: boolean }
  | { kind: 'active'; user: AdminUser; next: boolean }
  | { kind: 'delete'; user: AdminUser }
  | { kind: 'approval'; user: AdminUser; next: 'approved' | 'rejected' }
  | { kind: 'bulk'; bulk: BulkKind; users: AdminUser[] };

export interface ActionResult {
  updated: AdminUser[];
  deleted: string[];
  failures: string[];
}

export function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof msg === 'string' ? msg : fallback;
}

export function userLabel(u: AdminUser): string {
  return u.display_name || u.name || u.email;
}

/**
 * Users a bulk action actually applies to. Admins can never demote, disable,
 * or delete their own account (the backend also rejects self-delete).
 */
export function bulkTargets(kind: BulkKind, users: AdminUser[], meId?: string): AdminUser[] {
  switch (kind) {
    case 'promote':
      return users.filter((u) => !u.is_admin);
    case 'demote':
      return users.filter((u) => u.is_admin && u.id !== meId);
    case 'enable':
      return users.filter((u) => !u.is_active);
    case 'disable':
      return users.filter((u) => u.is_active && u.id !== meId);
    case 'delete':
      return users.filter((u) => u.id !== meId);
  }
}

async function applyBulk(kind: BulkKind, u: AdminUser, result: ActionResult) {
  if (kind === 'delete') {
    await deleteAdminUser(u.id);
    result.deleted.push(u.id);
    return;
  }
  const body =
    kind === 'promote' || kind === 'demote'
      ? { is_admin: kind === 'promote' }
      : { is_active: kind === 'enable' };
  result.updated.push(await patchAdminUser(u.id, body));
}

/** Single actions throw; bulk actions run sequentially and collect per-user failures. */
export async function runAction(action: PendingAction): Promise<ActionResult> {
  const result: ActionResult = { updated: [], deleted: [], failures: [] };
  if (action.kind === 'role') {
    result.updated.push(await patchAdminUser(action.user.id, { is_admin: action.next }));
  } else if (action.kind === 'active') {
    result.updated.push(await patchAdminUser(action.user.id, { is_active: action.next }));
  } else if (action.kind === 'delete') {
    await deleteAdminUser(action.user.id);
    result.deleted.push(action.user.id);
  } else if (action.kind === 'approval') {
    const fn = action.next === 'approved' ? approveSignup : rejectSignup;
    result.updated.push(await fn(action.user.id));
  } else {
    for (const u of action.users) {
      try {
        await applyBulk(action.bulk, u, result);
      } catch (e) {
        result.failures.push(`${u.email}: ${errDetail(e, 'failed')}`);
      }
    }
  }
  return result;
}

export function applyResult(qc: QueryClient, result: ActionResult) {
  if (!result.updated.length && !result.deleted.length) return;
  const byId = new Map(result.updated.map((u) => [u.id, u]));
  const deleted = new Set(result.deleted);
  qc.setQueryData<AdminUser[]>(adminUsersKey, (prev) =>
    prev?.filter((u) => !deleted.has(u.id)).map((u) => byId.get(u.id) ?? u),
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function actionTitle(a: PendingAction): string {
  switch (a.kind) {
    case 'role':
      return a.next ? 'Promote to admin?' : 'Demote admin?';
    case 'active':
      return a.next ? 'Enable account?' : 'Disable account?';
    case 'delete':
      return 'Delete user?';
    case 'approval':
      return a.next === 'approved' ? 'Approve signup?' : 'Reject signup?';
    case 'bulk': {
      const n = a.users.length;
      return {
        promote: `Promote ${plural(n, 'user')}?`,
        demote: `Demote ${plural(n, 'admin')}?`,
        enable: `Enable ${plural(n, 'account')}?`,
        disable: `Disable ${plural(n, 'account')}?`,
        delete: `Delete ${plural(n, 'user')}?`,
      }[a.bulk];
    }
  }
}

export function actionConfirmLabel(a: PendingAction): string {
  if (a.kind === 'delete' || (a.kind === 'bulk' && a.bulk === 'delete')) return 'Delete';
  if (a.kind === 'role') return a.next ? 'Promote' : 'Demote';
  if (a.kind === 'active') return a.next ? 'Enable' : 'Disable';
  if (a.kind === 'approval') return a.next === 'approved' ? 'Approve' : 'Reject';
  return 'Confirm';
}

export function isDestructive(a: PendingAction): boolean {
  if (a.kind === 'delete') return true;
  if (a.kind === 'approval') return a.next === 'rejected';
  if (a.kind === 'active' || a.kind === 'role') return !a.next;
  return a.bulk === 'delete' || a.bulk === 'disable' || a.bulk === 'demote';
}

export function actionSuccess(a: PendingAction): string {
  switch (a.kind) {
    case 'role':
      return a.next ? `${a.user.email} is now an admin` : `${a.user.email} is no longer an admin`;
    case 'active':
      return a.next ? `${a.user.email} enabled` : `${a.user.email} disabled`;
    case 'delete':
      return `${a.user.email} deleted`;
    case 'approval':
      return `${a.user.email} ${a.next}`;
    case 'bulk': {
      const verb = { promote: 'Promoted', demote: 'Demoted', enable: 'Enabled', disable: 'Disabled', delete: 'Deleted' }[
        a.bulk
      ];
      return `${verb} ${plural(a.users.length, 'user')}`;
    }
  }
}
