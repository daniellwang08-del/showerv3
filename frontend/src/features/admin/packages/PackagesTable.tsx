import type { ReactNode } from 'react';
import { Copy, Hourglass, MessageSquareText, MoreHorizontal, Search, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AdminPackage } from '@/types/store';
import { CODE_TONE, fmt, fullDate, packageStatus, relative, STATUS_META } from './packagesModel';

export function PackagesTable({
  items,
  loading,
  empty,
  onRevoke,
  onFocusHolder,
}: {
  items: AdminPackage[];
  loading: boolean;
  empty: ReactNode;
  onRevoke: (pkg: AdminPackage) => void;
  onFocusHolder: (email: string) => void;
}) {
  return (
    <div className="scrollbar-thin overflow-auto rounded-xl border bg-card">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--color-border)]">
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">Package</th>
            <th scope="col" className="px-3 py-2 font-medium">Holder</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Origin</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Updated</th>
            <th scope="col" className="w-10 px-2 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading &&
            Array.from({ length: 6 }, (_, i) => (
              <tr key={i} data-testid="package-row-skeleton">
                <td className="px-3 py-3"><Skeleton className="h-8 w-32" /></td>
                <td className="px-3 py-3"><Skeleton className="h-8 w-44" /></td>
                <td className="px-3 py-3"><Skeleton className="h-5 w-20" /></td>
                <td className="hidden px-3 py-3 md:table-cell"><Skeleton className="h-3.5 w-28" /></td>
                <td className="px-3 py-3"><Skeleton className="ml-auto h-3.5 w-16" /></td>
                <td />
              </tr>
            ))}

          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-14 text-center">
                {empty}
              </td>
            </tr>
          )}

          {!loading &&
            items.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} onRevoke={onRevoke} onFocusHolder={onFocusHolder} />
            ))}
        </tbody>
      </table>
    </div>
  );
}

function PackageRow({
  pkg,
  onRevoke,
  onFocusHolder,
}: {
  pkg: AdminPackage;
  onRevoke: (pkg: AdminPackage) => void;
  onFocusHolder: (email: string) => void;
}) {
  const state = packageStatus(pkg);
  const meta = STATUS_META[state];
  const tone = CODE_TONE[pkg.code];
  const holderEmail = pkg.owner?.email ?? pkg.pending_email ?? '';
  const revocable = pkg.status === 'held';

  return (
    <tr data-package-id={pkg.id} className={cn('group transition-colors hover:bg-muted/40', state === 'revoked' && 'opacity-70')}>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold', tone.soft, tone.text)}
          >
            {pkg.kind === 'team' ? 'T' : pkg.name.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <div className="font-medium">{pkg.kind === 'team' ? 'TEAM' : pkg.name}</div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {pkg.kind === 'team' ? '1 team space' : `${fmt(pkg.credits)} credits`}
            </div>
          </div>
        </div>
      </td>

      <td className="max-w-0 px-3 py-2.5">
        {pkg.owner ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <Initials name={pkg.owner.name} />
            <div className="min-w-0">
              <div className="truncate font-medium" title={pkg.owner.name}>{pkg.owner.name}</div>
              <div className="truncate text-xs text-muted-foreground" title={pkg.owner.email}>{pkg.owner.email}</div>
            </div>
          </div>
        ) : pkg.pending_email ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-status-preparing/50 text-status-preparing">
              <Hourglass className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium" title={pkg.pending_email}>{pkg.pending_email}</div>
              <div className="text-xs text-muted-foreground">No account yet</div>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </td>

      <td className="px-3 py-2.5">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', meta.chip)}>
          <span aria-hidden className={cn('size-1.5 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <StatusDetail pkg={pkg} />
      </td>

      <td className="hidden max-w-0 px-3 py-2.5 md:table-cell">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-muted-foreground">{originText(pkg)}</span>
          {pkg.note ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    aria-label={`Note: ${pkg.note}`}
                    className="inline-flex shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                  />
                }
              >
                <MessageSquareText className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{pkg.note}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </td>

      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground tabular-nums" title={fullDate(pkg.updated_at)}>
        {relative(pkg.updated_at)}
      </td>

      <td className="px-2 py-2.5 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${pkg.name} package`} className="text-muted-foreground" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuGroup>
              {holderEmail ? (
                <DropdownMenuItem onClick={() => onFocusHolder(holderEmail)}>
                  <Search /> All packages for this person
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onClick={() => {
                  void navigator.clipboard?.writeText(pkg.id);
                  toast.success('Package ID copied');
                }}
              >
                <Copy /> Copy package ID
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {revocable ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onRevoke(pkg)}>
                  <Undo2 /> Revoke package
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function StatusDetail({ pkg }: { pkg: AdminPackage }) {
  let text = '';
  if (pkg.status === 'redeemed') {
    text = pkg.team_space
      ? `Opened ${pkg.team_space.name} (${pkg.team_space.public_id})`
      : `Added to balance ${relative(pkg.redeemed_at)}`;
  } else if (pkg.status === 'revoked') {
    text = [pkg.revoked_by ? `By ${pkg.revoked_by.name}` : '', pkg.revoke_reason ?? ''].filter(Boolean).join(': ');
  }
  if (!text) return null;
  return (
    <div className="mt-1 max-w-56 truncate text-[11px] text-muted-foreground" title={text}>
      {text}
    </div>
  );
}

function originText(pkg: AdminPackage): string {
  if (pkg.source === 'gift') return `Gift from ${pkg.gifted_from?.name ?? 'a user'}`;
  if (pkg.source === 'purchase') return 'Purchased';
  return pkg.granted_by ? `Granted by ${pkg.granted_by.name}` : 'Admin grant';
}

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
      {letters || '?'}
    </span>
  );
}
