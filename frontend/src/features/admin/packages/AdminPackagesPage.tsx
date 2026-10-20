import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Gift, RefreshCw, Search } from 'lucide-react';
import { fetchAdminPackages, fetchAdminStoreOverview } from '@/api/storeApi';
import { cn } from '@/lib/utils';
import { PageLayout } from '@/components/app/PageLayout';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { AdminPackage, AdminPackageStatus, PackageCode, StorePackage } from '@/types/store';
import { useAdminUsers } from '../users/userActions';
import { GrantPackagesDialog } from './GrantPackagesDialog';
import { PackagesOverview } from './PackagesOverview';
import { PackagesTable } from './PackagesTable';
import { RevokePackageDialog } from './RevokePackageDialog';
import { ADMIN_STORE_KEY, fmt, OVERVIEW_KEY, PACKAGES_KEY, PAGE_SIZE, SOURCE_LABEL, STATUS_META, STATUS_ORDER } from './packagesModel';

type Source = StorePackage['source'];
const ALL = 'all';

const SOURCE_ITEMS = [
  { value: ALL, label: 'Any origin' },
  ...(Object.keys(SOURCE_LABEL) as Source[]).map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
];

export function AdminPackagesPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [q, setQ] = useState(search.trim());
  const [status, setStatus] = useState<AdminPackageStatus | null>(null);
  const [code, setCode] = useState<PackageCode | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [offset, setOffset] = useState(0);
  const [granting, setGranting] = useState(false);
  const [grantTo, setGrantTo] = useState<string[]>([]);
  const [revoking, setRevoking] = useState<AdminPackage | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setQ(search.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (params.get('q') === (q || null)) return;
    const next = new URLSearchParams(params);
    if (q) next.set('q', q);
    else next.delete('q');
    setParams(next, { replace: true });
  }, [q, params, setParams]);

  const overview = useQuery({ queryKey: OVERVIEW_KEY, queryFn: fetchAdminStoreOverview });
  const filters = { status: status ?? undefined, code: code ?? undefined, source: source ?? undefined, q: q || undefined };
  const packages = useQuery({
    queryKey: [...PACKAGES_KEY, filters, offset],
    queryFn: () => fetchAdminPackages({ ...filters, offset, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const users = useAdminUsers();
  const catalog = overview.data?.catalog ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ADMIN_STORE_KEY });
  const resetPage = () => setOffset(0);
  const filtered = !!(status || code || source || q);
  const clearFilters = () => {
    setStatus(null);
    setCode(null);
    setSource(null);
    setSearch('');
    setQ('');
    resetPage();
  };
  const openGrant = (to: string[] = []) => {
    setGrantTo(to);
    setGranting(true);
  };

  const total = packages.data?.total ?? 0;
  const items = packages.data?.items ?? [];
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + PAGE_SIZE, total);
  const codeItems = [{ value: ALL, label: 'All packages' }, ...catalog.map((c) => ({ value: c.code, label: c.kind === 'team' ? 'TEAM' : c.name }))];

  return (
    <PageLayout
      title="Packages"
      description="Grant credit and TEAM packages to anyone, follow what they hold and use, and take back mistakes."
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={packages.isFetching || overview.isFetching}>
            <RefreshCw className={cn((packages.isFetching || overview.isFetching) && 'animate-spin')} /> Refresh
          </Button>
          <Button size="sm" onClick={() => openGrant()} disabled={!catalog.length}>
            <Gift /> Grant packages
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <PackagesOverview
          overview={overview.data}
          loading={overview.isPending}
          error={overview.isError}
          onRetry={() => void overview.refetch()}
          status={status}
          code={code}
          onStatus={(s) => {
            setStatus(s);
            resetPage();
          }}
          onCode={(c) => {
            setCode(c);
            resetPage();
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-full sm:w-72">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search packages"
              placeholder="Holder name or email, or package ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.stopPropagation();
                  setSearch('');
                }
              }}
            />
          </InputGroup>
          <ToggleGroup
            aria-label="Filter by status"
            variant="outline"
            size="sm"
            spacing={0}
            value={[status ?? ALL]}
            onValueChange={(next) => {
              const v = next[0];
              if (!v) return;
              setStatus(v === ALL ? null : (v as AdminPackageStatus));
              resetPage();
            }}
          >
            <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
            {STATUS_ORDER.map((s) => (
              <ToggleGroupItem key={s} value={s} className="gap-1.5">
                <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_META[s].dot)} />
                {STATUS_META[s].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select
            items={codeItems}
            value={code ?? ALL}
            onValueChange={(v) => {
              setCode(!v || v === ALL ? null : (v as PackageCode));
              resetPage();
            }}
          >
            <SelectTrigger size="sm" aria-label="Filter by package" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {codeItems.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={SOURCE_ITEMS}
            value={source ?? ALL}
            onValueChange={(v) => {
              setSource(!v || v === ALL ? null : (v as Source));
              resetPage();
            }}
          >
            <SelectTrigger size="sm" aria-label="Filter by origin" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_ITEMS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {packages.isPending ? 'Loading…' : `${fmt(total)} package${total === 1 ? '' : 's'}`}
          </span>
        </div>

        {packages.isError && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <span>Could not load packages.</span>
            <Button variant="outline" size="sm" onClick={() => void packages.refetch()}>
              Retry
            </Button>
          </div>
        )}

        <div className={cn('transition-opacity', packages.isPlaceholderData && 'opacity-60')}>
          <PackagesTable
            items={items}
            loading={packages.isPending}
            onRevoke={setRevoking}
            onFocusHolder={(email) => {
              setSearch(email);
              setQ(email);
              resetPage();
            }}
            empty={
              filtered ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">No packages match these filters.</p>
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              ) : (
                <div className="mx-auto max-w-sm space-y-3">
                  <span className="mx-auto inline-flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <Gift className="size-5" />
                  </span>
                  <p className="text-sm font-medium">No packages yet</p>
                  <p className="text-sm text-muted-foreground">
                    Grant credit packs or TEAM packages to anyone by email. They show up in that person's store.
                  </p>
                  <Button size="sm" onClick={() => openGrant()} disabled={!catalog.length}>
                    <Gift /> Grant packages
                  </Button>
                </div>
              )
            }
          />
        </div>

        {total > PAGE_SIZE && (
          <nav aria-label="Pages" className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {fmt(from)} to {fmt(to)} of {fmt(total)}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={to >= total}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              <ChevronRight />
            </Button>
          </nav>
        )}
      </div>

      <GrantPackagesDialog
        open={granting}
        onOpenChange={setGranting}
        catalog={catalog}
        users={users.data ?? []}
        initialRecipients={grantTo}
        onGranted={() => void refresh()}
      />
      <RevokePackageDialog pkg={revoking} onClose={() => setRevoking(null)} onRevoked={() => void refresh()} />
    </PageLayout>
  );
}
