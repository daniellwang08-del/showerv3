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
import { SyncResultBanner } from '../components/scraper/SyncResultBanner';
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
    stats, adminStats, statsLoading,
    spiders,
    syncing,
    syncNotice,
    sortField, sortOrder,
    view, counts,
    titleFilter, companyFilter, remoteOnly, minScore,
    loadJobs, bgRefreshJobs, loadStats, loadSpiders, loadLastSyncRuns, checkSyncStatus,
    dismissSyncNotice,
    setPage, setPerPage, setSort, setView,
    setTitleFilter, setCompanyFilter, setRemoteOnly, setMinScore,
    applyAgentDashboard,
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
    if (isAdmin) {
      // Keep admin list aligned with board tiles (no leftover applicant filters).
      applyAgentDashboard({ reset: true, view: next, remote_only: false, min_match_score: 0 });
      return;
    }
    setView(next);
  }, [isAdmin, applyAgentDashboard, setView]);

  const handleTitleFilter = useCallback((value: string) => {
    setTitleFilter(value);
  }, [setTitleFilter]);

  const handleCompanyFilter = useCallback((value: string) => {
    setCompanyFilter(value);
  }, [setCompanyFilter]);

  // Extraction failures belong on the dedicated Extraction failed board only —
  // never on the admin main table. Failures are also stored as UJS "duplicated"
  // for applicants; that hide still applies outside the failed board.
  const displayedJobs: DashboardJob[] =
    view === 'extraction_failed'
      ? jobs
      : jobs.filter((j) => {
          if (j.user_status === 'duplicated' || j.user_status === 'manual_hidden') {
            return false;
          }
          if (
            isAdmin &&
            (j.status === 'extraction_failed' ||
              String(j.extraction_status || '').toLowerCase() === 'failed')
          ) {
            return false;
          }
          return true;
        });

  const refreshStats = useCallback(
    (opts?: { silent?: boolean }) => {
      void loadStats({ silent: opts?.silent, isAdmin });
    },
    [loadStats, isAdmin],
  );

  useEffect(() => {
    // Admin ops views must not inherit applicant list filters (title/company/remote/score).
    // Sheets / Pumble boards are applicant-only — bounce admin off those views.
    if (isAdmin) {
      const s = useScraperStore.getState();
      if (s.view === 'sheet_posted' || s.view === 'pumble_posted') {
        applyAgentDashboard({ reset: true, view: 'today', remote_only: false, min_match_score: 0 });
        return;
      }
      if (
        s.titleFilter ||
        s.companyFilter ||
        s.remoteOnly ||
        s.minScore > 0 ||
        s.sourceFilter ||
        s.searchQuery
      ) {
        useScraperStore.setState({
          titleFilter: '',
          companyFilter: '',
          remoteOnly: false,
          minScore: 0,
          sourceFilter: '',
          searchQuery: '',
          page: 1,
        });
      }
    }
    loadJobs();
    refreshStats();
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
  }, [isAdmin, applyAgentDashboard]);

  // Poll every 6 s while any job is mid-pipeline so dots/badges update live.
  useEffect(() => {
    const EXTRACTION_IN_PROGRESS = new Set(['pending', 'processing']);
    const RESUME_IN_PROGRESS     = new Set(['pending', 'processing']);
    const CONTENT_IN_PROGRESS = new Set(['pending', 'processing']);
    // EXTRACTED = shared JD ready (not in-progress). Analysis uses match_in_progress.
    const hasInProgress = jobs.some(
      (j) =>
        (j.match_overall_score == null &&
          j.extraction_status &&
          EXTRACTION_IN_PROGRESS.has(j.extraction_status)) ||
        (!isAdmin && j.match_in_progress === true) ||
        (j.content_generation_status && CONTENT_IN_PROGRESS.has(j.content_generation_status)) ||
        (j.resume_build_status && RESUME_IN_PROGRESS.has(j.resume_build_status)),
    );
    const adminExtractionBacklog =
      isAdmin &&
      adminStats != null &&
      (adminStats.needs_extraction_jobs > 0 || adminStats.extraction_pending_jobs > 0);

    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (hasInProgress || adminExtractionBacklog) {
      pollTimerRef.current = setTimeout(() => {
        void bgRefreshJobs();
        // Only refresh stats when extraction backlog exists (admin) or jobs are mid-pipeline.
        refreshStats({ silent: true });
      }, 6000);
    }

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [jobs, isAdmin, adminStats, bgRefreshJobs, refreshStats]);

  useEffect(() => {
    if (!syncing) return;
    const id = window.setInterval(() => {
      void checkSyncStatus();
      if (isAdmin) refreshStats({ silent: true });
    }, 10000);
    return () => window.clearInterval(id);
  }, [syncing, checkSyncStatus, isAdmin, refreshStats]);

  const activeBoardCount = (() => {
    if (!isAdmin || !adminStats) {
      if (view === 'applied') return stats?.applied_jobs ?? total;
      if (view === 'available') return stats?.available_jobs ?? total;
      if (view === 'ready') return stats?.ready_jobs ?? total;
      if (view === 'sheet_posted') return stats?.sheet_posted_jobs ?? total;
      if (view === 'pumble_posted') return stats?.pumble_posted_jobs ?? total;
      return undefined;
    }
    switch (view) {
      case 'needs_extraction':
        return adminStats.needs_extraction_jobs;
      case 'extracted':
        return adminStats.extracted_jobs;
      case 'extraction_failed':
        return adminStats.extraction_failed_jobs;
      case 'manual':
        return adminStats.manual_jobs;
      case 'applied_today':
        return adminStats.team_applied_today;
      case 'today':
        return adminStats.today_fetched ?? adminStats.today_scraped;
      case 'all':
        return adminStats.total_jobs;
      default:
        return undefined;
    }
  })();

  if (!booted) {
    return (
      <PageScrollArea alwaysShowScrollbar={false}>
        <BrandedLoader label="Loading your jobs…" />
      </PageScrollArea>
    );
  }

  return (
    <PageScrollArea alwaysShowScrollbar={false}>
    <div className="w-full min-w-0 space-y-4 px-2 py-4 sm:space-y-5 sm:px-3 sm:py-5 lg:px-4">
      <PageHeader
        icon={Briefcase}
        gradient="from-slate-700 to-slate-900"
        title="Jobs Dashboard"
        description={
          isAdmin
            ? 'Fetch listings, auto-extract job descriptions, and track the live JD backlog.'
            : 'Browse and manage processed job listings across all platforms.'
        }
        actions={
          <div className="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:justify-end">
            {!isAdmin && (
              <button
                type="button"
                onClick={openResumeAiCenter}
                title="Paste a job description and tailor your resume with AI"
                className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:shadow-md sm:flex-none"
              >
                <Wand2 size={15} className="shrink-0" />
                <span className="truncate">Tailor with AI</span>
              </button>
            )}
            <LlmProviderSelector />
          </div>
        }
      />

      {syncNotice ? (
        <SyncResultBanner
          notice={syncNotice}
          spiders={spiders}
          onDismiss={dismissSyncNotice}
        />
      ) : null}

      {/* z-0 keeps metric tiles below PageHeader menus (header is z-40). */}
      <div className="relative z-0">
        <ScraperStatsBar
          variant={isAdmin ? 'admin' : 'applicant'}
          stats={stats}
          adminStats={adminStats}
          loading={statsLoading}
          onSelectToday={() =>
            applyAgentDashboard({ reset: true, view: 'today', remote_only: false, min_match_score: 0 })
          }
          onSelectReady={() =>
            applyAgentDashboard({ reset: true, view: 'ready', remote_only: false, min_match_score: 0 })
          }
          onSelectBest={() =>
            applyAgentDashboard({ reset: true, view: 'all', remote_only: false, min_match_score: 75 })
          }
          onSelectGood={() =>
            applyAgentDashboard({ reset: true, view: 'suggested', remote_only: false, min_match_score: 0 })
          }
          onSelectAvg={() =>
            applyAgentDashboard({ reset: true, view: 'suggested', remote_only: false, min_match_score: 0 })
          }
          onSelectRemote={() =>
            applyAgentDashboard({ reset: true, view: 'all', remote_only: true, min_match_score: 0 })
          }
          onSelectAvailable={() =>
            applyAgentDashboard({ reset: true, view: 'available', remote_only: false, min_match_score: 0 })
          }
          onSelectApplied={() =>
            applyAgentDashboard({ reset: true, view: 'applied', remote_only: false, min_match_score: 0 })
          }
          onSelectSheet={() =>
            applyAgentDashboard({ reset: true, view: 'sheet_posted', remote_only: false, min_match_score: 0 })
          }
          onSelectPumble={() =>
            applyAgentDashboard({ reset: true, view: 'pumble_posted', remote_only: false, min_match_score: 0 })
          }
          onSelectMine={() =>
            applyAgentDashboard({ reset: true, view: 'mine', remote_only: false, min_match_score: 0 })
          }
          onSelectAll={() =>
            applyAgentDashboard({ reset: true, view: 'all', remote_only: false, min_match_score: 0 })
          }
          onSelectNeedsExtraction={() =>
            applyAgentDashboard({
              reset: true,
              view: 'needs_extraction',
              remote_only: false,
              min_match_score: 0,
            })
          }
          onSelectExtracted={() =>
            applyAgentDashboard({ reset: true, view: 'extracted', remote_only: false, min_match_score: 0 })
          }
          onSelectExtractionFailed={() =>
            applyAgentDashboard({
              reset: true,
              view: 'extraction_failed',
              remote_only: false,
              min_match_score: 0,
            })
          }
          onSelectManual={() =>
            applyAgentDashboard({ reset: true, view: 'manual', remote_only: false, min_match_score: 0 })
          }
          onSelectTeamAppliedToday={() =>
            applyAgentDashboard({
              reset: true,
              view: 'applied_today',
              remote_only: false,
              min_match_score: 0,
            })
          }
          onSelectPlatform={(source) =>
            applyAgentDashboard({
              reset: true,
              view: 'all',
              source,
              remote_only: false,
              min_match_score: 0,
            })
          }
        />
      </div>

      <div className="relative z-10 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 dark:border-slate-700 dark:bg-[#141d31]">
        {/*
          Toolbar rules:
          - Dividers are fixed-height (h-8), never self-stretch — stretch made the
            rule grow/shrink with wrapped filter rows and looked like it “moved”.
          - Filters keep intrinsic widths (no flex-1 4-col grid) so Match score is
            not crushed and the URL-side rule does not slide with compression.
          - URL + Duplicates take remaining width; side-by-side from xl up.
        */}
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-2.5">
            <div className="shrink-0">
              <DashboardViewSwitcher
                view={view}
                counts={counts}
                onChange={handleViewChange}
                isAdmin={isAdmin}
                adminStats={adminStats}
                activeCount={isAdmin ? total : activeBoardCount}
              />
            </div>

            {/* Applicant-only list filters — admins fetch/extract, they do not filter the job pool. */}
            {!isAdmin && (
              <>
                <span
                  aria-hidden
                  className="hidden h-8 w-px shrink-0 bg-slate-200 dark:bg-slate-600 min-[480px]:block"
                />
                <SearchInput
                  value={titleFilter}
                  onChange={handleTitleFilter}
                  placeholder="Filter by title"
                  icon={Briefcase}
                  variant="solid"
                  className="w-full min-w-0 basis-full min-[480px]:w-40 min-[480px]:basis-auto sm:w-44"
                />
                <SearchInput
                  value={companyFilter}
                  onChange={handleCompanyFilter}
                  placeholder="Filter by company"
                  icon={Building2}
                  variant="solid"
                  className="w-full min-w-0 basis-full min-[480px]:w-40 min-[480px]:basis-auto sm:w-44"
                />
                <RemoteFilterToggle
                  active={remoteOnly}
                  onChange={setRemoteOnly}
                  className="shrink-0"
                />
                <MatchScoreFilter
                  value={minScore}
                  onChange={setMinScore}
                  className="w-[10.5rem] shrink-0"
                />
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <span
              aria-hidden
              className="hidden h-8 w-px shrink-0 bg-slate-200 dark:bg-slate-600 xl:block"
            />
            <div className="min-w-0 flex-1 basis-0">
              <SubmitForm inline />
            </div>
            {!isAdmin && (
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
            )}
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
        isAdmin={isAdmin}
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
      {!isAdmin && dupOpen && (
        <DuplicatesModal onClose={() => setDupOpen(false)} isAdmin={false} />
      )}
    </div>
    </PageScrollArea>
  );
}
