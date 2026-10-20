import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gift, Plus } from 'lucide-react';
import { adminAdjust, adminGrant, fetchAdminStore } from '@/api/storeApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminStoreSummary, CatalogEntry, PackageCode } from '@/types/store';
import { extractApiErrorMessage } from '@/utils/profileErrors';

const fmt = new Intl.NumberFormat('en-US');

function catalogLabel(c: CatalogEntry): string {
  return c.kind === 'team' ? 'TEAM (1 team space)' : `${c.name} (${fmt.format(c.credits)} credits)`;
}

/** Until payments go live, admins put packages into a user's store and correct balances. */
export function AdminStoreSection({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const key = ['admin', 'store', userId];
  const query = useQuery({ queryKey: key, queryFn: () => fetchAdminStore(userId) });
  const [code, setCode] = useState<PackageCode>('starter');
  const [quantity, setQuantity] = useState('1');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const setSummary = (summary: AdminStoreSummary) => queryClient.setQueryData(key, summary);

  const grant = useMutation({
    mutationFn: () => adminGrant(userId, code, Number(quantity)),
    onSuccess: (res) => {
      toast.success(`Added ${res.packages.length} package${res.packages.length === 1 ? '' : 's'} to their store`);
      setSummary(res.summary);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not grant the package.')),
  });
  const adjust = useMutation({
    mutationFn: () => adminAdjust(userId, Number(delta), note.trim()),
    onSuccess: (summary) => {
      toast.success(`Balance is now ${fmt.format(summary.balance)} credits`);
      setDelta('');
      setNote('');
      setSummary(summary);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not adjust the balance.')),
  });

  if (query.isPending) return <Skeleton className="h-32 w-full" />;
  if (query.isError) return <p className="text-sm text-muted-foreground">Could not load packages.</p>;

  const summary = query.data;
  const held = summary.catalog.filter((c) => summary.held[c.code]);
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
          <dt className="text-[11px] text-muted-foreground">Held packages</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {fmt.format(Object.values(summary.held).reduce((a, n) => a + (n ?? 0), 0))}
          </dd>
        </div>
        <div className="rounded-lg border bg-muted/30 px-2 py-2">
          <dt className="text-[11px] text-muted-foreground">Team spaces</dt>
          <dd className="text-sm font-semibold tabular-nums">{fmt.format(summary.team_spaces)}</dd>
        </div>
      </dl>
      {held.length ? (
        <p className="text-xs text-muted-foreground">
          In store: {held.map((c) => `${summary.held[c.code]} x ${c.kind === 'team' ? 'TEAM' : c.name}`).join(', ')}
        </p>
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
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" className="h-9" disabled={!deltaValid || adjust.isPending}>
            <Plus /> Apply
          </Button>
        </div>
      </form>
    </div>
  );
}
