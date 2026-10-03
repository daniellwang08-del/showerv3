import { useState } from 'react';
import { RefreshCw, Search, Shield, ShieldOff, Trash2, UserCheck, UserX, X } from 'lucide-react';
import type { AdminUser } from '@/types/admin';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { PageLayout } from '@/components/app/PageLayout';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { UserDetailSheet } from './UserDetailSheet';
import { UsersTable, type SortKey, type SortState } from './UsersTable';
import { bulkTargets, errDetail, useAdminUsers, type BulkKind, type PendingAction } from './userActions';

type RoleFilter = 'all' | 'admin' | 'user';
type StatusFilter = 'all' | 'active' | 'disabled';

const ROLE_FILTERS: Array<{ value: RoleFilter; label: string }> = [
  { value: 'all', label: 'All roles' },
  { value: 'admin', label: 'Admins' },
  { value: 'user', label: 'Users' },
];
const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
];

const BULK_BUTTONS: Array<{ kind: BulkKind; label: string; icon: typeof Shield }> = [
  { kind: 'promote', label: 'Promote', icon: Shield },
  { kind: 'demote', label: 'Demote', icon: ShieldOff },
  { kind: 'enable', label: 'Enable', icon: UserCheck },
  { kind: 'disable', label: 'Disable', icon: UserX },
  { kind: 'delete', label: 'Delete', icon: Trash2 },
];

function sortValue(u: AdminUser, key: SortKey): string | number {
  switch (key) {
    case 'email':
      return u.email.toLowerCase();
    case 'name':
      return (u.display_name || u.name || '').toLowerCase();
    case 'role':
      return u.is_admin ? 0 : 1;
    case 'status':
      return u.is_active ? 0 : 1;
    case 'created_at':
      return u.created_at ? new Date(u.created_at).getTime() || 0 : 0;
  }
}

function visibleUsers(
  users: AdminUser[],
  { query, role, status, sort }: { query: string; role: RoleFilter; status: StatusFilter; sort: SortState },
): AdminUser[] {
  const q = query.trim().toLowerCase();
  const rows = users.filter((u) => {
    if (role === 'admin' && !u.is_admin) return false;
    if (role === 'user' && u.is_admin) return false;
    if (status === 'active' && !u.is_active) return false;
    if (status === 'disabled' && u.is_active) return false;
    if (!q) return true;
    return `${u.email} ${u.display_name || ''} ${u.name || ''}`.toLowerCase().includes(q);
  });
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

export function AdminUsersPage() {
  const { user: me } = useAuth();
  const meId = me?.id;
  const usersQuery = useAdminUsers();
  const users = usersQuery.data ?? [];

  const [query, setQuery] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortState>({ key: 'created_at', dir: 'desc' });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const visible = visibleUsers(users, { query, role, status, sort });
  const selectedUsers = users.filter((u) => selectedIds.has(u.id));
  const openUser = users.find((u) => u.id === openId) ?? null;
  const filtered = query.trim() !== '' || role !== 'all' || status !== 'all';

  const clearFilters = () => {
    setQuery('');
    setRole('all');
    setStatus('all');
  };

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const all = visible.every((u) => next.has(u.id));
      for (const u of visible) {
        if (all) next.delete(u.id);
        else next.add(u.id);
      }
      return next;
    });

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'created_at' ? 'desc' : 'asc' },
    );

  const loadError = usersQuery.isError ? errDetail(usersQuery.error, 'Failed to load users') : '';

  return (
    <PageLayout
      width="wide"
      title="Users"
      description="Manage roles, account status, and passwords. Select rows for bulk actions; click a row for details."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void usersQuery.refetch()}
          disabled={usersQuery.isFetching}
        >
          <RefreshCw className={cn(usersQuery.isFetching && 'animate-spin')} /> Refresh
        </Button>
      }
    >
      <div className="space-y-3">
        {loadError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void usersQuery.refetch()}>
              Retry
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-full sm:w-72">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search users"
              placeholder="Search email or name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
          </InputGroup>
          <Select value={role} items={ROLE_FILTERS} onValueChange={(v) => setRole((v as RoleFilter | null) ?? 'all')}>
            <SelectTrigger size="sm" aria-label="Filter by role" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            items={STATUS_FILTERS}
            onValueChange={(v) => setStatus((v as StatusFilter | null) ?? 'all')}
          >
            <SelectTrigger size="sm" aria-label="Filter by status" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {usersQuery.isPending
              ? 'Loading…'
              : visible.length === users.length
                ? `${users.length} users`
                : `${visible.length} of ${users.length} users`}
          </span>
        </div>

        {selectedUsers.length > 0 && (
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="flex flex-wrap items-center gap-1.5 rounded-xl border bg-muted/40 px-3 py-2"
          >
            <span className="mr-1 text-sm font-medium tabular-nums">{selectedUsers.length} selected</span>
            <Button variant="ghost" size="xs" onClick={() => setSelectedIds(new Set())}>
              <X /> Clear
            </Button>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {BULK_BUTTONS.map(({ kind, label, icon: Icon }) => {
              const targets = bulkTargets(kind, selectedUsers, meId);
              return (
                <Button
                  key={kind}
                  variant={kind === 'delete' ? 'destructive' : 'outline'}
                  size="xs"
                  disabled={targets.length === 0}
                  onClick={() => setPending({ kind: 'bulk', bulk: kind, users: targets })}
                >
                  <Icon /> {label}
                </Button>
              );
            })}
          </div>
        )}

        <UsersTable
          users={visible}
          loading={usersQuery.isPending}
          meId={meId}
          selectedIds={selectedIds}
          onToggle={toggle}
          onToggleAll={toggleAll}
          openId={openId}
          onOpen={setOpenId}
          sort={sort}
          onSort={onSort}
          empty={
            filtered ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">No users match these filters.</p>
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{loadError ? 'Users could not be loaded.' : 'No users yet.'}</p>
            )
          }
        />
      </div>

      <UserDetailSheet user={openUser} meId={meId} onClose={() => setOpenId(null)} />

      <ConfirmActionDialog
        action={pending}
        onClose={() => setPending(null)}
        onDone={() => setSelectedIds(new Set())}
      />
    </PageLayout>
  );
}
