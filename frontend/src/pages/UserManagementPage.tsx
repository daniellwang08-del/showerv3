import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Loader2,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { BrandedLoader } from '../components/layout/BrandedLoader';
import { ConfirmDialog } from '../components/extraction/ConfirmDialog';
import {
  deleteAdminUser,
  fetchAdminUsers,
  patchAdminUser,
  resetAdminUserPassword,
} from '../api/adminApi';
import type { AdminUser } from '../types/admin';
import { useAuth } from '../hooks/useAuth';

const STICKY_SHADOW =
  'shadow-[-4px_0_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[-4px_0_10px_-2px_rgba(0,0,0,0.45)]';
const TABLE_MIN_WIDTH = 'min-w-[920px] md:min-w-[1100px]';
/** Opaque sticky header surface (must beat scrolled cells in both themes). */
const STICKY_HEADER_BG = 'bg-slate-50 dark:!bg-[#121a2c]';
/** Default sticky body cell — matches `.dark .bg-white` (#141d31). */
const STICKY_CELL_IDLE =
  'bg-white group-hover:bg-slate-50 dark:!bg-[#141d31] dark:group-hover:!bg-[#1b2740]';
/** Selected sticky body cell — brighter than idle so content stays readable. */
const STICKY_CELL_SELECTED =
  '!bg-blue-50 group-hover:!bg-blue-50 dark:!bg-[#243a66] dark:group-hover:!bg-[#243a66]';

type BulkKind = 'promote' | 'demote' | 'enable' | 'disable' | 'delete';

type PendingAction =
  | { kind: 'single_admin'; user: AdminUser; next: boolean }
  | { kind: 'single_active'; user: AdminUser; next: boolean }
  | { kind: 'single_delete'; user: AdminUser }
  | { kind: 'bulk'; bulk: BulkKind; users: AdminUser[] }
  | null;

function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof msg === 'string' ? msg : fallback;
}

function stickyActionsClass(selected: boolean): string {
  // Sticky cells must stay OPAQUE. `!bg-blue-50` uses !important and bypasses the
  // global `.dark .bg-blue-50` remap, so selected rows need an explicit dark:!bg.
  return `${selected ? STICKY_CELL_SELECTED : STICKY_CELL_IDLE} ${STICKY_SHADOW}`;
}

function rowSurfaceClass(selected: boolean): string {
  if (selected) {
    // Brighter selection wash + light text via inverted slate-800/900 tokens.
    return 'bg-blue-50 dark:!bg-[#1e3358] border-l-[3px] border-l-blue-500';
  }
  return 'border-l-[3px] border-l-transparent hover:bg-slate-50/80 dark:hover:bg-white/5';
}

export function UserManagementPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);

  const load = useCallback(async (opts?: { soft?: boolean }) => {
    if (opts?.soft) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const list = await fetchAdminUsers();
      setUsers(list);
      setSelectedIds((prev) => {
        const valid = new Set(list.map((u) => u.id));
        const next = new Set<string>();
        prev.forEach((id) => {
          if (valid.has(id)) next.add(id);
        });
        return next;
      });
    } catch (e: unknown) {
      setError(errDetail(e, 'Failed to load users'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const hay = `${u.email} ${u.display_name || ''} ${u.name || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [users, query]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((u) => selectedIds.has(u.id));
  const someFilteredSelected = filtered.some((u) => selectedIds.has(u.id));
  const selectedUsers = useMemo(
    () => users.filter((u) => selectedIds.has(u.id)),
    [users, selectedIds],
  );

  const toggleSelectAllFiltered = () => {
    if (filtered.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((u) => next.delete(u.id));
      } else {
        filtered.forEach((u) => next.add(u.id));
      }
      return next;
    });
  };

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const runPending = async () => {
    if (!pending) return;
    setActionError('');
    setBusy(true);
    try {
      if (pending.kind === 'single_admin') {
        await patchAdminUser(pending.user.id, { is_admin: pending.next });
      } else if (pending.kind === 'single_active') {
        await patchAdminUser(pending.user.id, { is_active: pending.next });
      } else if (pending.kind === 'single_delete') {
        await deleteAdminUser(pending.user.id);
      } else if (pending.kind === 'bulk') {
        const targets = pending.users;
        const failures: string[] = [];
        for (const u of targets) {
          try {
            if (pending.bulk === 'promote') {
              if (!u.is_admin) await patchAdminUser(u.id, { is_admin: true });
            } else if (pending.bulk === 'demote') {
              if (u.is_admin) await patchAdminUser(u.id, { is_admin: false });
            } else if (pending.bulk === 'enable') {
              if (!u.is_active) await patchAdminUser(u.id, { is_active: true });
            } else if (pending.bulk === 'disable') {
              if (u.is_active) await patchAdminUser(u.id, { is_active: false });
            } else if (pending.bulk === 'delete') {
              if (u.id !== me?.id) await deleteAdminUser(u.id);
            }
          } catch (e: unknown) {
            failures.push(`${u.email}: ${errDetail(e, 'failed')}`);
          }
        }
        if (failures.length) {
          setActionError(failures.slice(0, 5).join('\n'));
          await load({ soft: true });
          return;
        }
        clearSelection();
      }
      setPending(null);
      await load({ soft: true });
    } catch (e: unknown) {
      setActionError(errDetail(e, 'Action failed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmTitle = (() => {
    if (!pending) return 'Confirm';
    if (pending.kind === 'single_delete') return 'Delete user?';
    if (pending.kind === 'single_admin') {
      return pending.next ? 'Promote to admin?' : 'Demote admin?';
    }
    if (pending.kind === 'single_active') {
      return pending.next ? 'Enable account?' : 'Disable account?';
    }
    if (pending.kind === 'bulk') {
      const n = pending.users.length;
      const labels: Record<BulkKind, string> = {
        promote: `Promote ${n} user${n === 1 ? '' : 's'}?`,
        demote: `Demote ${n} admin${n === 1 ? '' : 's'}?`,
        enable: `Enable ${n} account${n === 1 ? '' : 's'}?`,
        disable: `Disable ${n} account${n === 1 ? '' : 's'}?`,
        delete: `Delete ${n} user${n === 1 ? '' : 's'}?`,
      };
      return labels[pending.bulk];
    }
    return 'Confirm';
  })();

  const confirmVariant =
    pending?.kind === 'single_delete' ||
    (pending?.kind === 'bulk' && pending.bulk === 'delete')
      ? 'danger'
      : 'neutral';

  const showOverlay = loading || refreshing || busy;

  return (
    <PageScrollArea>
      <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
        <PageHeader
          icon={Users}
          gradient="from-slate-700 to-slate-900"
          title="User Management"
          description="Select users to promote, demote, enable, disable, or delete. Roles and account status live on each row."
        />

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-3 font-semibold underline"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 max-w-sm">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search email or name…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-slate-600 dark:placeholder:text-slate-500 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/20"
            />
          </div>
          <span className="text-xs text-slate-500">
            <span className="font-semibold tabular-nums text-slate-700">{filtered.length}</span>
            {filtered.length !== users.length ? (
              <span className="text-slate-400"> / {users.length}</span>
            ) : null}{' '}
            users
            {selectedIds.size > 0 ? (
              <span className="ml-1 font-medium text-blue-700">
                · {selectedIds.size} selected
              </span>
            ) : null}
          </span>
        </div>

        {/* Bulk bar */}
        {selectedIds.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/80 px-3 py-2.5 dark:border-blue-400/40 dark:bg-blue-500/20">
            <span className="text-xs font-semibold text-blue-800">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:hover:bg-blue-500/25"
            >
              <X size={12} /> Clear
            </button>
            <div className="mx-1 h-4 w-px bg-blue-200 dark:bg-blue-400/40" />
            <BulkBtn
              icon={Shield}
              label="Promote"
              disabled={busy || !selectedUsers.some((u) => !u.is_admin)}
              onClick={() =>
                setPending({
                  kind: 'bulk',
                  bulk: 'promote',
                  users: selectedUsers.filter((u) => !u.is_admin),
                })
              }
            />
            <BulkBtn
              icon={ShieldOff}
              label="Demote"
              disabled={busy || !selectedUsers.some((u) => u.is_admin)}
              onClick={() =>
                setPending({
                  kind: 'bulk',
                  bulk: 'demote',
                  users: selectedUsers.filter((u) => u.is_admin),
                })
              }
            />
            <BulkBtn
              icon={UserCheck}
              label="Enable"
              disabled={busy || !selectedUsers.some((u) => !u.is_active)}
              onClick={() =>
                setPending({
                  kind: 'bulk',
                  bulk: 'enable',
                  users: selectedUsers.filter((u) => !u.is_active),
                })
              }
            />
            <BulkBtn
              icon={UserX}
              label="Disable"
              disabled={busy || !selectedUsers.some((u) => u.is_active)}
              onClick={() =>
                setPending({
                  kind: 'bulk',
                  bulk: 'disable',
                  users: selectedUsers.filter((u) => u.is_active),
                })
              }
            />
            <BulkBtn
              icon={Trash2}
              label="Delete"
              danger
              disabled={busy || selectedUsers.every((u) => u.id === me?.id)}
              onClick={() =>
                setPending({
                  kind: 'bulk',
                  bulk: 'delete',
                  users: selectedUsers.filter((u) => u.id !== me?.id),
                })
              }
            />
          </div>
        ) : null}

        {/* Table shell — always mounted so sticky x-axis overlay stays available while loading */}
        <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700/60">
          <div className="overflow-x-auto">
            <table className={`w-full ${TABLE_MIN_WIDTH} table-fixed border-collapse text-sm`}>
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: 220 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 220 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-700/60 dark:bg-[#121a2c]">
                  <th className="px-2 py-3 text-left">
                    <SelectBox
                      checked={allFilteredSelected}
                      indeterminate={someFilteredSelected && !allFilteredSelected}
                      disabled={filtered.length === 0 || showOverlay}
                      title={allFilteredSelected ? 'Deselect all' : 'Select all'}
                      onToggle={toggleSelectAllFiltered}
                    />
                  </th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Email
                  </th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Name
                  </th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Role
                  </th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Status
                  </th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Created
                  </th>
                  <th
                    className={`sticky right-0 z-20 px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${STICKY_HEADER_BG} ${STICKY_SHADOW}`}
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {!loading && filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-16 text-center text-sm text-slate-500">
                      {users.length === 0
                        ? 'No users found.'
                        : 'No users match your search.'}
                    </td>
                  </tr>
                ) : null}

                {/* Skeleton rows while first load — keeps sticky Actions column painted */}
                {loading && users.length === 0
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={`sk-${i}`} className="group">
                        <td className="px-2 py-3">
                          <div className="h-4 w-4 rounded border border-slate-200 bg-slate-100 dark:border-slate-600 dark:bg-[#243044]" />
                        </td>
                        <td className="px-3 py-3">
                          <div className="h-3.5 w-40 animate-pulse rounded bg-slate-100 dark:bg-[#243044]" />
                        </td>
                        <td className="px-3 py-3">
                          <div className="h-3.5 w-24 animate-pulse rounded bg-slate-100 dark:bg-[#243044]" />
                        </td>
                        <td className="px-3 py-3">
                          <div className="h-5 w-14 animate-pulse rounded bg-slate-100 dark:bg-[#243044]" />
                        </td>
                        <td className="px-3 py-3">
                          <div className="h-5 w-14 animate-pulse rounded bg-slate-100 dark:bg-[#243044]" />
                        </td>
                        <td className="px-3 py-3">
                          <div className="h-3.5 w-16 animate-pulse rounded bg-slate-100 dark:bg-[#243044]" />
                        </td>
                        <td
                          className={`sticky right-0 z-10 px-3 py-3 ${STICKY_CELL_IDLE} ${STICKY_SHADOW}`}
                        >
                          <div className="ml-auto h-7 w-48 animate-pulse rounded bg-slate-100 dark:bg-[#243044]" />
                        </td>
                      </tr>
                    ))
                  : null}

                {filtered.map((u) => {
                  const isSelf = u.id === me?.id;
                  const isSelected = selectedIds.has(u.id);
                  return (
                    <tr
                      key={u.id}
                      className={`group ${rowSurfaceClass(isSelected)}`}
                      onClick={(e) => {
                        // Row click toggles selection unless clicking a control.
                        const t = e.target as HTMLElement;
                        if (t.closest('button, a, input, label')) return;
                        toggleRow(u.id);
                      }}
                    >
                      <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                        <SelectBox
                          checked={isSelected}
                          disabled={busy}
                          onToggle={() => toggleRow(u.id)}
                          title={isSelected ? 'Deselect' : 'Select'}
                        />
                      </td>
                      <td className="truncate px-3 py-3 font-medium text-slate-800" title={u.email}>
                        {u.email}
                        {isSelf ? (
                          <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500 dark:bg-slate-200 dark:text-slate-600">
                            you
                          </span>
                        ) : null}
                      </td>
                      <td className="truncate px-3 py-3 text-slate-700" title={u.display_name || u.name || undefined}>
                        {u.display_name || u.name || '-'}
                      </td>
                      <td className="px-3 py-3">
                        {u.is_admin ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-500/25 dark:text-indigo-200">
                            <Shield size={12} /> Admin
                          </span>
                        ) : (
                          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-200 dark:text-slate-700">
                            User
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            u.is_active
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/25 dark:text-emerald-200'
                              : 'bg-amber-50 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200'
                          }`}
                        >
                          {u.is_active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-600">
                        {u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}
                      </td>
                      <td
                        className={`sticky right-0 z-10 px-2 py-2 whitespace-nowrap align-middle ${stickyActionsClass(isSelected)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <RowBtn
                            selected={isSelected}
                            disabled={busy}
                            onClick={() =>
                              setPending({
                                kind: 'single_admin',
                                user: u,
                                next: !u.is_admin,
                              })
                            }
                          >
                            {u.is_admin ? 'Demote' : 'Promote'}
                          </RowBtn>
                          <RowBtn
                            selected={isSelected}
                            disabled={busy}
                            onClick={() =>
                              setPending({
                                kind: 'single_active',
                                user: u,
                                next: !u.is_active,
                              })
                            }
                          >
                            {u.is_active ? 'Disable' : 'Enable'}
                          </RowBtn>
                          <RowBtn
                            selected={isSelected}
                            disabled={busy}
                            onClick={() => {
                              setPasswordDraft('');
                              setActionError('');
                              setPasswordTarget(u);
                            }}
                          >
                            Reset pw
                          </RowBtn>
                          <RowBtn
                            selected={isSelected}
                            danger
                            disabled={busy || isSelf}
                            onClick={() =>
                              setPending({ kind: 'single_delete', user: u })
                            }
                          >
                            Delete
                          </RowBtn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Loading / busy overlay — table + sticky Actions column remain underneath */}
          {showOverlay ? (
            <div
              className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-white/55 backdrop-blur-[1px] dark:bg-[#0b1220]/60"
              aria-busy="true"
              aria-live="polite"
            >
              <div className="rounded-2xl border border-slate-200 bg-white/95 px-6 shadow-sm dark:border-white/10 dark:bg-[#141d31]/95">
                <BrandedLoader
                  compact
                  label={
                    loading && users.length === 0
                      ? 'Loading users…'
                      : busy
                        ? 'Applying changes…'
                        : 'Refreshing…'
                  }
                  className="py-6"
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={pending != null}
        title={confirmTitle}
        description={
          pending ? (
            <>
              {pending.kind === 'single_delete' && (
                <>
                  Permanently delete <strong>{pending.user.email}</strong> and cascaded user
                  data. This cannot be undone.
                </>
              )}
              {pending.kind === 'single_admin' && (
                <>
                  {pending.next ? 'Grant' : 'Remove'} admin access for{' '}
                  <strong>{pending.user.email}</strong>.
                </>
              )}
              {pending.kind === 'single_active' && (
                <>
                  {pending.next ? 'Re-enable' : 'Disable'}{' '}
                  <strong>{pending.user.email}</strong>. Disabled users cannot sign in.
                </>
              )}
              {pending.kind === 'bulk' && (
                <>
                  {pending.bulk === 'delete' ? (
                    <>
                      Permanently delete <strong>{pending.users.length}</strong> user
                      {pending.users.length === 1 ? '' : 's'} and cascaded data. This cannot
                      be undone.
                    </>
                  ) : (
                    <>
                      Apply <strong>{pending.bulk}</strong> to{' '}
                      <strong>{pending.users.length}</strong> selected user
                      {pending.users.length === 1 ? '' : 's'}.
                    </>
                  )}
                  {pending.users.length <= 8 ? (
                    <ul className="mt-2 max-h-32 list-disc overflow-y-auto pl-5 text-xs text-slate-600">
                      {pending.users.map((u) => (
                        <li key={u.id}>{u.email}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </>
          ) : (
            ''
          )
        }
        confirmLabel={
          pending?.kind === 'single_delete' ||
          (pending?.kind === 'bulk' && pending.bulk === 'delete')
            ? 'Delete'
            : 'Confirm'
        }
        variant={confirmVariant}
        loading={busy}
        error={actionError}
        onConfirm={() => void runPending()}
        onCancel={() => {
          if (busy) return;
          setPending(null);
          setActionError('');
        }}
      />

      {passwordTarget ? (
        <ConfirmDialog
          open
          title="Reset password"
          description={
            <div className="space-y-3">
              <p>
                Enter a temporary password for <strong>{passwordTarget.email}</strong> (min 8
                characters).
              </p>
              <input
                type="password"
                value={passwordDraft}
                onChange={(e) => setPasswordDraft(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                placeholder="New password"
                autoFocus
              />
            </div>
          }
          confirmLabel="Reset"
          variant="danger"
          loading={busy}
          error={actionError}
          onConfirm={() => {
            if (passwordDraft.trim().length < 8) {
              setActionError('Password must be at least 8 characters');
              return;
            }
            const target = passwordTarget;
            const pwd = passwordDraft.trim();
            void (async () => {
              setActionError('');
              setBusy(true);
              try {
                await resetAdminUserPassword(target.id, pwd);
                setPasswordTarget(null);
                setPasswordDraft('');
                await load({ soft: true });
              } catch (e: unknown) {
                setActionError(errDetail(e, 'Action failed'));
              } finally {
                setBusy(false);
              }
            })();
          }}
          onCancel={() => {
            if (busy) return;
            setPasswordTarget(null);
            setPasswordDraft('');
            setActionError('');
          }}
        />
      ) : null}
    </PageScrollArea>
  );
}

function SelectBox({
  checked,
  indeterminate = false,
  disabled,
  title,
  onToggle,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className="flex h-4 w-4 items-center justify-center rounded border border-slate-300 bg-white transition hover:border-blue-400 hover:bg-blue-50 disabled:opacity-40 dark:border-slate-500 dark:bg-[#1b2740] dark:hover:border-blue-400 dark:hover:bg-blue-500/20"
      aria-checked={checked}
      role="checkbox"
    >
      {checked ? (
        <CheckCircle2 size={12} className="text-blue-600" />
      ) : indeterminate ? (
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
      ) : null}
    </button>
  );
}

function BulkBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Shield;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'border-red-200 bg-white text-red-700 hover:bg-red-50 dark:border-red-400/50 dark:bg-[#2a1a22] dark:text-red-300 dark:hover:bg-red-500/20'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-500 dark:bg-[#243044] dark:text-slate-800 dark:hover:bg-[#2c3a52]'
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

function RowBtn({
  children,
  onClick,
  disabled,
  danger,
  selected,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs font-semibold disabled:opacity-50 ${
        danger
          ? selected
            ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-400/60 dark:bg-red-500/20 dark:text-red-200 dark:hover:bg-red-500/30'
            : 'border-red-200 text-red-700 hover:bg-red-50 dark:border-red-400/50 dark:text-red-300 dark:hover:bg-red-500/15'
          : selected
            ? 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-400 dark:bg-[#2c4068] dark:text-slate-900 dark:hover:bg-[#35507a]'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-500 dark:bg-[#1b2740] dark:text-slate-800 dark:hover:bg-[#243044]'
      }`}
    >
      {children}
    </button>
  );
}
