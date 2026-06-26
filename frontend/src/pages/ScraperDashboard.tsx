import { useEffect, useCallback, useRef, useState } from 'react';
import { useScraperStore } from '../stores/scraperStore';
import { useJobsStore } from '../stores/jobsStore';
import { apiClient } from '../api/client';
import { PageScrollArea } from '../components/layout/PageScrollArea';
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
import { CoverLetterTemplateAlertBar } from '../components/shared/CoverLetterTemplateAlertBar';
import { ResumeTemplateAlertBar } from '../components/shared/ResumeTemplateAlertBar';
import { AlertTriangle, Briefcase, Building2 } from 'lucide-react';
import type { DashboardJob } from '../types/scraper';
import type { DashboardView } from '../api/scraperApi';

export function ScraperDashboard() {
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
    const LOCATION_RECONCILE_FLAG = 'location_reconciled_v1';
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

  const handleSync = useCallback((spiderName?: string) => {
    startSync(spiderName);
  }, [startSync]);

  return (
    <PageScrollArea alwaysShowScrollbar={false}>
    <div className="px-5 py-5 w-full space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Jobs Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Browse and manage processed job listings across all platforms.
          </p>
        </div>
        {/* relative z-40 lifts this group (and the open Sync dropdown) above the toolbar/table below. */}
        <div className="relative z-40 flex items-start gap-2">
          <LlmProviderSelector />
          <SyncButton syncing={syncing} syncProgress={syncProgress} spiders={spiders} lastSyncRuns={lastSyncRuns} onSync={handleSync} />
        </div>
      </div>

      <ScraperStatsBar stats={stats} loading={statsLoading} />

      <ResumeTemplateAlertBar />
      <CoverLetterTemplateAlertBar />

      {/* ── Toolbar: view + filters + add-job URL (one line) ─────────────── */}
      {/* relative z-30 lifts this stacking context (and its open dropdowns) above the jobs table below. */}
      <div className="relative z-30 rounded-2xl border border-slate-200 bg-white/70 p-3 shadow-sm backdrop-blur-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
          {/* Viewing dropdown */}
          <div className="shrink-0">
            <DashboardViewSwitcher view={view} counts={counts} onChange={handleViewChange} />
          </div>

          <div className="hidden self-stretch w-px bg-slate-200 xl:block" />

          {/* Title / company / remote / match-score filters */}
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

          {/* Add job URL + duplicates */}
          <div className="flex w-full items-start gap-3 xl:flex-1 xl:min-w-[18rem]">
            <div className="min-w-0 flex-1">
              <SubmitForm inline />
            </div>
            <button
              type="button"
              onClick={() => setDupOpen(true)}
              title="View duplicate jobs"
              aria-label="Open duplicates panel"
              className={[
                'group inline-flex h-11 shrink-0 items-center gap-2 rounded-lg border border-orange-600/20 px-3.5 text-sm font-bold text-white',
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
