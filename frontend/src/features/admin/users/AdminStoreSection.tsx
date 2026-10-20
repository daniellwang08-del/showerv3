import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUpRight, Gift, Plus, Undo2 } from 'lucide-react';
import { adminAdjust, adminGrant, fetchAdminStore } from '@/api/storeApi';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminPackage, AdminStoreSummary, CatalogEntry, PackageCode } from '@/types/store';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { CODE_TONE, relative } from '../packages/packagesModel';
import { RevokePackageDialog } from '../packages/RevokePackageDialog';

const fmt = new Intl.NumberFormat('en-US');

function catalogLabel(c: CatalogEntry): string {
  return c.kind === 'team' ? 'TEAM (1 team space)' : `${c.name} (${fmt.format(c.credits)} credits)`;
}

/** Until payments go live, admins put packages into a user's store and correct balances. */
export function AdminStoreSection({ userId, email }: { userId: string; email: string }) {
  const queryClient = useQueryClient();
  const key = ['admin', 'store', userId];
  const query = useQuery({ queryKey: key, queryFn: () => fetchAdminStore(userId) });
  const [code, setCode] = useState<PackageCode>('starter');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [revoking, setRevoking] = useState<AdminPackage | null>(null);
  const setSummary = (summary: AdminStoreSummary) => queryClient.setQueryData(key, summary);
  const refreshPackagesPage = () =>
    queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'admin' && q.queryKey[1] === 'store' && q.queryKey[2] !== userId });

  const grant = useMutation({
    mutationFn: () => adminGrant(userId, code, Number(quantity), note.trim()),
    onSuccess: (res) => {
      toast.success(`Added ${res.packages.length} package${res.packages.length === 1 ? '' : 's'} to their store`);
      setNote('');
      setSummary(res.summary);
      void refreshPackagesPage();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not grant the package.')),
  });
  const adjust = useMutation({
    mutationFn: () => adminAdjust(userId, Number(delta), reason.trim()),
    onSuccess: (summary) => {
      toast.success(`Balance is now ${fmt.format(summary.balance)} credits`);
      setDelta('');
      setReason('');
      setSummary(summary);
      void refreshPackagesPage();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not adjust the balance.')),
  });

  if (query.isPending) return <Skeleton className="h-32 w-full" />;
  if (query.isError) return <p className="text-sm text-muted-foreground">Could not load packages.</p>;

  const summary = query.data;
  const heldCount = Object.values(summary.held).reduce((a, n) => a + (n ?? 0), 0);
  const qty = Number(quantity);
  const qtyValid = Number.isInteger(qty) && qty >= 1 && qty <= 20;
  const deltaNum = Number(delta);
  const deltaValid = delta.trim() !== '' && Number.isInteger(deltaNum) && deltaNum !== 0;

  const submitGrant = (e: FormEvent) => {
    e.preventDefault();
    if (qtyValid) grant.mutate();
  };
  const submitAdjust = (e: FormEvent) => {
    e.preventDefault();
    if (deltaValid) adjust.mutate();
  };

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border bg-muted/30 px-2 py-2">
          <dt className="text-[11px] text-muted-foreground">Balance</dt>
          <dd className="text-sm font-semibold tabular-nums">{fmt.format(summary.balance)}</dd>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-2">
          <dt className="text-[11px] text-muted-foreground">Unused packages</dt>
          <dd className="text-sm font-semibold tabular-nums">{fmt.format(heldCount)}</dd>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-2">
          <dt className="text-[11px] text-muted-foreground">Team spaces</dt>
          <dd className="text-sm font-semibold tabular-nums">{fmt.format(summary.team_spaces)}</dd>
        </div>
      </dl>

      {summary.held_packages.length ? (
        <ul aria-label="Unused packages" className="divide-y rounded-lg border">
          {summary.held_packages.map((pkg) => (
            <li key={pkg.id} className="flex items-center gap-2.5 px-2.5 py-2 text-sm">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', CODE_TONE[pkg.code].swatch)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {pkg.kind === 'team' ? 'TEAM' : `${pkg.name}, ${fmt.format(pkg.credits)} credits`}
                </span>
                <span className="block truncate text-xs text-muted-foreground" title={pkg.note ?? undefined}>
                  {pkg.source === 'gift' ? `Gift from ${pkg.gifted_from?.name ?? 'a user'}` : 'Granted'} {relative(pkg.created_at)}
                  {pkg.note ? `: ${pkg.note}` : ''}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Revoke ${pkg.kind === 'team' ? 'TEAM' : pkg.name} package`}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setRevoking(pkg)}
              >
                <Undo2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={submitGrant} className="space-y-1.5">
        <Label>Grant a package</Label>
        <div className="flex gap-2">
          <Select
            items={summary.catalog.map((c) => ({ value: c.code, label: catalogLabel(c) }))}
            value={code}
            onValueChange={(v) => v != null && setCode(v as PackageCode)}
          >
            <SelectTrigger aria-label="Package" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {summary.catalog.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {catalogLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Quantity"
            type="number"
            min={1}
            max={20}
            className="w-16"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          <Button type="submit" size="sm" className="h-9" disabled={!qtyValid || grant.isPending}>
            <Gift /> Grant
          </Button>
        </div>
        <Input
          aria-label="Note to the user"
          placeholder="Note shown with the package (optional)"
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </form>

      <form onSubmit={submitAdjust} className="space-y-1.5">
        <Label htmlFor={`adjust-${userId}`}>Adjust balance</Label>
        <div className="flex gap-2">
          <Input
            id={`adjust-${userId}`}
            type="number"
            placeholder="+50 or -10"
            className="w-28"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
          />
          <Input
            aria-label="Reason"
            placeholder="Reason (shown to the user)"
            maxLength={300}
            className="min-w-0 flex-1"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" className="h-9" disabled={!deltaValid || adjust.isPending}>
            <Plus /> Apply
          </Button>
        </div>
      </form>

      <Button
        variant="link"
        size="sm"
        className="h-auto px-0"
        nativeButton={false}
        render={<Link to={`/admin/packages?q=${encodeURIComponent(email)}`} />}
      >
        Full package history <ArrowUpRight />
      </Button>

      <RevokePackageDialog
        pkg={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          void queryClient.invalidateQueries({ queryKey: key });
          void refreshPackagesPage();
        }}
      />
    </div>
  );
}
