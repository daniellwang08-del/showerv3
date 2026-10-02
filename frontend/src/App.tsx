import { lazy, Suspense, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useWebSocket, type WsEvent } from './hooks/useWebSocket';
import { useScraperStore } from './stores/scraperStore';
import { useJobsStore } from './stores/jobsStore';
import { useModalStore } from './stores/modalStore';
import { useUIStore } from './stores/uiStore';
import { AppShell } from './components/layout/AppShell';
import { BrandedLoader } from './components/layout/BrandedLoader';
import { LandingPage } from './pages/LandingPage';
import { ScraperDashboard } from './pages/ScraperDashboard';
import { ProfilePage } from './pages/ProfilePage';
import { MyPreferencesPage } from './pages/MyPreferencesPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { BillingPage } from './pages/BillingPage';
// Code-split the heaviest / role-gated pages so applicants never download the
// admin bundles (System Settings + User Management) and vice-versa.
const ResumeBuilderPage = lazy(() =>
  import('./pages/ResumeBuilderPage').then((m) => ({ default: m.ResumeBuilderPage })),
);
const DataAnalysisManagementPage = lazy(() =>
  import('./pages/DataManagementPage').then((m) => ({ default: m.DataAnalysisManagementPage })),
);
const UserManagementPage = lazy(() =>
  import('./pages/UserManagementPage').then((m) => ({ default: m.UserManagementPage })),
);
const SystemSettingsPage = lazy(() =>
  import('./pages/SystemSettingsPage').then((m) => ({ default: m.SystemSettingsPage })),
);
const SystemLogsPage = lazy(() =>
  import('./pages/SystemLogsPage').then((m) => ({ default: m.SystemLogsPage })),
);
const JobAnalysisPage = lazy(() =>
  import('./pages/JobAnalysisPage').then((m) => ({ default: m.JobAnalysisPage })),
);
import { AuthScreen } from './components/extraction/AuthScreen';
import { JobActionModal } from './components/extraction/JobActionModal';
import { ConfirmDialog } from './components/extraction/ConfirmDialog';
import { NotificationToasts } from './components/shared/NotificationToasts';

function isLogsHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'logs.atomspace.it.com' || host.startsWith('logs.');
}

function AdminOnly({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  if (!isAdmin) {
    if (isLogsHost()) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-center dark:bg-[var(--app-bg)]">
          <div className="max-w-md space-y-2">
            <p className="text-lg font-semibold text-slate-900 dark:text-white">Admins only</p>
            <p className="text-sm text-slate-600 dark:text-[var(--app-muted)]">
              System logs require an admin account. Sign in at{' '}
              <a className="text-sky-700 underline dark:text-sky-300" href="https://atomspace.it.com/login">
                atomspace.it.com
              </a>{' '}
              with an admin user, then open this site again.
            </p>
          </div>
        </div>
      );
    }
    return <Navigate to="/scraper" replace />;
  }
  return <>{children}</>;
}

/** Applicant-only tools — admins prepare shared jobs and manage the platform. */
function ApplicantOnly({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  if (isAdmin) {
    return <Navigate to="/scraper" replace />;
  }
  return <>{children}</>;
}

function App() {
  const { isAuthenticated, user, authPage, logout, onAuthSuccess, refreshUser } = useAuth();
  const navigate = useNavigate();

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
        void useScraperStore.getState().refreshAfterJobSubmit();
        useScraperStore.getState().checkSyncStatus();
      }
      return;
    }

    if (event.type === 'scrape_promoted') {
      void useScraperStore.getState().refreshAfterJobSubmit();
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

    if (event.type === 'match_failed') {
      const detail = (event.error || event.message || 'Match analysis failed').trim();
      useUIStore.getState().notify('error', detail, 8000);
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
    }

    if (event.type === 'extraction_failed' && (event.error || event.message)) {
      const detail = String(event.error || event.message).trim();
      if (detail) {
        useUIStore.getState().notify('error', detail, 8000);
      }
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
      'resume_file_processing',
      'resume_file_ready',
      'resume_file_failed',
    ];
    if (pipelineEvents.includes(event.type)) {
      useScraperStore.getState().bgRefreshJobs();
      void useScraperStore.getState().loadStats({ silent: true });
      const detailJobId = event.valid_job_id || event.job_id;
      if (detailJobId) {
        useScraperStore.getState().bumpAnalysisPanelRefresh(detailJobId);
      }
    }

    if (event.type === 'company_policy_reconcile_completed') {
      useScraperStore.getState().bgRefreshJobs();
      void useScraperStore.getState().loadStats({ silent: true });
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: false });
    }
  }, []);

  useWebSocket(!!isAuthenticated, handleWsEvent);

  if (isAuthenticated === null) {
    return <BrandedLoader fullscreen label="Starting NAO…" />;
  }

  if (!isAuthenticated) {
    // Visitors land on the public marketing page; /login and /signup own the
    // auth mode so both are shareable. Any other path (an app route reached
    // with an expired session) still shows the form directly, so signing back
    // in returns the user to where they were.
    // logs.* is admin-only: skip marketing and go straight to login.
    const logsHost = isLogsHost();
    const gotoMode = (mode: 'login' | 'signup') =>
      navigate(mode === 'login' ? '/login' : '/signup');

    if (logsHost) {
      return (
        <Routes>
          <Route
            path="/login"
            element={
              <AuthScreen
                onAuthSuccess={onAuthSuccess}
                initialMode="login"
                onModeChange={() => navigate('/login')}
                homeTo="/login"
              />
            }
          />
          <Route
            path="*"
            element={
              <AuthScreen
                onAuthSuccess={onAuthSuccess}
                initialMode="login"
                onModeChange={() => navigate('/login')}
                homeTo="/login"
              />
            }
          />
        </Routes>
      );
    }

    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/login"
          element={
            <AuthScreen
              onAuthSuccess={onAuthSuccess}
              initialMode="login"
              onModeChange={gotoMode}
              homeTo="/"
            />
          }
        />
        <Route
          path="/signup"
          element={
            <AuthScreen
              onAuthSuccess={onAuthSuccess}
              initialMode="signup"
              onModeChange={gotoMode}
              homeTo="/"
            />
          }
        />
        <Route
          path="*"
          element={<AuthScreen onAuthSuccess={onAuthSuccess} initialMode={authPage} homeTo="/" />}
        />
      </Routes>
    );
  }

  const defaultAuthedPath = isLogsHost() ? '/system-logs' : '/scraper';

  return (
    <>
      <NotificationToasts />
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

      <Suspense fallback={<BrandedLoader fullscreen label="Loading…" />}>
      <Routes>
        <Route
          element={
            <AppShell
              userEmail={user?.email}
              userName={user?.name || user?.display_name || undefined}
              isAdmin={!!user?.is_admin}
              onLogout={logout}
            />
          }
        >
          <Route path="/scraper" element={<ScraperDashboard />} />
          <Route
            path="/profile"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <ProfilePage user={user} onLogout={logout} onProfileSaved={refreshUser} />
              </ApplicantOnly>
            }
          />
          <Route
            path="/preferences"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <MyPreferencesPage />
              </ApplicantOnly>
            }
          />
          <Route
            path="/settings"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <Navigate to="/preferences" replace />
              </ApplicantOnly>
            }
          />
          <Route
            path="/integrations"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <IntegrationsPage />
              </ApplicantOnly>
            }
          />
          <Route
            path="/billing"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <BillingPage />
              </ApplicantOnly>
            }
          />
          <Route
            path="/resume-builder"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <ResumeBuilderPage />
              </ApplicantOnly>
            }
          />
          <Route
            path="/job-analysis"
            element={
              <ApplicantOnly isAdmin={!!user?.is_admin}>
                <JobAnalysisPage />
              </ApplicantOnly>
            }
          />
          <Route
            path="/data-analysis"
            element={
              <AdminOnly isAdmin={!!user?.is_admin}>
                <DataAnalysisManagementPage />
              </AdminOnly>
            }
          />
          <Route
            path="/data-management"
            element={
              <AdminOnly isAdmin={!!user?.is_admin}>
                <DataAnalysisManagementPage />
              </AdminOnly>
            }
          />
          <Route
            path="/user-management"
            element={
              <AdminOnly isAdmin={!!user?.is_admin}>
                <UserManagementPage />
              </AdminOnly>
            }
          />
          <Route
            path="/system-settings"
            element={
              <AdminOnly isAdmin={!!user?.is_admin}>
                <SystemSettingsPage />
              </AdminOnly>
            }
          />
          <Route
            path="/system-logs"
            element={
              <AdminOnly isAdmin={!!user?.is_admin}>
                <SystemLogsPage />
              </AdminOnly>
            }
          />
          <Route path="/" element={<Navigate to={defaultAuthedPath} replace />} />
          <Route path="*" element={<Navigate to={defaultAuthedPath} replace />} />
        </Route>
      </Routes>
      </Suspense>
    </>
  );
}

export default App;
