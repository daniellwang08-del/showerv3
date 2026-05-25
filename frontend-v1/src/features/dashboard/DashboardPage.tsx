import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { DuplicateJobsPanel } from '../../components/DuplicateJobsPanel';
import { DetailContentPanel } from '../../components/DetailContentPanel';
import { GoogleSheetModal } from '../../components/GoogleSheetModal';
import Header from '../../components/Header';
import { NotificationBar } from '../../components/NotificationBar';
import SideDrawer from '../../components/SideDrawer';
import { SubmitForm } from '../../components/SubmitForm';
import { ValidJobsPanel } from '../../components/ValidJobsPanel';
import { DashboardPipelineStats } from '../../components/DashboardPipelineStats';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';
import { useFloatingButtonPosition } from '../../hooks/useFloatingButtonPosition';
import { useJobsStore } from '../../stores/jobsStore';
import { useUIStore } from '../../stores/uiStore';

type Props = {
  userEmail?: string;
  userName?: string;
  onLogout: () => void;
  onMyProfile: () => void;
};

export function DashboardPage({ userEmail, userName, onLogout, onMyProfile }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isDuplicatePanelOpen, setDuplicatePanelOpen] = useState(false);
  const [sheetModalOpen, setSheetModalOpen] = useState(false);

  useEscapeToClose(isDuplicatePanelOpen, () => setDuplicatePanelOpen(false));

  const floating = useFloatingButtonPosition('job_scraper:duplicates_button_pos:v1');

  const uniqueUrls = useJobsStore((s) => s.uniqueUrls);
  const duplicateUrls = useJobsStore((s) => s.duplicateUrls);
  const loadingLists = useJobsStore((s) => s.loadingLists);
  const validHasMore = useJobsStore((s) => s.validHasMore);

  const jobAnalysisValidJobId = useUIStore((s) => s.jobAnalysisValidJobId);
  const closeDetail = useUIStore((s) => s.closeDetail);
  const matchStored = useUIStore((s) => s.matchStored);
  const wsRefreshKey = useUIStore((s) => s.wsRefreshKey);

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
        onIntegrateSheet={() => setSheetModalOpen(true)}
        userEmail={userEmail}
        userName={userName}
      />

      {sheetModalOpen && <GoogleSheetModal onClose={() => setSheetModalOpen(false)} />}
      <NotificationBar />

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
            <ValidJobsPanel />

            <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden md:bg-gradient-to-b md:from-blue-50/40 md:to-white/70">
              <div className="glass-card shrink-0 rounded-2xl p-4">
                <h3 className="mb-2 text-lg font-semibold text-slate-900">Post a job</h3>
                <SubmitForm />
              </div>

              {jobAnalysisValidJobId ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <DetailContentPanel
                    validJobId={jobAnalysisValidJobId}
                    onClose={closeDetail}
                    onAnalysisUpdated={matchStored}
                    refreshKey={wsRefreshKey}
                  />
                </div>
              ) : (
                <DashboardPipelineStats
                  jobs={uniqueUrls}
                  duplicateCount={duplicateUrls.length}
                  loading={loadingLists}
                  jobsHasMore={validHasMore}
                  jobsLoadedCount={uniqueUrls.length}
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
              onClosePanel={() => setDuplicatePanelOpen(false)}
            >
              <></>
            </DuplicateJobsPanel>
          </div>
        </div>
      </div>
    </div>
  );
}
