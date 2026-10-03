import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdminUser } from '@/types/admin';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, RoleBadge, StatusBadge, YouBadge } from './UserBadges';

export type SortKey = 'email' | 'name' | 'role' | 'status' | 'created_at';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const COLUMNS: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: 'email', label: 'Email', className: 'w-[40%]' },
  { key: 'name', label: 'Name', className: 'hidden w-[25%] md:table-cell' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created', className: 'hidden sm:table-cell' },
];

export function UsersTable({
  users,
  loading,
  meId,
  selectedIds,
  onToggle,
  onToggleAll,
  openId,
  onOpen,
  sort,
  onSort,
  empty,
}: {
  users: AdminUser[];
  loading: boolean;
  meId?: string;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  openId: string | null;
  onOpen: (id: string) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  empty: ReactNode;
}) {
  const allSelected = users.length > 0 && users.every((u) => selectedIds.has(u.id));
  const someSelected = !allSelected && users.some((u) => selectedIds.has(u.id));

  return (
    <div className="scrollbar-thin max-h-[calc(100dvh-15rem)] min-h-48 overflow-auto rounded-xl border bg-card">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--color-border)]">
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="w-10 px-3 py-2">
              <Checkbox
                aria-label="Select all visible users"
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={onToggleAll}
                disabled={loading || users.length === 0}
              />
            </th>
            {COLUMNS.map((col) => {
              const active = sort.key === col.key;
              const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn('px-3 py-2 font-medium', col.className)}
                >
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className={cn(
                      '-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                      active && 'text-foreground',
                    )}
                  >
                    {col.label}
                    <Icon className={cn('size-3', !active && 'opacity-40')} aria-hidden />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading &&
            Array.from({ length: 6 }, (_, i) => (
              <tr key={i} data-testid="user-row-skeleton">
                <td className="px-3 py-3">
                  <Skeleton className="size-4" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-3.5 w-44" />
                </td>
                <td className="hidden px-3 py-3 md:table-cell">
                  <Skeleton className="h-3.5 w-24" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-5 w-14" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-5 w-16" />
                </td>
                <td className="hidden px-3 py-3 sm:table-cell">
                  <Skeleton className="h-3.5 w-20" />
                </td>
              </tr>
            ))}

          {!loading && users.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length + 1} className="px-4 py-14 text-center">
                {empty}
              </td>
            </tr>
          )}

          {!loading &&
            users.map((u) => {
              const selected = selectedIds.has(u.id);
              const label = u.display_name || u.name || '';
              return (
                <tr
                  key={u.id}
                  data-user-id={u.id}
                  tabIndex={0}
                  data-selected={selected || undefined}
                  onClick={() => onOpen(u.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter') onOpen(u.id);
                    if (e.key === ' ') {
                      e.preventDefault();
                      onToggle(u.id);
                    }
                  }}
                  className={cn(
                    'cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset',
                    selected && 'bg-brand-soft/60 hover:bg-brand-soft',
                    openId === u.id && 'bg-muted',
                  )}
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${u.email}`}
                      checked={selected}
                      onCheckedChange={() => onToggle(u.id)}
                    />
                  </td>
                  <td className="max-w-0 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium" title={u.email}>
                        {u.email}
                      </span>
                      {u.id === meId && <YouBadge />}
                    </div>
                    {label && <div className="truncate text-xs text-muted-foreground md:hidden">{label}</div>}
                  </td>
                  <td className="hidden max-w-0 truncate px-3 py-2.5 text-muted-foreground md:table-cell" title={label}>
                    {label || '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <RoleBadge user={u} />
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge user={u} />
                  </td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground tabular-nums sm:table-cell">
                    {formatDate(u.created_at)}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
