import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Bug, ChevronLeft, ChevronRight, Paperclip, RefreshCw, Search } from 'lucide-react';
import { fetchAdminIssues } from '@/api/issuesApi';
import { cn } from '@/lib/utils';
import { PageLayout } from '@/components/app/PageLayout';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { IssueCategory, IssueReport, IssueStatus } from '@/types/issues';
import { fmt, fullDate, relative } from '../packages/packagesModel';
import { IssueSheet } from './IssueSheet';
import { CATEGORY_LABEL, categoryLabel, ISSUES_KEY, PAGE_SIZE, STATUS_META, STATUS_ORDER } from './issuesModel';

const ALL = 'all';

const CATEGORY_ITEMS = [
  { value: ALL, label: 'Any topic' },
  ...(Object.keys(CATEGORY_LABEL) as IssueCategory[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
];

export function AdminIssuesPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [q, setQ] = useState(search.trim());
  const [status, setStatus] = useState<IssueStatus | null>('open');
  const [category, setCategory] = useState<IssueCategory | null>(null);
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(() => params.get('issue'));

  useEffect(() => {
    const id = window.setTimeout(() => {
      setQ(search.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (q) next.set('q', q);
    else next.delete('q');
    if (openId) next.set('issue', openId);
    else next.delete('issue');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [q, openId, params, setParams]);

  const filters = { status: status ?? undefined, category: category ?? undefined, q: q || undefined };
  const issues = useQuery({
    queryKey: [...ISSUES_KEY, filters, offset],
    queryFn: () => fetchAdminIssues({ ...filters, offset, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const items = issues.data?.items ?? [];
  const total = issues.data?.total ?? 0;
  const counts = issues.data?.counts;
  const opened = items.find((i) => i.id === openId) ?? null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ISSUES_KEY });
  const filtered = !!(category || q || status !== 'open');
  const clearFilters = () => {
    setStatus('open');
    setCategory(null);
    setSearch('');
    setQ('');
    setOffset(0);
  };
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <PageLayout
      title="Reported issues"
      description="Problems people reported from the extension, with their screenshots and files. Triage them and keep notes for the team."
      actions={
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={issues.isFetching}>
          <RefreshCw className={cn(issues.isFetching && 'animate-spin')} /> Refresh
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-full sm:w-72">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search issues"
              placeholder="Text, reporter, page, or #number"
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
              setStatus(v === ALL ? null : (v as IssueStatus));
              setOffset(0);
            }}
          >
            {STATUS_ORDER.map((s) => (
              <ToggleGroupItem key={s} value={s} className="gap-1.5">
                <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_META[s].dot)} />
                {STATUS_META[s].label}
                {counts ? <span className="text-muted-foreground tabular-nums">{fmt(counts[s] ?? 0)}</span> : null}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
          </ToggleGroup>
          <Select
            items={CATEGORY_ITEMS}
            value={category ?? ALL}
            onValueChange={(v) => {
              setCategory(!v || v === ALL ? null : (v as IssueCategory));
              setOffset(0);
            }}
          >
            <SelectTrigger size="sm" aria-label="Filter by topic" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_ITEMS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
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
            {issues.isPending ? 'Loading…' : `${fmt(total)} issue${total === 1 ? '' : 's'}`}
          </span>
        </div>

        {issues.isError && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <span>Could not load reported issues.</span>
            <Button variant="outline" size="sm" onClick={() => void issues.refetch()}>
              Retry
            </Button>
          </div>
        )}

        <div className={cn('transition-opacity', issues.isPlaceholderData && 'opacity-60')}>
          <IssuesTable
            items={items}
            loading={issues.isPending}
            onOpen={(issue) => setOpenId(issue.id)}
            empty={
              filtered ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">No issues match these filters.</p>
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              ) : (
                <div className="mx-auto max-w-sm space-y-3">
                  <span className="mx-auto inline-flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <Bug className="size-5" />
                  </span>
                  <p className="text-sm font-medium">No open issues</p>
                  <p className="text-sm text-muted-foreground">
                    Reports people send from the extension show up here, with their screenshots and files.
                  </p>
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

      <IssueSheet
        issueId={openId}
        initial={opened}
        onClose={() => setOpenId(null)}
        onChanged={() => void refresh()}
      />
    </PageLayout>
  );
}

function IssuesTable({
  items,
  loading,
  empty,
  onOpen,
}: {
  items: IssueReport[];
  loading: boolean;
  empty: ReactNode;
  onOpen: (issue: IssueReport) => void;
}) {
  return (
    <div className="scrollbar-thin overflow-auto rounded-xl border bg-card">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--color-border)]">
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">Issue</th>
            <th scope="col" className="px-3 py-2 font-medium">Reporter</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Topic</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Reported</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading &&
            Array.from({ length: 6 }, (_, i) => (
              <tr key={i} data-testid="issue-row-skeleton">
                <td className="px-3 py-3"><Skeleton className="h-8 w-64" /></td>
                <td className="px-3 py-3"><Skeleton className="h-8 w-40" /></td>
                <td className="px-3 py-3"><Skeleton className="h-5 w-20" /></td>
                <td className="hidden px-3 py-3 md:table-cell"><Skeleton className="h-3.5 w-28" /></td>
                <td className="px-3 py-3"><Skeleton className="ml-auto h-3.5 w-16" /></td>
              </tr>
            ))}

          {!loading && items.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-14 text-center">
                {empty}
              </td>
            </tr>
          )}

          {!loading &&
            items.map((issue) => {
              const meta = STATUS_META[issue.status] ?? STATUS_META.open;
              const images = issue.attachments.filter((a) => a.kind === 'image').length;
              const files = issue.attachments.length - images;
              return (
                <tr
                  key={issue.id}
                  data-issue-id={issue.id}
                  tabIndex={0}
                  onClick={() => onOpen(issue)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(issue);
                    }
                  }}
                  className="cursor-pointer transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
                >
                  <td className="max-w-0 px-3 py-2.5">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{issue.number}</span>
                      <span className="truncate font-medium" title={issue.title}>{issue.title}</span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{issue.description.split('\n')[0]}</span>
                      {issue.attachments.length ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-1"
                          aria-label={`${images} screenshot${images === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}`}
                        >
                          <Paperclip className="size-3" />
                          {issue.attachments.length}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="max-w-0 px-3 py-2.5">
                    {issue.reporter ? (
                      <div className="min-w-0">
                        <div className="truncate font-medium" title={issue.reporter.name}>{issue.reporter.name}</div>
                        <div className="truncate text-xs text-muted-foreground" title={issue.reporter.email}>{issue.reporter.email}</div>
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
                  </td>
                  <td className="hidden max-w-0 px-3 py-2.5 text-xs text-muted-foreground md:table-cell">
                    <span className="block truncate">{categoryLabel(issue.category)}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs text-muted-foreground tabular-nums" title={fullDate(issue.created_at)}>
                    {relative(issue.created_at)}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
