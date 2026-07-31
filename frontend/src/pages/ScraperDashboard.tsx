import { useEffect, useCallback, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useScraperStore } from '../stores/scraperStore';
import { useJobsStore } from '../stores/jobsStore';
import { apiClient } from '../api/client';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { PageHeader } from '../components/layout/PageHeader';
import { BrandedLoader } from '../components/layout/BrandedLoader';
import { ScraperStatsBar } from '../components/scraper/ScraperStatsBar';
import { ScraperJobsTable } from '../components/scraper/ScraperJobsTable';
import { SyncButton } from '../components/scraper/SyncButton';
import { LlmProviderSelector } from '../components/scraper/LlmProviderSelector';
import { Pagination } from '../components/shared/Pagination';
import { DashboardViewSwitcher } from '../components/scraper/DashboardViewSwitcher';
import { MatchScoreFilter, RemoteFilterToggle } from '../components/scraper/DashboardFilters';
import { SearchInput } from '../components/shared/SearchInput';
import { SubmitForm } from '../components/extraction/SubmitForm';
import { DuplicatesModal } from '../components/scraper/DuplicatesModal';
import type { AppShellOutletContext } from '../components/layout/AppShell';
import { AlertTriangle, Briefcase, Building2, Wand2 } from 'lucide-react';
import { useResumeAiStore } from '../stores/resumeAiStore';
import type { DashboardJob } from '../types/scraper';
import type { DashboardView } from '../api/scraperApi';

export function ScraperDashboard() {
  const { isAdmin } = useOutletContext<AppShellOutletContext>();
  const {
    jobs, total, page, perPage, pages, loading,
    stats, statsLoading,
    spiders,
    syncing,
    syncProgress,
    sortField, sortOrder,
    view, counts,
    titleFilter, companyFilter, remoteOnly, minScore,
    lastSyncRuns,
    loadJobs, bgRefreshJobs, loadStats, loadSpiders, loadLastSyncRuns, checkSyncStatus, startSync,
    setPage, setPerPage, setSort, setView,
    setTitleFilter, setCompanyFilter, setRemoteOnly, setMinScore,
  } = useScraperStore();

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const openResumeAiCenter = useCallback(() => {
    useResumeAiStore.getState().requestOpen();
    navigate('/resume-builder');
  }, [navigate]);

  // Show the branded loader only on the very first load, not on later filter refreshes.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (!loading) setBooted(true);
  }, [loading]);

  // Duplicates modal
  const [dupOpen, setDupOpen] = useState(false);
  const duplicateCount = useJobsStore((s) => s.invalidCounts.total);
  const refreshLists    = useJobsStore((s) => s.refreshLists);

  const handleViewChange = useCallback((next: DashboardView) => {
    setView(next);
  }, [setView]);

  const handleTitleFilter = useCallback((value: string) => {
    setTitleFilter(value);
  }, [setTitleFilter]);

  const handleCompanyFilter = useCallback((value: string) => {
    setCompanyFilter(value);
  }, [setCompanyFilter]);

  const displayedJobs: DashboardJob[] = jobs.filter(
    (j) => j.user_status !== 'duplicated' && j.user_status !== 'manual_hidden',
  );

  useEffect(() => {
    loadJobs();
    loadStats();
    loadSpiders();
    loadLastSyncRuns();
    checkSyncStatus();
    refreshLists();
    const RECONCILE_FLAG = 'company_policy_reconciled_v1';
    if (!sessionStorage.getItem(RECONCILE_FLAG)) {
      sessionStorage.setItem(RECONCILE_FLAG, 'pending');
      void apiClient.post('/jobs/valid/reconcile-company-policy').catch(() => {
        sessionStorage.removeItem(RECONCILE_FLAG);
      });
    }
    const LOCATION_RECONCILE_FLAG = 'location_reconciled_v2';
    if (!sessionStorage.getItem(LOCATION_RECONCILE_FLAG)) {
      sessionStorage.setItem(LOCATION_RECONCILE_FLAG, 'pending');
      void apiClient.post('/jobs/reconcile-locations').then(() => {
        refreshLists({ showLoading: false, reset: true });
        loadJobs();
      }).catch(() => {
        sessionStorage.removeItem(LOCATION_RECONCILE_FLAG);
      });
    }
  }, []);

  // Poll every 6 s while any job is mid-pipeline so dots/badges update live.
  useEffect(() => {
    const EXTRACTION_IN_PROGRESS = new Set(['pending', 'processing', 'extracted']);
    const RESUME_IN_PROGRESS     = new Set(['pending', 'processing']);
    const CONTENT_IN_PROGRESS = new Set(['pending', 'processing']);
    const hasInProgress = jobs.some(
      (j) =>
        (j.extraction_status && EXTRACTION_IN_PROGRESS.has(j.extraction_status)) ||
        (j.match_in_progress === true) ||
        (j.content_generation_status && CONTENT_IN_PROGRESS.has(j.content_generation_status)) ||
        (j.resume_build_status && RESUME_IN_PROGRESS.has(j.resume_build_status)),
    );

    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (hasInProgress) {
      pollTimerRef.current = setTimeout(() => void bgRefreshJobs(), 6000);
    }

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [jobs]);

  useEffect(() => {
    if (!syncing) return;
    const id = window.setInterval(() => {
      void checkSyncStatus();
    }, 10000);
    return () => window.clearInterval(id);
  }, [syncing, checkSyncStatus]);

  const handleSync = useCallback((options: Parameters<typeof startSync>[0]) => {
    void startSync(options);
  }, [startSync]);

  if (!booted) {
    return (
      <PageScrollArea alwaysShowScrollbar={false}>
        <BrandedLoader label="Loading your jobs…" />
      </PageScrollArea>
    );
  }

  return (
    <PageScrollArea alwaysShowScrollbar={false}>
    <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
      <PageHeader
        icon={Briefcase}
        gradient="from-slate-700 to-slate-900"
        title="Jobs Dashboard"
        description="Browse and manage processed job listings across all platforms."
        actions={
          <div className="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:justify-end">
            <button
              type="button"
              onClick={openResumeAiCenter}
              title="Paste a job description and tailor your resume with AI"
              className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:shadow-md sm:flex-none"
            >
              <Wand2 size={15} className="shrink-0" />
              <span className="truncate">Tailor with AI</span>
            </button>
            <LlmProviderSelector />
            {isAdmin && (
              <SyncButton syncing={syncing} syncProgress={syncProgress} spiders={spiders} lastSyncRuns={lastSyncRuns} onSync={handleSync} />
            )}
          </div>
        }
      />

      {/* z-0 keeps metric tiles below PageHeader menus (header is z-40). */}
      <div className="relative z-0">
        <ScraperStatsBar stats={stats} loading={statsLoading} />
      </div>

      <div className="relative z-10 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
          <div className="shrink-0">
            <DashboardViewSwitcher view={view} counts={counts} onChange={handleViewChange} />
          </div>

          <div className="hidden self-stretch w-px bg-slate-200 xl:block" />

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center xl:shrink-0">
            <SearchInput
              value={titleFilter}
              onChange={handleTitleFilter}
              placeholder="Filter by title"
              icon={Briefcase}
              variant="solid"
              className="w-full sm:w-44"
            />
            <SearchInput
              value={companyFilter}
              onChange={handleCompanyFilter}
              placeholder="Filter by company"
              icon={Building2}
              variant="solid"
              className="w-full sm:w-44"
            />
            <RemoteFilterToggle active={remoteOnly} onChange={setRemoteOnly} className="w-full sm:w-auto" />
            <MatchScoreFilter value={minScore} onChange={setMinScore} className="w-full sm:w-44" />
          </div>

          <div className="hidden self-stretch w-px bg-slate-200 xl:block" />

          <div className="flex w-full min-w-0 flex-wrap items-start gap-2 sm:gap-3 xl:flex-1 xl:min-w-[18rem]">
            <div className="min-w-0 flex-1 basis-[min(100%,16rem)]">
              <SubmitForm inline />
            </div>
            <button
              type="button"
              onClick={() => setDupOpen(true)}
              title="View duplicate jobs"
              aria-label="Open duplicates panel"
              className={[
                'group inline-flex h-11 shrink-0 items-center gap-2 rounded-lg border border-orange-600/20 px-3 sm:px-3.5 text-sm font-bold text-white',
                'bg-gradient-to-br from-amber-500 to-orange-600 shadow-md shadow-orange-500/25 transition-all',
                'hover:from-amber-500 hover:to-orange-500 hover:shadow-lg hover:shadow-orange-500/30',
                'focus:outline-none focus:ring-2 focus:ring-orange-400/50 focus:ring-offset-1',
                dupOpen ? 'from-amber-600 to-orange-700 ring-2 ring-orange-300' : '',
              ].join(' ')}
            >
              <AlertTriangle className="h-4 w-4 shrink-0 drop-shadow-sm" />
              <span className="hidden sm:inline">Duplicates</span>
              {duplicateCount > 0 && (
                <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-white px-1.5 py-0.5 text-xs font-extrabold tabular-nums text-orange-700 shadow-sm">
                  {duplicateCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Jobs table ──────────────────────────────────────────────────── */}
      <ScraperJobsTable
        jobs={displayedJobs}
        loading={loading}
        sortField={sortField}
        sortOrder={sortOrder}
        onSort={setSort}
        rowOffset={(page - 1) * perPage}
        canSync={isAdmin}
      />

      {total > 0 && (
        <Pagination
          page={page}
          pages={pages}
          total={total}
          perPage={perPage}
          onPageChange={setPage}
          onPerPageChange={setPerPage}
        />
      )}

      {/* ── Duplicates modal ─────────────────────────────────────────────── */}
      {dupOpen && <DuplicatesModal onClose={() => setDupOpen(false)} />}
    </div>
    </PageScrollArea>
  );
}
