import { useEffect, useCallback, useRef, useState } from 'react';
import { useScraperStore } from '../stores/scraperStore';
import { useJobsStore } from '../stores/jobsStore';
import { apiClient } from '../api/client';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { ScraperStatsBar } from '../components/scraper/ScraperStatsBar';
import { ScraperJobsTable } from '../components/scraper/ScraperJobsTable';
import { SyncButton } from '../components/scraper/SyncButton';
import { Pagination } from '../components/shared/Pagination';
import { ScraperAISearch, type AiSearchState } from '../components/scraper/ScraperAISearch';
import { SubmitForm } from '../components/extraction/SubmitForm';
import { DuplicatesModal } from '../components/scraper/DuplicatesModal';
import { ResumeTemplateAlertBar } from '../components/shared/ResumeTemplateAlertBar';
import { useFloatingButtonPosition } from '../hooks/useFloatingButtonPosition';
import { AlertTriangle, Sparkles, Link } from 'lucide-react';
import type { DashboardJob } from '../types/scraper';

export function ScraperDashboard() {
  const {
    jobs, total, page, perPage, pages, loading,
    stats, statsLoading,
    spiders,
    syncing,
    syncProgress,
    sortField, sortOrder,
    loadJobs, bgRefreshJobs, loadStats, loadSpiders, checkSyncStatus, startSync,
    setPage, setPerPage, setSort,
  } = useScraperStore();

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Duplicates modal + floating button
  const [dupOpen, setDupOpen] = useState(false);
  const duplicateCount = useJobsStore((s) => s.invalidCounts.total);
  const refreshLists    = useJobsStore((s) => s.refreshLists);
  const floating       = useFloatingButtonPosition('job_scraper:scraper_dup_btn_pos:v1');

  // AI search state — when active, table shows AI results instead of paginated list
  const [aiSearch, setAiSearch] = useState<AiSearchState>({
    active: false, results: [], total: 0, rationale: null,
  });

  const handleAiResults = useCallback((state: AiSearchState) => {
    setAiSearch(state);
  }, []);

  const handleAiClear = useCallback(() => {
    setAiSearch({ active: false, results: [], total: 0, rationale: null });
  }, []);

  const handleAppliedStateChange = useCallback((patches: Array<{
    id: string;
    applied_at: string | null;
    applied_by_name: string | null;
  }>) => {
    if (patches.length === 0) return;
    setAiSearch((prev) => {
      if (!prev.active || prev.results.length === 0) return prev;
      const byId = new Map(patches.map((p) => [p.id, p]));
      let changed = false;
      const results = prev.results.map((row) => {
        const patch = byId.get(row.id);
        if (!patch) return row;
        if (row.applied_at === patch.applied_at && row.applied_by_name === patch.applied_by_name) {
          return row;
        }
        changed = true;
        return { ...row, applied_at: patch.applied_at, applied_by_name: patch.applied_by_name };
      });
      return changed ? { ...prev, results } : prev;
    });
  }, []);

  const handleSheetPostedStateChange = useCallback((patches: Array<{
    id: string;
    sheet_posted_at: string | null;
  }>) => {
    if (patches.length === 0) return;
    setAiSearch((prev) => {
      if (!prev.active || prev.results.length === 0) return prev;
      const byId = new Map(patches.map((p) => [p.id, p]));
      let changed = false;
      const results = prev.results.map((row) => {
        const patch = byId.get(row.id);
        if (!patch) return row;
        if (row.sheet_posted_at === patch.sheet_posted_at) return row;
        changed = true;
        return { ...row, sheet_posted_at: patch.sheet_posted_at };
      });
      return changed ? { ...prev, results } : prev;
    });
  }, []);

  const activeJobs = jobs.filter((j) => j.user_status !== 'duplicated' && j.user_status !== 'manual_hidden');
  const displayedJobs: DashboardJob[] = aiSearch.active ? aiSearch.results : activeJobs;

  useEffect(() => {
    loadJobs();
    loadStats();
    loadSpiders();
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
        <SyncButton syncing={syncing} syncProgress={syncProgress} spiders={spiders} onSync={handleSync} />
      </div>

      <ScraperStatsBar stats={stats} loading={statsLoading} />

      <ResumeTemplateAlertBar />

      {/* ── AI search + Add job URL ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 px-0.5 flex items-center gap-1.5">
            <Sparkles size={11} className="text-indigo-400" />
            AI Search
          </span>
          <ScraperAISearch
            onResults={handleAiResults}
            onClear={handleAiClear}
            isActive={aiSearch.active}
            resultCount={aiSearch.results.length}
            totalMatching={aiSearch.total}
            rationale={aiSearch.rationale}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 px-0.5 flex items-center gap-1.5">
            <Link size={11} className="text-blue-400" />
            Add job URL
          </span>
          <SubmitForm />
        </div>
      </div>

      {/* ── Jobs table ──────────────────────────────────────────────────── */}
      <ScraperJobsTable
        jobs={displayedJobs}
        loading={loading && !aiSearch.active}
        sortField={sortField}
        sortOrder={sortOrder}
        onSort={aiSearch.active ? () => {} : setSort}
        rowOffset={aiSearch.active ? 0 : (page - 1) * perPage}
        onAppliedStateChange={handleAppliedStateChange}
        onSheetPostedStateChange={handleSheetPostedStateChange}
      />

      {/* Pagination only when not in AI search mode */}
      {!aiSearch.active && total > 0 && (
        <Pagination
          page={page}
          pages={pages}
          total={total}
          perPage={perPage}
          onPageChange={setPage}
          onPerPageChange={setPerPage}
        />
      )}

      {/* ── Draggable Duplicates FAB ─────────────────────────────────────── */}
      <button
        ref={floating.ref}
        type="button"
        onPointerDown={floating.handlers.onPointerDown}
        onPointerMove={floating.handlers.onPointerMove}
        onPointerUp={(e) => {
          const { wasDrag } = floating.handlers.onPointerUp(e);
          if (!wasDrag) setDupOpen(true);
        }}
        onPointerCancel={floating.handlers.onPointerCancel}
        className={[
          'fixed z-50 touch-none rounded-l-xl rounded-r-md border px-3 py-2 shadow-lg',
          'transition focus:outline-none focus:ring-2 focus:ring-blue-400',
          dupOpen
            ? 'border-blue-300 bg-blue-100 text-blue-800'
            : 'border-blue-400 btn-blue-neon text-white',
        ].join(' ')}
        style={floating.pos ? { left: floating.pos.x, top: floating.pos.y } : undefined}
        aria-label="Open duplicates panel"
        title="View duplicate jobs"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4" />
          <span>Duplicates</span>
          {duplicateCount > 0 && (
            <span className={[
              'inline-flex min-w-6 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-bold',
              dupOpen ? 'bg-white text-blue-700' : 'bg-blue-100 text-blue-700',
            ].join(' ')}>
              {duplicateCount}
            </span>
          )}
        </span>
      </button>

      {/* ── Duplicates modal ─────────────────────────────────────────────── */}
      {dupOpen && <DuplicatesModal onClose={() => setDupOpen(false)} />}
    </div>
    </PageScrollArea>
  );
}
