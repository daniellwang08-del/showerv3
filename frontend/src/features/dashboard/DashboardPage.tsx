import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { SubmittedUrlItem } from '../../types/ui';
import { DuplicateJobsPanel } from '../../components/DuplicateJobsPanel';
import { DetailContentPanel } from '../../components/DetailContentPanel';
import Header from '../../components/Header';
import SideDrawer from '../../components/SideDrawer';
import { SubmitForm } from '../../components/SubmitForm';
import { ValidJobsPanel } from '../../components/ValidJobsPanel';
import { DashboardPipelineStats } from '../../components/DashboardPipelineStats';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';
import { useFloatingButtonPosition } from '../../hooks/useFloatingButtonPosition';

type Props = {
  userEmail?: string;
  userName?: string;
  onLogout: () => void;
  onMyProfile: () => void;

  // jobs data + handlers
  uniqueUrls: SubmittedUrlItem[];
  duplicateUrls: SubmittedUrlItem[];
  loadingLists: boolean;
  url: string;
  submitNotice: string;
  submitNoticeKind: 'success' | 'warning';
  submitError: string;
  loading: boolean;
  onUrlChange: (next: string) => void;
  onSubmit: (e: FormEvent) => void;

  openMenu: { table: 'valid' | 'invalid'; id: string } | null;
  setOpenMenu: Dispatch<SetStateAction<{ table: 'valid' | 'invalid'; id: string } | null>>;

  compareValidJobId: string | null;
  onEdit: (item: SubmittedUrlItem) => void;
  onReportInvalid: (item: SubmittedUrlItem) => void;
  onReportDuplicate: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onBatchDelete: (items: SubmittedUrlItem[]) => void;
  onMarkApplied: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onMarkUnapplied: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onOpenSelectedUrls: (items: SubmittedUrlItem[]) => void;
  onOpenJobAnalysis: (item: SubmittedUrlItem) => void;
  onTriggerJobMatch: (item: SubmittedUrlItem, opts?: { force?: boolean }) => void | Promise<void>;
  onRerunMatchAnalysis: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onBatchRescrapePipeline: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onJobUrlClick: (item: SubmittedUrlItem) => void;
  onRescrape: (item: SubmittedUrlItem) => void;

  // detail panel
  jobAnalysisValidJobId: string | null;
  onCloseDetail: () => void;
  onMatchStored: () => void;

  // compare helpers
  onCompareDuplicate: (item: SubmittedUrlItem) => void;
  onReplaceDuplicate: (item: SubmittedUrlItem) => void;
  onReportDuplicateAsValid: (item: SubmittedUrlItem) => void;
  onBatchDeleteInvalid?: (items: SubmittedUrlItem[]) => void | Promise<void>;

  jobListHasMore?: boolean;
  loadingMoreValidJobs?: boolean;
  onLoadMoreValidJobs?: () => void;
  validJobsLoadedCount?: number;
  duplicateListHasMore?: boolean;
  loadingMoreDuplicates?: boolean;
  onLoadMoreDuplicates?: () => void;
  duplicatesLoadedCount?: number;
};

export function DashboardPage({
  userEmail,
  userName,
  onLogout,
  onMyProfile,
  uniqueUrls,
  duplicateUrls,
  loadingLists,
  url,
  submitNotice,
  submitNoticeKind,
  submitError,
  loading,
  onUrlChange,
  onSubmit,
  openMenu,
  setOpenMenu,
  compareValidJobId,
  onEdit,
  onReportInvalid,
  onReportDuplicate,
  onDelete,
  onBatchDelete,
  onMarkApplied,
  onMarkUnapplied,
  onOpenSelectedUrls,
  onOpenJobAnalysis,
  onTriggerJobMatch,
  onRerunMatchAnalysis,
  onBatchRescrapePipeline,
  onJobUrlClick,
  onRescrape,
  jobAnalysisValidJobId,
  onCloseDetail,
  onMatchStored,
  onCompareDuplicate,
  onReplaceDuplicate,
  onReportDuplicateAsValid,
  onBatchDeleteInvalid,
  jobListHasMore,
  loadingMoreValidJobs,
  onLoadMoreValidJobs,
  validJobsLoadedCount,
  duplicateListHasMore,
  loadingMoreDuplicates,
  onLoadMoreDuplicates,
  duplicatesLoadedCount,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isDuplicatePanelOpen, setDuplicatePanelOpen] = useState(false);

  useEscapeToClose(isDuplicatePanelOpen, () => setDuplicatePanelOpen(false));

  const floating = useFloatingButtonPosition('job_scraper:duplicates_button_pos:v1');

  const handleToggleDuplicates = useCallback(() => {
    setDuplicatePanelOpen((prev) => !prev);
  }, []);

  const overlayStyle = useMemo(
    () => ({
      opacity: isDuplicatePanelOpen ? 1 : 0,
      pointerEvents: isDuplicatePanelOpen ? ('auto' as const) : ('none' as const),
    }),
    [isDuplicatePanelOpen],
  );

  return (
    <div className="app-surface h-[100dvh] overflow-hidden text-slate-900 flex flex-col">
      <Header
        onToggleDrawer={() => setDrawerOpen((s) => !s)}
        onLogout={onLogout}
        onMyProfile={onMyProfile}
        userEmail={userEmail}
        userName={userName}
      />

      <div className="flex flex-1 min-h-0">
        <SideDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onMyProfile={onMyProfile}
          onGoDashboard={() => setDrawerOpen(false)}
          activeItem="dashboard"
        />

        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 p-3 md:grid-cols-2 md:grid-rows-1">
            <ValidJobsPanel
              items={uniqueUrls}
              compareValidJobId={compareValidJobId}
              openMenuId={openMenu?.table === 'valid' ? openMenu.id : null}
              onToggleMenu={(id) => {
                setOpenMenu((prev) => (prev?.table === 'valid' && prev.id === id ? null : { table: 'valid', id }));
              }}
              onEdit={onEdit}
              onReportInvalid={onReportInvalid}
              onReportDuplicate={onReportDuplicate}
              onDelete={onDelete}
              onBatchDelete={onBatchDelete}
              onMarkApplied={onMarkApplied}
              onMarkUnapplied={onMarkUnapplied}
              onOpenSelectedUrls={onOpenSelectedUrls}
              onOpenJobAnalysis={onOpenJobAnalysis}
              onTriggerJobMatch={onTriggerJobMatch}
              onRerunMatchAnalysis={onRerunMatchAnalysis}
              onBatchRescrapePipeline={onBatchRescrapePipeline}
              onJobUrlClick={onJobUrlClick}
              onRescrape={onRescrape}
              jobListHasMore={jobListHasMore}
              loadingMoreJobs={loadingMoreValidJobs}
              onLoadMoreJobs={onLoadMoreValidJobs}
              jobsLoadedCount={validJobsLoadedCount}
            />

            <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden md:bg-gradient-to-b md:from-blue-50/40 md:to-white/70">
              <div className="glass-card shrink-0 rounded-2xl p-4">
                <h3 className="mb-2 text-lg font-semibold text-slate-900">Post a job</h3>
                <SubmitForm
                  url={url}
                  onUrlChange={onUrlChange}
                  loading={loading}
                  onSubmit={onSubmit}
                  submitNotice={submitNotice}
                  submitNoticeKind={submitNoticeKind}
                  submitError={submitError}
                />
              </div>

              {jobAnalysisValidJobId ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <DetailContentPanel
                    validJobId={jobAnalysisValidJobId}
                    onClose={onCloseDetail}
                    onAnalysisUpdated={onMatchStored}
                  />
                </div>
              ) : (
                <DashboardPipelineStats
                  jobs={uniqueUrls}
                  duplicateCount={duplicateUrls.length}
                  loading={loadingLists}
                  jobsHasMore={jobListHasMore}
                  jobsLoadedCount={validJobsLoadedCount}
                />
              )}
            </div>
          </div>
        </div>

        <button
          ref={floating.ref}
          type="button"
          onPointerDown={floating.handlers.onPointerDown}
          onPointerMove={floating.handlers.onPointerMove}
          onPointerUp={(e) => {
            const { wasDrag } = floating.handlers.onPointerUp(e);
            if (!wasDrag) handleToggleDuplicates();
          }}
          onPointerCancel={floating.handlers.onPointerCancel}
          className={`fixed z-50 rounded-l-xl rounded-r-md border px-3 py-2 shadow-lg transition focus:outline-none focus:ring-2 focus:ring-blue-400 touch-none ${
            isDuplicatePanelOpen
              ? 'border-blue-300 bg-blue-100 text-blue-800'
              : 'border-blue-400 btn-blue-neon text-white'
          }`}
          style={floating.pos ? { left: floating.pos.x, top: floating.pos.y } : undefined}
          aria-label={isDuplicatePanelOpen ? 'Close duplicates panel' : 'Open duplicates panel'}
          title={isDuplicatePanelOpen ? 'Close duplicates panel' : 'Open duplicates panel'}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4" />
            <span>Duplicates</span>
            <span
              className={`inline-flex min-w-6 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-bold ${
                isDuplicatePanelOpen ? 'bg-white text-blue-700' : 'bg-blue-100 text-blue-700'
              }`}
            >
              {duplicateUrls.length}
            </span>
            {isDuplicatePanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </span>
        </button>

        <div
          className="fixed inset-0 z-40 bg-slate-900/25 backdrop-blur-[1px] transition-opacity duration-300"
          style={overlayStyle}
          onClick={() => setDuplicatePanelOpen(false)}
        />

        <div
          className={`fixed right-0 top-1/2 z-[60] h-[72vh] w-[min(620px,92vw)] -translate-y-1/2 rounded-l-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden transition-transform duration-300 ease-out ${
            isDuplicatePanelOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          role="dialog"
          aria-modal="true"
          aria-label="Duplicate jobs panel"
        >
          <div className="h-full overflow-auto p-4 bg-gradient-to-b from-blue-50/80 via-white to-blue-50/40">
            <DuplicateJobsPanel
              loadingLists={loadingLists}
              items={duplicateUrls}
              openMenuId={openMenu?.table === 'invalid' ? openMenu.id : null}
              onToggleMenu={(id) => {
                setOpenMenu((prev) => (prev?.table === 'invalid' && prev.id === id ? null : { table: 'invalid', id }));
              }}
              onCloseMenu={() => setOpenMenu(null)}
              onClosePanel={() => setDuplicatePanelOpen(false)}
              onCompare={onCompareDuplicate}
              onReplace={onReplaceDuplicate}
              onReportAsValid={onReportDuplicateAsValid}
              onDelete={onDelete}
              onBatchDeleteInvalid={onBatchDeleteInvalid}
              duplicateListHasMore={duplicateListHasMore}
              loadingMoreDuplicates={loadingMoreDuplicates}
              onLoadMoreDuplicates={onLoadMoreDuplicates}
              duplicatesLoadedCount={duplicatesLoadedCount}
            >
              <></>
            </DuplicateJobsPanel>
          </div>
        </div>
      </div>
    </div>
  );
}

