import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Coins, Gift, History, Package, PackageOpen, PlusCircle, Undo2, UsersRound, Wallet } from 'lucide-react';
import { cancelGift, fetchLedger, fetchStore, giftPackage, redeemPackage } from '@/api/storeApi';
import { createTeamSpace } from '@/api/teamApi';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { LedgerEntry, StorePackage } from '@/types/store';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { formatCount } from './plansModel';
import { groupHeld, ledgerLabel, packageOrigin, shortDate, STORE_KEY, TEAM_OVERVIEW_KEY } from './storeModel';

type Action = { kind: 'gift' | 'team'; pkg: StorePackage } | null;

export function MyPackages() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: STORE_KEY, queryFn: fetchStore, staleTime: 30_000 });
  const [action, setAction] = useState<Action>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const groups = useMemo(() => groupHeld(query.data?.held ?? []), [query.data?.held]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: STORE_KEY });
    void queryClient.invalidateQueries({ queryKey: TEAM_OVERVIEW_KEY });
  };

  const redeem = useMutation({
    mutationFn: (pkg: StorePackage) => redeemPackage(pkg.id),
    onSuccess: (res, pkg) => {
      toast.success(`${formatCount(pkg.credits)} credits added. Balance: ${formatCount(res.balance)}`);
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not add the credits.')),
  });
  const takeBack = useMutation({
    mutationFn: (pkg: StorePackage) => cancelGift(pkg.id),
    onSuccess: () => {
      toast.success('The package is back in your store');
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not take the package back.')),
  });

  if (query.isPending) {
    return <Skeleton className="h-44 w-full rounded-2xl" aria-label="Loading your packages" />;
  }
  if (query.isError) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/60 px-5 py-6 text-sm text-muted-foreground">
        Could not load your packages.{' '}
        <button type="button" className="font-medium text-foreground underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const { balance, used, given } = query.data;
  const historyCount = used.length + given.length;

  return (
    <section aria-label="Your packages" className="rounded-2xl border bg-card/90 p-5 shadow-xs backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="inline-flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Wallet className="size-5" />
          </span>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Credit balance</p>
            <p className="text-2xl leading-tight font-semibold tabular-nums" aria-label={`${balance} credits`}>
              {formatCount(balance)} <span className="text-sm font-medium text-muted-foreground">credits</span>
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
          <History /> Credit history
        </Button>
      </div>

      <div className="mt-5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Package className="size-4 text-muted-foreground" aria-hidden />
          In your store
        </h3>
        {groups.length ? (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => (
              <HeldCard
                key={group.key}
                pkg={group.first}
                count={group.items.length}
                busy={redeem.isPending}
                onRedeem={() => redeem.mutate(group.first)}
                onTeam={() => setAction({ kind: 'team', pkg: group.first })}
                onGift={() => setAction({ kind: 'gift', pkg: group.first })}
              />
            ))}
          </ul>
        ) : (
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
            <PackageOpen className="size-5 shrink-0" aria-hidden />
            Nothing here yet. Packages you buy, or that someone gives you, wait here until you use them.
          </div>
        )}
      </div>

      {historyCount ? (
        <Tabs defaultValue={used.length ? 'used' : 'given'} className="mt-5">
          <TabsList>
            <TabsTrigger value="used">Used ({used.length})</TabsTrigger>
            <TabsTrigger value="given">Given away ({given.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="used">
            <PackageHistory items={used} empty="Packages you use show up here." />
          </TabsContent>
          <TabsContent value="given">
            <PackageHistory
              items={given}
              empty="Packages you give away show up here."
              onTakeBack={(pkg) => takeBack.mutate(pkg)}
              busy={takeBack.isPending}
            />
          </TabsContent>
        </Tabs>
      ) : null}

      <GiftDialog pkg={action?.kind === 'gift' ? action.pkg : null} onClose={() => setAction(null)} onDone={refresh} />
      <CreateTeamDialog pkg={action?.kind === 'team' ? action.pkg : null} onClose={() => setAction(null)} onDone={refresh} />
      <LedgerSheet open={historyOpen} onOpenChange={setHistoryOpen} />
    </section>
  );
}

function HeldCard({
  pkg,
  count,
  busy,
  onRedeem,
  onTeam,
  onGift,
}: {
  pkg: StorePackage;
  count: number;
  busy: boolean;
  onRedeem: () => void;
  onTeam: () => void;
  onGift: () => void;
}) {
  const team = pkg.kind === 'team';
  return (
    <li
      aria-label={`${pkg.name} package${count > 1 ? `, ${count} held` : ''}`}
      className="flex flex-col rounded-xl border border-border/70 bg-background/60 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-xl',
            team ? 'bg-chart-2/10 text-chart-2' : 'bg-brand/10 text-brand',
          )}
        >
          {team ? <UsersRound className="size-4" /> : <Coins className="size-4" />}
        </span>
        {count > 1 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">x{count}</span>
        ) : null}
      </div>
      <p className="mt-3 text-sm font-semibold">{team ? 'TEAM package' : `${pkg.name} package`}</p>
      <p className="text-sm text-muted-foreground">
        {team ? 'Opens one team space' : `${formatCount(pkg.credits)} credits`}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{packageOrigin(pkg)}</p>
      {pkg.note ? (
        <p className="mt-1.5 line-clamp-2 border-l-2 border-brand/40 pl-2 text-xs text-foreground/80" title={pkg.note}>
          {pkg.note}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {team ? (
          <Button size="sm" onClick={onTeam}>
            <PlusCircle /> Create team space
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={onRedeem}>
            <PlusCircle /> Add to balance
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onGift}>
          <Gift /> Give
        </Button>
      </div>
    </li>
  );
}

function PackageHistory({
  items,
  empty,
  onTakeBack,
  busy,
}: {
  items: StorePackage[];
  empty: string;
  onTakeBack?: (pkg: StorePackage) => void;
  busy?: boolean;
}) {
  if (!items.length) return <p className="py-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y">
      {items.map((pkg) => (
        <li key={pkg.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
          <span className="min-w-0">
            <span className="font-medium">{pkg.kind === 'team' ? 'TEAM package' : `${pkg.name} package`}</span>
            <span className="block truncate text-xs text-muted-foreground">{historyLine(pkg)}</span>
          </span>
          {onTakeBack && pkg.pending_email ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onTakeBack(pkg)}>
              <Undo2 /> Take back
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function historyLine(pkg: StorePackage): string {
  if (pkg.status === 'redeemed') {
    const when = pkg.redeemed_at ? ` on ${shortDate(pkg.redeemed_at)}` : '';
    if (pkg.kind === 'team') {
      return pkg.team_space
        ? `Opened ${pkg.team_space.name} (${pkg.team_space.public_id})${when}`
        : `Opened a team space that was later closed${when}`;
    }
    return `${formatCount(pkg.credits)} credits added to your balance${when}`;
  }
  if (pkg.pending_email) return `Waiting for ${pkg.pending_email} to sign up`;
  return `Given to ${pkg.owner?.email ?? 'another account'}`;
}

function GiftDialog({ pkg, onClose, onDone }: { pkg: StorePackage | null; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const gift = useMutation({
    mutationFn: () => giftPackage(pkg!.id, email.trim()),
    onSuccess: (res) => {
      toast.success(
        res.pending_email
          ? `Sent. ${res.pending_email} gets it when they sign up.`
          : `Given to ${res.owner?.email ?? email.trim()}`,
      );
      setEmail('');
      onDone();
      onClose();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not give the package.')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) gift.mutate();
  };
  return (
    <Dialog open={pkg !== null} onOpenChange={(open) => !open && !gift.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Give {pkg?.kind === 'team' ? 'a TEAM package' : `${pkg?.name} credits`}</DialogTitle>
            <DialogDescription>
              It moves to their store right away. If the email has no NAO account yet, it waits for them, and you can take
              it back until they sign up.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="gift-email">Their email</Label>
            <Input
              id="gift-email"
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={gift.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!email.trim() || gift.isPending}>
              {gift.isPending ? 'Giving…' : 'Give package'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateTeamDialog({
  pkg,
  onClose,
  onDone,
}: {
  pkg: StorePackage | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => createTeamSpace(pkg!.id, name.trim()),
    onSuccess: (space) => {
      toast.success(`${space.name} is ready. Team ID ${space.public_id}`);
      setName('');
      onDone();
      onClose();
      navigate(`/app/team?space=${encodeURIComponent(space.id)}`);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not create the team space.')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <Dialog open={pkg !== null} onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Create a team space</DialogTitle>
            <DialogDescription>
              This uses one TEAM package for good. You become the team lead and get a private team ID to share.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="team-name">Team name</Label>
            <Input
              id="team-name"
              maxLength={80}
              placeholder="e.g. Backend squad"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create team space'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LedgerSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const query = useQuery({ queryKey: [...STORE_KEY, 'ledger'], queryFn: () => fetchLedger(100), enabled: open });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Credit history</SheetTitle>
          <SheetDescription>Every change to your balance, newest first.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {query.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-muted-foreground">Could not load the history.</p>
          ) : query.data.entries.length ? (
            <ul className="divide-y">
              {query.data.entries.map((e) => (
                <LedgerRow key={e.id} entry={e} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No changes yet.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const positive = entry.delta > 0;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{ledgerLabel(entry)}</span>
        <span className="text-xs text-muted-foreground">{entry.created_at ? shortDate(entry.created_at) : '-'}</span>
      </span>
      <span className="text-right">
        <span className={cn('block text-sm font-semibold tabular-nums', positive ? 'text-status-ready' : 'text-foreground')}>
          {positive ? '+' : ''}
          {formatCount(entry.delta)}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">Balance {formatCount(entry.balance_after)}</span>
      </span>
    </li>
  );
}
