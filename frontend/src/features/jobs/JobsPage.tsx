import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BarChart3, Briefcase, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { apiClient } from '@/api/client';
import type { DashboardView } from '@/api/scraperApi';
import { useScraperStore } from '@/stores/scraperStore';
import { useJobsStore } from '@/stores/jobsStore';
import { useShellStore } from '@/stores/shellStore';
import type { DashboardJob } from '@/types/scraper';
import { JobsTable, type JobsTableTier } from './JobsTable';
import { JobsSummary } from './JobsSummary';
import { JobsToolbar, type JobsViewTab } from './JobsToolbar';
import { BulkBar } from './BulkBar';
import { useJobActions } from './useJobActions';
import { useOpenJob, JOB_PARAM } from './useOpenJob';
import { isHiddenRow, isInFlight } from './jobStatus';

const DocumentPreviewModal = lazy(() =>
  import('@/components/scraper/DocumentPreviewModal').then((m) => ({ default: m.DocumentPreviewModal })),
);
const DuplicatesModal = lazy(() =>
  import('@/components/scraper/DuplicatesModal').then((m) => ({ default: m.DuplicatesModal })),
);

const PER_PAGE_OPTIONS = [25, 50, 100, 200].map((n) => ({ value: String(n), label: `${n} / page` }));

function useWidthTier(ref: React.RefObject<HTMLElement | null>): JobsTableTier {
  const [tier, setTier] = useState<JobsTableTier>('full');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setTier(w < 720 ? 'compact' : w < 1120 ? 'medium' : 'full');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tier;
}

function runOncePerSession(flag: string, path: string, after?: () => void) {
  if (sessionStorage.getItem(flag)) return;
  sessionStorage.setItem(flag, 'pending');
  void apiClient
    .post(path)
    .then(() => after?.())
    .catch(() => sessionStorage.removeItem(flag));
}

export function JobsPage() {
  const s = useScraperStore();
  const duplicateCount = useJobsStore((st) => st.invalidCounts.total);
  const [params] = useSearchParams();
  const activeJobId = params.get(JOB_PARAM);
  const openJobRef = useOpenJob();
  const openJob = useCallback((job: DashboardJob) => openJobRef(job), [openJobRef]);
  const setPaletteOpen = useShellStore((st) => st.setPaletteOpen);
  const toggleAssistant = useShellStore((st) => st.toggleAssistant);

  const containerRef = useRef<HTMLDivElement>(null);
  const tier = useWidthTier(containerRef);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<{ job: DashboardJob; type: 'resume_pdf' | 'cover_letter_pdf' } | null>(null);
  const [dupOpen, setDupOpen] = useState(false);

  const jobs = useMemo(() => s.jobs.filter((j) => !isHiddenRow(j, s.view)), [s.jobs, s.view]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);

  const actions = useJobActions({ openJob, onDone: clearSelection });

  useEffect(() => {
    void s.loadJobs();
    void s.loadStats({ isAdmin: false });
    void useJobsStore.getState().refreshLists();
    runOncePerSession('company_policy_reconciled_v1', '/jobs/valid/reconcile-company-policy');
    runOncePerSession('location_reconciled_v2', '/jobs/reconcile-locations', () => {
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: true });
      void useScraperStore.getState().loadJobs();
    });
    // Sheets/Pumble boards are applicant-only, but admin-only boards are not reachable here.
    const view = useScraperStore.getState().view;
    if (['needs_extraction', 'extracted', 'extraction_failed', 'manual'].includes(view)) s.setView('today');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WebSocket events drive live updates; this is the fallback while rows are mid-pipeline.
  const anyInFlight = jobs.some(isInFlight);
  useEffect(() => {
    if (!anyInFlight) return;
    const t = setInterval(() => {
      void useScraperStore.getState().bgRefreshJobs();
      void useScraperStore.getState().loadStats({ silent: true, isAdmin: false });
    }, 20_000);
    return () => clearInterval(t);
  }, [anyInFlight]);

  // Keep selection to rows that still exist after refreshes and filter changes.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(jobs.map((j) => j.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs]);

  const lastOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeJobId) {
      lastOpenedRef.current = activeJobId;
      return;
    }
    const id = lastOpenedRef.current;
    if (!id) return;
    lastOpenedRef.current = null;
    // Wait for the sheet to finish its own focus handling before restoring the row.
    const t = setTimeout(() => {
      containerRef.current?.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(id)}"]`)?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [activeJobId]);

  const selectedJobs = useMemo(() => jobs.filter((j) => selectedIds.has(j.id)), [jobs, selectedIds]);

  const toggleSelect = useCallback(
    (job: DashboardJob, { range }: { range: boolean }) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const anchor = anchorRef.current;
        if (range && anchor && anchor !== job.id) {
          const a = jobs.findIndex((j) => j.id === anchor);
          const b = jobs.findIndex((j) => j.id === job.id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) next.add(jobs[i].id);
            return next;
          }
        }
        if (next.has(job.id)) next.delete(job.id);
        else next.add(job.id);
        anchorRef.current = job.id;
        return next;
      });
    },
    [jobs],
  );

  const selectAll = useCallback(() => setSelectedIds(new Set(jobs.map((j) => j.id))), [jobs]);
  const toggleAll = useCallback(() => {
    if (jobs.length > 0 && jobs.every((j) => selectedIds.has(j.id))) clearSelection();
    else selectAll();
  }, [jobs, selectedIds, clearSelection, selectAll]);

  const targetsFor = useCallback(
    (job: DashboardJob) => (selectedIds.has(job.id) && selectedIds.size > 1 ? selectedJobs : [job]),
    [selectedIds, selectedJobs],
  );

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.size, clearSelection]);

  const stats = s.stats;
  const tabs: JobsViewTab[] = [
    { id: 'today', label: 'Today', count: s.counts.today },
    { id: 'available', label: 'Upcoming', count: s.counts.available },
    { id: 'ready', label: 'Ready to apply', count: stats?.ready_jobs },
    { id: 'all', label: 'All', count: s.counts.all },
    { id: 'mine', label: 'Added by me', count: s.counts.mine },
    { id: 'applied', label: 'Applied', count: stats?.applied_jobs },
  ];
  if ((stats?.sheet_posted_jobs ?? 0) > 0 || s.view === 'sheet_posted') {
    tabs.push({ id: 'sheet_posted', label: 'In Sheets', count: stats?.sheet_posted_jobs });
  }
  if ((stats?.pumble_posted_jobs ?? 0) > 0 || s.view === 'pumble_posted') {
    tabs.push({ id: 'pumble_posted', label: 'In Pumble', count: stats?.pumble_posted_jobs });
  }
  if (!tabs.some((t) => t.id === s.view)) {
    tabs.push({ id: s.view, label: s.view === 'applied_today' ? 'Applied today' : s.view.replace(/_/g, ' ') });
  }

  const onView = (view: DashboardView) => {
    clearSelection();
    s.setView(view);
  };

  const chips = [
    s.titleFilter && { key: 'title', label: `Title: ${s.titleFilter}`, onClear: () => s.setTitleFilter('') },
    s.companyFilter && { key: 'company', label: `Company: ${s.companyFilter}`, onClear: () => s.setCompanyFilter('') },
    s.sourceFilter && { key: 'source', label: `Source: ${s.sourceFilter}`, onClear: () => s.setSourceFilter('') },
  ].filter(Boolean) as Array<{ key: string; label: string; onClear: () => void }>;

  const filtered = Boolean(s.searchQuery || s.remoteOnly || s.minScore > 0 || chips.length > 0);
  const clearFilters = () =>
    s.applyAgentDashboard({ reset: true, view: s.view, sort: s.sortField, order: s.sortOrder });

  const from = s.total === 0 ? 0 : (s.page - 1) * s.perPage + 1;
  const to = Math.min(s.page * s.perPage, s.total);

  const empty = (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Briefcase />
        </EmptyMedia>
        <EmptyTitle>{filtered ? 'No jobs match these filters' : 'Nothing here yet'}</EmptyTitle>
        <EmptyDescription>
          {filtered
            ? 'Try a broader search or clear the filters.'
            : s.view === 'today'
              ? 'New jobs land here as they are found today. Add links yourself or browse everything.'
              : 'Add job links and NAO will read, score, and tailor documents for each one.'}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center gap-2">
        {filtered ? (
          <Button variant="outline" onClick={clearFilters}>Clear filters</Button>
        ) : (
          <>
            {s.view !== 'all' && <Button variant="outline" onClick={() => onView('all')}>Browse all jobs</Button>}
            <Button variant="outline" onClick={toggleAssistant}>
              <Sparkles /> Ask the assistant
            </Button>
          </>
        )}
      </EmptyContent>
    </Empty>
  );

  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 pt-5 md:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">Every job you can act on, scored against your profile.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)} className="hidden md:inline-flex">
            Jump to… <kbd className="ml-1 text-xs text-muted-foreground">⌘K</kbd>
          </Button>
          <Link to="/app/analysis" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <BarChart3 /> Insights
          </Link>
        </div>
      </header>

      <JobsSummary
        ready={stats?.ready_jobs}
        upcoming={stats?.available_jobs}
        appliedToday={stats?.applied_today}
        activeView={s.view}
        onView={onView}
      />

      <JobsToolbar
        tabs={tabs}
        view={s.view}
        onView={onView}
        search={s.searchQuery}
        onSearch={s.setSearchQuery}
        remoteOnly={s.remoteOnly}
        onRemoteOnly={s.setRemoteOnly}
        minScore={s.minScore}
        onMinScore={s.setMinScore}
        chips={chips}
        duplicateCount={duplicateCount}
        onOpenDuplicates={() => setDupOpen(true)}
      />

      <JobsTable
        jobs={jobs}
        loading={s.loading}
        tier={tier}
        sort={{ field: s.sortField, order: s.sortOrder }}
        onSort={s.setSort}
        selected={selectedIds}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
        activeJobId={activeJobId}
        onOpen={openJob}
        onAction={actions.run}
        onPreviewDoc={(job, type) => setPreview({ job, type })}
        menuContext={actions.menuContext}
        rerunning={actions.rerunning}
        targetsFor={targetsFor}
        empty={empty}
      />

      <footer className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {s.total > 0 ? `${from.toLocaleString()}–${to.toLocaleString()} of ${s.total.toLocaleString()}` : 'No jobs'}
        </span>
        <div className="flex items-center gap-2">
          <Select
            value={String(s.perPage)}
            items={PER_PAGE_OPTIONS}
            onValueChange={(v) => s.setPerPage(Number(v ?? 50))}
          >
            <SelectTrigger size="sm" aria-label="Rows per page" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PER_PAGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="tabular-nums">
            Page {s.page} of {Math.max(1, s.pages)}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={s.page <= 1 || s.loading}
            onClick={() => s.setPage(s.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={s.page >= s.pages || s.loading}
            onClick={() => s.setPage(s.page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </footer>

      <BulkBar
        selected={selectedJobs}
        pageCount={jobs.length}
        onSelectAll={selectAll}
        onClear={clearSelection}
        onAction={actions.run}
        menuContext={actions.menuContext}
      />

      {actions.dialogs}
      <Suspense fallback={null}>
        {preview && (
          <DocumentPreviewModal
            jobId={preview.job.id}
            fileType={preview.type}
            title={`${preview.type === 'resume_pdf' ? 'Resume' : 'Cover letter'} · ${preview.job.title || 'Job'}`}
            filePath={preview.type === 'resume_pdf' ? preview.job.resume_pdf_path : preview.job.cover_letter_pdf_path}
            onClose={() => setPreview(null)}
          />
        )}
        {dupOpen && <DuplicatesModal onClose={() => setDupOpen(false)} />}
      </Suspense>
    </div>
  );
}