import { useCallback, useEffect, useState } from 'react';
import { Login } from './components/Login';
import { Signup } from './components/Signup';
import { JobActionModal } from './components/JobActionModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { useAuth } from './hooks/useAuth';
import { useWebSocket, type WsEvent } from './hooks/useWebSocket';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ProfilesPage } from './features/profiles/ProfilesPage';
import { mainViewFromHash, navigateMainView, type MainView } from './mainViewRouting';
import { logger } from './utils/logger';
import { useJobsStore } from './stores/jobsStore';
import { useModalStore } from './stores/modalStore';
import { useUIStore } from './stores/uiStore';

function App() {
  const { isAuthenticated, user, authPage, setAuthPage, logout, onAuthSuccess } = useAuth();
  const [mainView, setMainView] = useState<MainView>(() =>
    typeof window !== 'undefined' ? mainViewFromHash() : 'dashboard',
  );

  const refreshLists = useJobsStore((s) => s.refreshLists);
  const debouncedRefresh = useJobsStore((s) => s.debouncedRefresh);
  const bumpWsRefreshKey = useUIStore((s) => s.bumpWsRefreshKey);

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

  useEffect(() => {
    const onHashChange = () => setMainView(mainViewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    setMainView(mainViewFromHash());
  }, [isAuthenticated]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-job-menu-root="true"]')) return;
      useUIStore.getState().setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      void refreshLists({ showLoading: true, reset: true });
    }
  }, [isAuthenticated, refreshLists]);

  const handleWsEvent = useCallback((event: WsEvent) => {
    logger.info(`ws_event_${event.type}`, { event_data: event });
    const actionable =
      event.type === 'extraction_started' ||
      event.type === 'extraction_completed' ||
      event.type === 'extraction_failed' ||
      event.type === 'match_started' ||
      event.type === 'match_completed' ||
      event.type === 'match_failed' ||
      event.type === 'job_demoted';
    if (actionable) {
      debouncedRefresh();
      bumpWsRefreshKey();
    }

    const resumeActionable =
      event.type === 'tailored_content_started' ||
      event.type === 'tailored_content_completed' ||
      event.type === 'tailored_content_failed' ||
      event.type === 'resume_build_started' ||
      event.type === 'resume_build_completed' ||
      event.type === 'resume_build_failed' ||
      event.type === 'resume_file_processing' ||
      event.type === 'resume_file_ready' ||
      event.type === 'resume_file_failed';
    if (resumeActionable) {
      bumpWsRefreshKey();
    }
  }, [debouncedRefresh, bumpWsRefreshKey]);

  useWebSocket(!!isAuthenticated, handleWsEvent);

  const onMyProfile = useCallback(() => navigateMainView('profiles'), []);
  const onBackFromProfiles = useCallback(() => navigateMainView('dashboard'), []);

  if (isAuthenticated === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50 text-slate-900">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return authPage === 'signup' ? (
      <Signup onSignup={onAuthSuccess} onSwitchToLogin={() => setAuthPage('login')} />
    ) : (
      <Login onLogin={onAuthSuccess} onSwitchToSignup={() => setAuthPage('signup')} />
    );
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
        title="Delete duplicate entries?"
        description={
          batchDeletePending && batchDeletePending.length > 0 ? (
            <>
              You are about to permanently remove{' '}
              <span className="font-semibold tabular-nums text-slate-800">{batchDeletePending.length}</span>{' '}
              duplicate entr{batchDeletePending.length === 1 ? 'y' : 'ies'} from your list. Related inactive job rows
              and orphan extraction data will be removed. This action cannot be undone.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        loading={batchDeleteSubmitting}
        error={batchDeleteError}
        onConfirm={() => void executeBatchDeleteInvalid()}
        onCancel={closeBatchDeleteConfirm}
      />

      {mainView === 'profiles' ? (
        <ProfilesPage
          onBack={onBackFromProfiles}
          onLogout={logout}
          userEmail={user?.email}
          userName={user?.name ?? undefined}
        />
      ) : (
        <DashboardPage
          userEmail={user?.email}
          userName={user?.name ?? undefined}
          onLogout={logout}
          onMyProfile={onMyProfile}
        />
      )}
    </>
  );
}

export default App;
