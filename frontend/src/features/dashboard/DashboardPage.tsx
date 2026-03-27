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
  onMarkApplied: (items: SubmittedUrlItem[], userInitial: string) => void;
  onMarkUnapplied: (items: SubmittedUrlItem[]) => void;
  onOpenSelectedUrls: (items: SubmittedUrlItem[]) => void;
  onShowScrapedContent: (item: SubmittedUrlItem) => void;
  onShowJobMatch: (item: SubmittedUrlItem) => void;
  onTriggerJobMatch: (item: SubmittedUrlItem) => void;
  onJobUrlClick: (item: SubmittedUrlItem) => void;
  onRescrape: (item: SubmittedUrlItem) => void;
  userInitial: string;

  // detail panel
  detailMode: 'scraped' | 'jobmatch' | null;
  scrapedContentExtractionId: string | null;
  jobMatchValidJobId: string | null;
  onCloseDetail: () => void;
  onMatchStored: () => void;

  // compare helpers
  onCompareDuplicate: (item: SubmittedUrlItem) => void;
  onReplaceDuplicate: (item: SubmittedUrlItem) => void;
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
  onShowScrapedContent,
  onShowJobMatch,
  onTriggerJobMatch,
  onJobUrlClick,
  onRescrape,
  userInitial,
  detailMode,
  scrapedContentExtractionId,
  jobMatchValidJobId,
  onCloseDetail,
  onMatchStored,
  onCompareDuplicate,
  onReplaceDuplicate,
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 text-slate-900">
      <Header
        onToggleDrawer={() => setDrawerOpen((s) => !s)}
        onLogout={onLogout}
        onMyProfile={onMyProfile}
        userEmail={userEmail}
        userName={userName}
      />

      <div className="flex min-h-screen">
        <SideDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onMyProfile={onMyProfile} />

        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="grid min-h-screen grid-cols-1 md:grid-cols-2 min-w-0">
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
              onShowScrapedContent={onShowScrapedContent}
              onShowJobMatch={onShowJobMatch}
              onTriggerJobMatch={onTriggerJobMatch}
              onJobUrlClick={onJobUrlClick}
              onRescrape={onRescrape}
              userInitial={userInitial}
            />

            <div className="flex min-h-screen min-w-0 flex-col overflow-hidden md:bg-gradient-to-b md:from-purple-50/50 md:to-white">
              <div className="p-4 rounded-xl border border-slate-200 bg-white shadow-sm">
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

              {detailMode ? (
                <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
                  <DetailContentPanel
                    mode={detailMode}
                    extractionId={scrapedContentExtractionId}
                    validJobId={jobMatchValidJobId}
                    onClose={onCloseDetail}
                    onMatchStored={onMatchStored}
                  />
                </div>
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1" />
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
          className={`fixed z-50 rounded-l-xl rounded-r-md border px-3 py-2 shadow-lg transition focus:outline-none focus:ring-2 focus:ring-orange-400 touch-none ${
            isDuplicatePanelOpen
              ? 'border-orange-300 bg-orange-100 text-orange-800'
              : 'border-orange-400 bg-orange-600 text-white hover:bg-orange-500'
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
                isDuplicatePanelOpen ? 'bg-white text-orange-700' : 'bg-orange-100 text-orange-700'
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
          className={`fixed right-0 top-1/2 z-50 h-[72vh] w-[min(620px,92vw)] -translate-y-1/2 rounded-l-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden transition-transform duration-300 ease-out ${
            isDuplicatePanelOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          role="dialog"
          aria-modal="true"
          aria-label="Duplicate jobs panel"
        >
          <div className="h-full overflow-auto p-4">
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
              onDelete={onDelete}
            >
              <></>
            </DuplicateJobsPanel>
          </div>
        </div>
      </div>
    </div>
  );
}

