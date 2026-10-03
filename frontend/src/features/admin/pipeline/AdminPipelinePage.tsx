import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Briefcase, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PageLayout } from '@/components/app/PageLayout';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useScraperStore } from '@/stores/scraperStore';
import type { AdminScraperStats, DashboardJob, DashboardJobsPage } from '@/types/scraper';
import { JobDetailSheet } from '@/features/jobs/JobDetailSheet';
import { useOpenJob, JOB_PARAM } from '@/features/jobs/useOpenJob';
import { isJdReady } from '@/features/jobs/jobStatus';
import { AdminStatsStrip } from './AdminStatsStrip';
import { SyncPanel } from './SyncPanel';
import { SyncNoticeBanner } from './SyncNoticeBanner';
import { ModelPicker } from './ModelPicker';
import { AddJobsDialog } from './AddJobsDialog';
import { AdminJobsTable, type AdminActionId } from './AdminJobsTable';
import { BulkActionsBar } from './BulkActionsBar';
import { pipelineKeys, useAdminJobs, useAdminStats } from './queries';
import {
  deleteJobs,
  fetchAllJobs,
  prepareJob,
  prepareJobs,
  reconcileOncePerSession,
  type ActionResult,
  type ListFilters,
} from './pipelineApi';
import { ADMIN_VIEWS, isNotExtracted, isRowInFlight, isVisibleRow, viewCount, type AdminView } from './pipelineModel';

const PER_PAGE = [25, 50, 100, 200].map((n) => ({ value: String(n), label: `${n} / page` }));
const ALL_SOURCES = '__all__';
const DEFAULT_FILTERS: ListFilters = { view: 'today', source: '', q: '', sort: 'created_at', order: 'desc' };

export function AdminPipelinePage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const activeJobId = params.get(JOB_PARAM);
  const openJob = useOpenJob();

  const syncing = useScraperStore((s) => s.syncing);
  const spiders = useScraperStore((s) => s.spiders);
  const notice = useScraperStore((s) => s.syncNotice);
  const dismissNotice = useScraperStore((s) => s.dismissSyncNotice);

  const [filters, setFilters] = useState<ListFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Map<string, DashboardJob>>(() => new Map());
  const anchorRef = useRef<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [bulkExtracting, setBulkExtracting] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [deleting, setDeleting] = useState<DashboardJob[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const view = filters.view as AdminView;
  const listParams = { ...filters, page, perPage };
  const jobsPeek = qc.getQueryData<DashboardJobsPage>(pipelineKeys.list(listParams));
  const statsPeek = qc.getQueryData<AdminScraperStats>(pipelineKeys.stats());
  const backlog = (statsPeek?.needs_extraction_jobs ?? 0) > 0 || (statsPeek?.extraction_pending_jobs ?? 0) > 0;
  const inFlight = (jobsPeek?.items ?? []).some(isRowInFlight);

  const statsQuery = useAdminStats(backlog || syncing);
  const jobsQuery = useAdminJobs(listParams, backlog || inFlight);
  const stats = statsQuery.data;
  const data = jobsQuery.data;
  const jobs = (data?.items ?? []).filter((j) => isVisibleRow(j, view));
  const total = data?.total ?? 0;
  const pages = Math.max(1, data?.pages ?? 1);

  useEffect(() => {
    const s = useScraperStore.getState();
    void s.loadSpiders();
    void s.loadLastSyncRuns();
    void s.checkSyncStatus();
    reconcileOncePerSession(() => void qc.invalidateQueries({ queryKey: pipelineKeys.lists() }));
  }, [qc]);

  // Websocket sync events drive live progress; this poll settles state if an event is missed.
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => void useScraperStore.getState().checkSyncStatus(), 20_000);
    return () => clearInterval(t);
  }, [syncing]);

  useEffect(() => {
    if (data && page > pages) setPage(pages);
  }, [data, page, pages]);

  useEffect(() => setQuery(filters.q), [filters.q]);
  useEffect(() => {
    if (query.trim() === filters.q) return;
    const t = setTimeout(() => applyFilters({ q: query.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const clearSelection = () => {
    setSelected(new Map());
    anchorRef.current = null;
  };

  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      setSelected(new Map());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size]);

  function applyFilters(patch: Partial<ListFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
    clearSelection();
  }

  /** Board tiles and view tabs reset the list like the legacy admin board did. */
  const selectBoard = (next: AdminView, source = '') => applyFilters({ ...DEFAULT_FILTERS, view: next, source });

  const onSort = (field: string) =>
    applyFilters({ sort: field, order: filters.sort === field && filters.order === 'desc' ? 'asc' : 'desc' });

  const toggleSelect = (job: DashboardJob, { range }: { range: boolean }) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const anchor = anchorRef.current;
      if (range && anchor && anchor !== job.id) {
        const a = jobs.findIndex((j) => j.id === anchor);
        const b = jobs.findIndex((j) => j.id === job.id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.set(jobs[i].id, jobs[i]);
          return next;
        }
      }
      if (next.has(job.id)) next.delete(job.id);
      else next.set(job.id, job);
      anchorRef.current = job.id;
      return next;
    });
  };

  const selectPage = () =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const j of jobs) next.set(j.id, j);
      return next;
    });

  const toggleAll = () => {
    if (jobs.length > 0 && jobs.every((j) => selected.has(j.id))) {
      setSelected((prev) => {
        const next = new Map(prev);
        for (const j of jobs) next.delete(j.id);
        return next;
      });
    } else selectPage();
  };

  const targetsFor = (job: DashboardJob) =>
    selected.has(job.id) && selected.size > 1 ? [...selected.values()] : [job];

  const markQueued = (ids: string[]) => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    qc.setQueriesData<DashboardJobsPage | InfiniteData<DashboardJobsPage>>({ queryKey: pipelineKeys.lists() }, (old) =>
      old && 'items' in old
        ? { ...old, items: old.items.map((j) => (set.has(j.id) ? { ...j, extraction_status: 'pending' as const } : j)) }
        : old,
    );
  };

  const report = (res: ActionResult) => {
    if (res.ok) toast.success(res.message);
    else if (res.partial) toast.warning(res.message);
    else toast.error(res.message);
  };

  const extract = async (targets: DashboardJob[]) => {
    if (targets.length === 0) return;
    if (targets.length === 1) {
      const job = targets[0];
      setBusyIds((prev) => new Set(prev).add(job.id));
      const res = await prepareJob(job.id, isJdReady(job));
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      if (res.ok) markQueued(res.extractIds ?? []);
      report(res);
    } else {
      setBulkExtracting(true);
      const res = await prepareJobs(targets.map((t) => t.id));
      setBulkExtracting(false);
      markQueued(res.extractIds ?? []);
      if (res.ok || res.partial) clearSelection();
      report(res);
    }
    void qc.invalidateQueries({ queryKey: pipelineKeys.stats() });
  };

  const runAction = (id: AdminActionId, targets: DashboardJob[]) => {
    switch (id) {
      case 'view':
        openJob(targets[0]);
        break;
      case 'open-url':
        targets.forEach((t) => window.open(t.source_url, '_blank', 'noopener,noreferrer'));
        break;
      case 'copy-url':
        void navigator.clipboard
          ?.writeText(targets[0].source_url)
          .then(() => toast.success('URL copied'))
          .catch(() => toast.error('Could not copy the URL'));
        break;
      case 'extract':
        void extract(targets);
        break;
      case 'delete':
        setDeleteError(null);
        setDeleting(targets);
        break;
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await deleteJobs(deleting.map((j) => j.id));
    setDeleteBusy(false);
    if (res.deleted.length > 0) {
      setSelected((prev) => {
        const next = new Map(prev);
        res.deleted.forEach((id) => next.delete(id));
        return next;
      });
      void qc.invalidateQueries({ queryKey: pipelineKeys.root });
    }
    if (res.ok) {
      setDeleting(null);
      toast.success(res.message);
    } else {
      setDeleteError(res.message);
    }
  };

  const selectNotExtractedAll = async () => {
    setSelectingAll(true);
    try {
      const all = (await fetchAllJobs(filters)).filter((j) => isVisibleRow(j, view) && isNotExtracted(j));
      setSelected(new Map(all.map((j) => [j.id, j])));
      toast.success(
        all.length > 0
          ? `Selected ${all.length} not extracted job${all.length === 1 ? '' : 's'} across all pages.`
          : 'No not extracted jobs found across all pages.',
      );
    } catch {
      toast.error('Could not load all pages for selection.');
    } finally {
      setSelectingAll(false);
    }
  };

  const sourceOptions = [{ value: ALL_SOURCES, label: 'All sources' }];
  const seen = new Set<string>();
  for (const s of [...spiders.map((x) => ({ name: x.name, label: x.label })), ...(stats?.platform_sync ?? [])]) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    sourceOptions.push({ value: s.name, label: s.label || s.name });
  }
  if (filters.source && !seen.has(filters.source)) sourceOptions.push({ value: filters.source, label: filters.source });

  const filtered = Boolean(filters.q || filters.source);
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const notExtractedOnPage = jobs.filter(isNotExtracted).length;

  const empty = (
    <Empty className="border-0 py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Briefcase />
        </EmptyMedia>
        <EmptyTitle>No jobs match this view</EmptyTitle>
        <EmptyDescription>Try another board filter, or Sync all sites if the pool is empty.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center gap-2">
        {filtered && (
          <Button variant="outline" onClick={() => applyFilters({ q: '', source: '' })}>
            Clear filters
          </Button>
        )}
        {view !== 'all' && (
          <Button variant="outline" onClick={() => selectBoard('all')}>
            View all jobs
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );

  return (
    <PageLayout
      title="Jobs pipeline"
      description="Fetch listings, auto-extract job descriptions, and track the live JD backlog."
      width="wide"
      className="max-w-[96rem]"
      actions={
        <>
          <ModelPicker />
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add jobs
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {notice && <SyncNoticeBanner notice={notice} spiders={spiders} onDismiss={dismissNotice} />}

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <AdminStatsStrip
            stats={stats}
            loading={statsQuery.isPending}
            error={statsQuery.isError}
            onRetry={() => void statsQuery.refetch()}
            activeView={view}
            activeSource={filters.source}
            onSelectView={(v) => selectBoard(v)}
            onSelectPlatform={(source) => selectBoard('all', source)}
          />
          <SyncPanel />
        </div>

        <div className="space-y-3">
          <div role="tablist" aria-label="Pipeline views" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
            {ADMIN_VIEWS.map((v) => {
              const active = v.id === view;
              const count = active && data ? total : viewCount(v.id, stats);
              return (
                <button
                  key={v.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  title={v.description}
                  onClick={() => selectBoard(v.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                    active ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {v.label}
                  {count != null && (
                    <span className={cn('rounded-full px-1.5 text-xs tabular-nums', active ? 'bg-background/20' : 'bg-muted')}>
                      {count.toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-72">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label="Search jobs"
                placeholder="Search titles, companies, links…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFilters({ q: query.trim() });
                  if (e.key === 'Escape' && query) {
                    e.stopPropagation();
                    setQuery('');
                    applyFilters({ q: '' });
                  }
                }}
              />
            </InputGroup>
            <Select
              value={filters.source || ALL_SOURCES}
              items={sourceOptions}
              onValueChange={(v) => applyFilters({ source: !v || v === ALL_SOURCES ? '' : String(v) })}
            >
              <SelectTrigger size="sm" aria-label="Source" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {jobsQuery.isFetching && !jobsQuery.isPending && (
              <span className="text-xs text-muted-foreground" aria-live="polite">
                Refreshing…
              </span>
            )}
          </div>

          {selected.size > 0 && (
            <BulkActionsBar
              count={selected.size}
              pageCount={jobs.length}
              notExtractedOnPage={notExtractedOnPage}
              showAllPages={pages > 1}
              selectingAllPages={selectingAll}
              extracting={bulkExtracting}
              onSelectPage={selectPage}
              onSelectNotExtractedPage={() => setSelected(new Map(jobs.filter(isNotExtracted).map((j) => [j.id, j])))}
              onSelectNotExtractedAll={() => void selectNotExtractedAll()}
              onExtract={() => void extract([...selected.values()])}
              onOpenUrls={() => runAction('open-url', [...selected.values()])}
              onDelete={() => runAction('delete', [...selected.values()])}
              onClear={clearSelection}
            />
          )}

          {jobsQuery.isError ? (
            <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border bg-card px-4 py-10 text-center">
              <p className="text-sm text-destructive">Couldn’t load jobs for this view.</p>
              <Button variant="outline" size="sm" onClick={() => void jobsQuery.refetch()} disabled={jobsQuery.isFetching}>
                Retry
              </Button>
            </div>
          ) : (
            <AdminJobsTable
              jobs={jobs}
              loading={jobsQuery.isPending}
              rowOffset={(page - 1) * perPage}
              sort={{ field: filters.sort, order: filters.order }}
              onSort={onSort}
              selected={selected}
              onToggleSelect={toggleSelect}
              onToggleAll={toggleAll}
              activeJobId={activeJobId}
              onOpen={openJob}
              onAction={runAction}
              busyIds={busyIds}
              targetsFor={targetsFor}
              empty={empty}
            />
          )}

          <footer className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span className="tabular-nums">
              {total > 0 ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : 'No jobs'}
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={String(perPage)}
                items={PER_PAGE}
                onValueChange={(v) => {
                  setPerPage(Number(v ?? 50));
                  setPage(1);
                }}
              >
                <SelectTrigger size="sm" aria-label="Rows per page" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PER_PAGE.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="tabular-nums">
                Page {page} of {pages}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous page"
                disabled={page <= 1 || jobsQuery.isFetching}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next page"
                disabled={page >= pages || jobsQuery.isFetching}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </footer>
        </div>
      </div>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && !deleteBusy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting && deleting.length > 1 ? `Delete ${deleting.length} jobs?` : 'Delete this job?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.length > 1
                ? `This permanently removes ${deleting.length} jobs from the platform pool.`
                : `This permanently removes ${deleting?.[0]?.title ? `“${deleting[0].title}”` : 'the job'}${deleting?.[0]?.company ? ` at ${deleting[0].company}` : ''} from the platform pool.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleteBusy} onClick={() => void confirmDelete()}>
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddJobsDialog open={adding} onOpenChange={setAdding} />
      <JobDetailSheet isAdmin />
    </PageLayout>
  );
}
