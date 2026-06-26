import { useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useWebSocket, type WsEvent } from './hooks/useWebSocket';
import { useScraperStore } from './stores/scraperStore';
import { useJobsStore } from './stores/jobsStore';
import { useModalStore } from './stores/modalStore';
import { AppShell } from './components/layout/AppShell';
import { ScraperDashboard } from './pages/ScraperDashboard';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { ResumeTemplateBuilderPage } from './pages/ResumeTemplateBuilderPage';
import { ResumeBuilderPage } from './pages/ResumeBuilderPage';
import { AuthScreen } from './components/extraction/AuthScreen';
import { JobActionModal } from './components/extraction/JobActionModal';
import { ConfirmDialog } from './components/extraction/ConfirmDialog';

function App() {
  const { isAuthenticated, user, authPage, logout, onAuthSuccess } = useAuth();

  const modal = useModalStore((s) => s.modal);
  const modalUrl = useModalStore((s) => s.modalUrl);
  const modalReason = useModalStore((s) => s.modalReason);
  const modalDuplicateOf = useModalStore((s) => s.modalDuplicateOf);
  const modalSubmitting = useModalStore((s) => s.modalSubmitting);
  const modalError = useModalStore((s) => s.modalError);
  const closeModal = useModalStore((s) => s.closeModal);
  const confirmModal = useModalStore((s) => s.confirmModal);
  const setModalUrl = useModalStore((s) => s.setModalUrl);
  const setModalReason = useModalStore((s) => s.setModalReason);
  const setModalDuplicateOf = useModalStore((s) => s.setModalDuplicateOf);

  const batchDeletePending = useJobsStore((s) => s.batchDeletePending);
  const batchDeleteSubmitting = useJobsStore((s) => s.batchDeleteSubmitting);
  const batchDeleteError = useJobsStore((s) => s.batchDeleteError);
  const closeBatchDeleteConfirm = useJobsStore((s) => s.closeBatchDeleteConfirm);
  const executeBatchDeleteInvalid = useJobsStore((s) => s.executeBatchDeleteInvalid);

  const handleWsEvent = useCallback((event: WsEvent) => {
    const scraperEvents = [
      'sync_started',
      'sync_spider_started',
      'sync_activity',
      'sync_progress',
      'sync_completed',
      'sync_failed',
    ];
    if (scraperEvents.includes(event.type)) {
      useScraperStore.getState().handleSyncWsEvent(event);
      if (event.type === 'sync_completed' || event.type === 'sync_failed') {
        useScraperStore.getState().loadJobs();
        void useScraperStore.getState().loadStats({ silent: true });
        useScraperStore.getState().checkSyncStatus();
      }
      return;
    }

    if (event.type === 'scrape_promoted') {
      useScraperStore.getState().loadJobs();
      void useScraperStore.getState().loadStats({ silent: true });
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
    }

    if (event.type === 'job_submitted') {
      void useScraperStore.getState().refreshAfterJobSubmit();
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
    }

    if (event.type === 'job_excluded_for_user' || event.type === 'extraction_failed') {
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
      useScraperStore.getState().bgRefreshJobs();
    }

    const pipelineEvents = [
      'extraction_completed',
      'extraction_failed',
      'match_started',
      'match_completed',
      'match_failed',
      'tailored_content_started',
      'tailored_content_completed',
      'tailored_content_failed',
      'resume_build_started',
      'resume_build_completed',
      'resume_build_failed',
    ];
    if (pipelineEvents.includes(event.type)) {
      useScraperStore.getState().bgRefreshJobs();
      void useScraperStore.getState().loadStats({ silent: true });
    }

    if (event.type === 'company_policy_reconcile_completed') {
      useScraperStore.getState().bgRefreshJobs();
      void useScraperStore.getState().loadStats({ silent: true });
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
    }
  }, []);

  useWebSocket(!!isAuthenticated, handleWsEvent);

  if (isAuthenticated === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-600">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthScreen onAuthSuccess={onAuthSuccess} initialMode={authPage} />;
  }

  return (
    <>
      <JobActionModal
        modal={modal}
        modalUrl={modalUrl}
        onModalUrlChange={setModalUrl}
        modalReason={modalReason}
        onModalReasonChange={setModalReason}
        modalDuplicateOf={modalDuplicateOf}
        onModalDuplicateOfChange={setModalDuplicateOf}
        modalSubmitting={modalSubmitting}
        modalError={modalError}
        onClose={closeModal}
        onConfirm={confirmModal}
      />

      <ConfirmDialog
        open={batchDeletePending != null}
        title="Dismiss duplicate entries?"
        description={
          batchDeletePending && batchDeletePending.length > 0 ? (
            <>
              <span className="font-semibold tabular-nums text-slate-800">{batchDeletePending.length}</span>{' '}
              duplicate entr{batchDeletePending.length === 1 ? 'y' : 'ies'} will be hidden from your list.
              The underlying jobs are preserved and other users are not affected.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Dismiss"
        cancelLabel="Cancel"
        variant="danger"
        loading={batchDeleteSubmitting}
        error={batchDeleteError}
        onConfirm={() => void executeBatchDeleteInvalid()}
        onCancel={closeBatchDeleteConfirm}
      />

      <Routes>
        <Route
          element={
            <AppShell
              userEmail={user?.email}
              userName={user?.name ?? undefined}
              onLogout={logout}
            />
          }
        >
          <Route path="/scraper" element={<ScraperDashboard />} />
          <Route path="/profile" element={<ProfilePage user={user} onLogout={logout} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/resume-builder" element={<ResumeBuilderPage />} />
          <Route path="/settings/resume-template" element={<ResumeTemplateBuilderPage />} />
          <Route path="*" element={<Navigate to="/scraper" replace />} />
        </Route>
      </Routes>
    </>
  );
}

export default App;
