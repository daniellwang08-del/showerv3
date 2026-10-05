import { lazy, Suspense, useCallback, useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useWebSocket, type WsEvent } from './hooks/useWebSocket';
import { useScraperStore } from './stores/scraperStore';
import { useJobsStore } from './stores/jobsStore';
import { useModalStore } from './stores/modalStore';
import { useUIStore } from './stores/uiStore';
import { useShellStore } from './stores/shellStore';
import { useAgentStore } from './stores/agentStore';
import { BrandedLoader } from './components/layout/BrandedLoader';
import { WorkspaceShell } from './shells/WorkspaceShell';
import { LegacyPage } from './shells/LegacyPage';
import { adminNav, applicantNav, legacyRedirects } from './shells/nav';
import { coalesce } from './lib/coalesce';
import { queryClient } from './lib/queryClient';
import { Skeleton } from './components/ui/skeleton';
import { PageTitle } from './components/app/PageTitle';

const named = <T extends Record<string, unknown>>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as React.ComponentType<any> })));

const AuthScreen = named(() => import('./components/extraction/AuthScreen'), 'AuthScreen');
const PendingApprovalScreen = named(
  () => import('./components/extraction/PendingApprovalScreen'),
  'PendingApprovalScreen',
);
const JobActionModal = named(() => import('./components/extraction/JobActionModal'), 'JobActionModal');
const ConfirmDialog = named(() => import('./components/extraction/ConfirmDialog'), 'ConfirmDialog');
const LandingPage = named(() => import('./pages/LandingPage'), 'LandingPage');
const HomePage = named(() => import('./features/home/HomePage'), 'HomePage');
const OnboardingPage = named(() => import('./features/onboarding/OnboardingPage'), 'OnboardingPage');
const AssistantPage = named(() => import('./features/assistant/AssistantPage'), 'AssistantPage');
const JobsPage = named(() => import('./features/jobs/JobsPage'), 'JobsPage');
const AdminPipelinePage = named(() => import('./features/admin/pipeline/AdminPipelinePage'), 'AdminPipelinePage');
const ProfilePage = named(() => import('./features/profile/ProfilePage'), 'ProfilePage');
const PreferencesPage = named(() => import('./features/settings/PreferencesPage'), 'PreferencesPage');
const IntegrationsPage = named(() => import('./features/integrations/IntegrationsPage'), 'IntegrationsPage');
const InsightsPage = named(() => import('./features/insights/InsightsPage'), 'InsightsPage');
const BillingPage = named(() => import('./pages/BillingPage'), 'BillingPage');
const DocumentsPage = named(() => import('./features/documents/DocumentsPage'), 'DocumentsPage');
const ResumeStudioPage = named(() => import('./features/studio/ResumeStudioPage'), 'ResumeStudioPage');
const AdminDataPage = named(() => import('./features/admin/data/AdminDataPage'), 'AdminDataPage');
const AdminUsersPage = named(() => import('./features/admin/users/AdminUsersPage'), 'AdminUsersPage');
const AdminSystemPage = named(() => import('./features/admin/system/AdminSystemPage'), 'AdminSystemPage');
const AdminLogsPage = named(() => import('./features/admin/logs/AdminLogsPage'), 'AdminLogsPage');
const ExtensionConnectPage = named(
  () => import('./features/extension/ExtensionConnectPage'),
  'ExtensionConnectPage',
);

function isLogsHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'logs.nao.it.com' || host.startsWith('logs.');
}

function AdminsOnlyNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div className="max-w-md space-y-2">
        <p className="text-lg font-semibold">Admins only</p>
        <p className="text-sm text-muted-foreground">
          System logs require an admin account. Sign in at{' '}
          <a className="text-brand underline" href="https://nao.it.com/login">
            nao.it.com
          </a>{' '}
          with an admin user, then open this site again.
        </p>
      </div>
    </div>
  );
}

function PageFallback() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function Page({ children, legacy, title }: { children: ReactNode; legacy?: boolean; title?: string }) {
  const content = (
    <Suspense fallback={<PageFallback />}>
      {title ? <PageTitle title={title} /> : null}
      {children}
    </Suspense>
  );
  return legacy ? <LegacyPage>{content}</LegacyPage> : content;
}

function LegacyRedirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

const SESSION_CACHE_KEYS = ['applicant_scraper_stats_v1', 'admin_scraper_stats_v1'];

/** Per-user data cached in this browser (recent jobs, chat, stats) must not carry over to another account. */
function claimBrowserData(userId: string | null) {
  const shell = useShellStore.getState();
  if (shell.owner === userId) return;
  useAgentStore.getState().reset({ dropLegacy: true });
  for (const key of SESSION_CACHE_KEYS) sessionStorage.removeItem(key);
  shell.setOwner(userId);
}

// Pipeline events arrive in bursts (several per job); collapse the resulting
// refetches to at most one per 2 s per target.
const refresh = {
  jobs: coalesce(() => useScraperStore.getState().bgRefreshJobs()),
  stats: coalesce(() => void useScraperStore.getState().loadStats({ silent: true })),
  lists: coalesce(() => void useJobsStore.getState().refreshLists({ showLoading: false, reset: false })),
  afterSubmit: coalesce(() => void useScraperStore.getState().refreshAfterJobSubmit()),
  queries: coalesce(() => void queryClient.invalidateQueries({ queryKey: ['jobs'] })),
};

const SCRAPER_EVENTS = new Set([
  'sync_started',
  'sync_spider_started',
  'sync_activity',
  'sync_progress',
  'sync_completed',
  'sync_failed',
]);

const PIPELINE_EVENTS = new Set([
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
]);

function handleWsEvent(event: WsEvent) {
  const scraper = useScraperStore.getState();

  if (SCRAPER_EVENTS.has(event.type)) {
    scraper.handleSyncWsEvent(event);
    if (event.type === 'sync_completed' || event.type === 'sync_failed') {
      refresh.afterSubmit();
      refresh.queries();
      scraper.checkSyncStatus();
    }
    return;
  }

  if (event.type === 'job_site_status') {
    void queryClient.invalidateQueries({ queryKey: ['integrations', 'job-sites'] });
    const name = event.plugin_name || event.plugin_slug || 'A job site';
    const action =
      event.status === 'needs_reauth'
        ? `${name} needs you to sign in again. Open Integrations and click Reconnect.`
        : `${name} stopped syncing: ${event.message || 'its request limit is used up'}.`;
    useUIStore.getState().notify('warning', action, 12000);
    return;
  }

  if (event.type === 'scrape_promoted' || event.type === 'job_submitted') {
    refresh.afterSubmit();
    refresh.lists();
  }

  if (event.type === 'job_excluded_for_user' || event.type === 'extraction_failed') {
    refresh.lists();
    refresh.jobs();
  }

  if (event.type === 'match_failed') {
    const detail = (event.error || event.message || 'Match analysis failed').trim();
    useUIStore.getState().notify('error', detail, 8000);
    refresh.lists();
  }

  if (event.type === 'extraction_failed' && (event.error || event.message)) {
    const detail = String(event.error || event.message).trim();
    if (detail) useUIStore.getState().notify('error', detail, 8000);
  }

  if (PIPELINE_EVENTS.has(event.type)) {
    refresh.jobs();
    refresh.stats();
    const detailJobId = event.valid_job_id || event.job_id;
    if (detailJobId) scraper.bumpAnalysisPanelRefresh(detailJobId);
  }

  if (event.type === 'company_policy_reconcile_completed') {
    refresh.jobs();
    refresh.stats();
    refresh.lists();
  }

  refresh.queries();
}

function App() {
  const { isAuthenticated, pendingApproval, authNotice, user, authPage, logout, onAuthSuccess, refreshUser } =
    useAuth();
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

  const onWsEvent = useCallback((event: WsEvent) => handleWsEvent(event), []);
  useWebSocket(!!isAuthenticated, onWsEvent);

  useEffect(() => {
    if (!user?.id) return;
    claimBrowserData(user.id);
    if (!user.is_admin) void useAgentStore.getState().init(user.id);
  }, [user?.id, user?.is_admin]);

  const handleLogout = useCallback(async () => {
    await logout();
    queryClient.clear();
    claimBrowserData(null);
    useAgentStore.getState().reset();
    // In-memory stores still hold the previous account's jobs; start the next session clean.
    window.location.replace('/login');
  }, [logout]);

  if (isAuthenticated === null) {
    return <BrandedLoader fullscreen label="Starting NAO…" />;
  }

  if (pendingApproval) {
    return (
      <Suspense fallback={<BrandedLoader fullscreen label="Loading…" />}>
        <PageTitle title="Waiting for approval" />
        <PendingApprovalScreen onResolved={refreshUser} onSignOut={handleLogout} />
      </Suspense>
    );
  }

  if (!isAuthenticated) {
    // Visitors land on the public marketing page; /login and /signup own the
    // auth mode so both are shareable. Any other path (an app route reached
    // with an expired session) still shows the form directly, so signing back
    // in returns the user to where they were. logs.* skips marketing.
    if (isLogsHost()) {
      const loginScreen = (
        <AuthScreen
          onAuthSuccess={onAuthSuccess}
          initialMode="login"
          onModeChange={() => navigate('/login')}
          homeTo="/login"
          notice={authNotice}
        />
      );
      return (
        <Suspense fallback={<BrandedLoader fullscreen label="Loading…" />}>
          <Routes>
            <Route path="*" element={loginScreen} />
          </Routes>
        </Suspense>
      );
    }

    const gotoMode = (mode: 'login' | 'signup') => navigate(mode === 'login' ? '/login' : '/signup');
    return (
      <Suspense fallback={<BrandedLoader fullscreen label="Loading…" />}>
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
                notice={authNotice}
              />
            }
          />
          <Route
            path="/signup"
            element={<AuthScreen onAuthSuccess={onAuthSuccess} initialMode="signup" onModeChange={gotoMode} homeTo="/" />}
          />
          <Route
            path="*"
            element={
              <AuthScreen onAuthSuccess={onAuthSuccess} initialMode={authPage} homeTo="/" notice={authNotice} />
            }
          />
        </Routes>
      </Suspense>
    );
  }

  const isAdmin = !!user?.is_admin;
  const logsHost = isLogsHost();
  const home = isAdmin ? (logsHost ? '/admin/logs' : '/admin') : '/app';
  const shellUser = { name: user?.name || user?.display_name, email: user?.email };
  const firstName = (user?.name || (user?.display_name?.includes('@') ? '' : user?.display_name) || '')
    .trim()
    .split(/\s+/)[0] || undefined;

  if (logsHost && !isAdmin) return <AdminsOnlyNotice />;

  return (
    <>
      <Suspense fallback={null}>
      {modal ? (
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
      ) : null}

      {batchDeletePending != null ? (
      <ConfirmDialog
        open={batchDeletePending != null}
        title="Dismiss duplicate entries?"
        description={
          batchDeletePending && batchDeletePending.length > 0 ? (
            <>
              <span className="font-semibold tabular-nums text-foreground">{batchDeletePending.length}</span>{' '}
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
      ) : null}
      </Suspense>

      <Routes>
        <Route
          path="/onboarding"
          element={
            isAdmin ? (
              <Navigate to="/admin" replace />
            ) : (
              <Suspense fallback={<PageFallback />}>
                <OnboardingPage userId={user?.id} accountEmail={user?.email} onProfileSaved={refreshUser} />
              </Suspense>
            )
          }
        />
        <Route
          path="/extension/connect"
          element={
            <Suspense fallback={<BrandedLoader fullscreen label="Loading…" />}>
              <PageTitle title="Connect extension" />
              <ExtensionConnectPage email={user?.email} />
            </Suspense>
          }
        />
        <Route
          path="/app"
          element={
            isAdmin ? (
              <Navigate to="/admin" replace />
            ) : (
              <WorkspaceShell variant="applicant" nav={applicantNav} user={shellUser} onLogout={handleLogout} />
            )
          }
        >
          <Route index element={<Page><HomePage firstName={firstName} userId={user?.id} /></Page>} />
          <Route path="assistant" element={<Page><AssistantPage /></Page>} />
          <Route path="assistant/:sessionId" element={<Page><AssistantPage /></Page>} />
          <Route path="jobs" element={<Page title="Jobs"><JobsPage /></Page>} />
          <Route path="analysis" element={<Page><InsightsPage /></Page>} />
          <Route path="documents" element={<Page><DocumentsPage /></Page>} />
          <Route path="studio" element={<Page><ResumeStudioPage /></Page>} />
          <Route
            path="profile"
            element={
              <Page>
                <ProfilePage accountEmail={user?.email} onProfileSaved={refreshUser} />
              </Page>
            }
          />
          <Route path="preferences" element={<Page><PreferencesPage /></Page>} />
          <Route path="integrations" element={<Page><IntegrationsPage /></Page>} />
          <Route path="billing" element={<Page legacy title="Billing"><BillingPage /></Page>} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Route>

        <Route
          path="/admin"
          element={
            isAdmin ? (
              <WorkspaceShell variant="admin" nav={adminNav} user={shellUser} onLogout={handleLogout} />
            ) : (
              <Navigate to="/app" replace />
            )
          }
        >
          <Route index element={<Page><AdminPipelinePage /></Page>} />
          <Route path="data" element={<Page><AdminDataPage /></Page>} />
          <Route path="users" element={<Page><AdminUsersPage /></Page>} />
          <Route path="settings" element={<Page><AdminSystemPage /></Page>} />
          <Route path="logs" element={<Page><AdminLogsPage /></Page>} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>

        {Object.entries(legacyRedirects).map(([from, to]) => (
          <Route key={from} path={from} element={<LegacyRedirect to={isAdmin ? to.admin : to.applicant} />} />
        ))}
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </>
  );
}

export default App;
