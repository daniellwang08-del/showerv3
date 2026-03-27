import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SubmissionResponse } from './types';
import { apiClient } from './api/client';
import { ModalState, SubmittedUrlItem, ExtractionStatusLabel } from './types/ui';
import { Login } from './components/Login';
import { Signup } from './components/Signup';
import { JobActionModal } from './components/JobActionModal';
import { DetailContentPanel } from './components/DetailContentPanel';
import { ValidJobsPanel } from './components/ValidJobsPanel';
import { DuplicateJobsPanel } from './components/DuplicateJobsPanel';
import { SubmitForm } from './components/SubmitForm';
import { ProfilesManagementPage } from './components/ProfilesManagementPage';
import SideDrawer from './components/SideDrawer';
import Header from './components/Header';

type AuthPage = 'login' | 'signup';
type MainView = 'dashboard' | 'profiles';

function App() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<{ id?: string; email?: string; name?: string | null; is_active?: boolean; created_at?: string } | null>(null);
  const [authPage, setAuthPage] = useState<AuthPage>('login');
  const [mainView, setMainView] = useState<MainView>('dashboard');

  const [loading, setLoading] = useState(false);
  const [loadingLists, setLoadingLists] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');
  const [submitNoticeKind, setSubmitNoticeKind] = useState<'success' | 'warning'>('success');

  const [openMenu, setOpenMenu] = useState<{ table: 'valid' | 'invalid'; id: string } | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [modalError, setModalError] = useState('');
  const [modalUrl, setModalUrl] = useState('');
  const [modalReason, setModalReason] = useState('');
  const [modalDuplicateOf, setModalDuplicateOf] = useState('');

  const [compareValidJobId, setCompareValidJobId] = useState<string | null>(null);
  const [pendingScrollValidJobId, setPendingScrollValidJobId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<'scraped' | 'jobmatch' | null>(null);
  const [isDuplicatePanelOpen, setDuplicatePanelOpen] = useState(false);
  const [scrapedContentExtractionId, setScrapedContentExtractionId] = useState<string | null>(null);
  const [jobMatchValidJobId, setJobMatchValidJobId] = useState<string | null>(null);

  const validRowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const isInitialListsLoad = useRef(true);

  const [uniqueUrls, setUniqueUrls] = useState<SubmittedUrlItem[]>([]);
  const [duplicateUrls, setDuplicateUrls] = useState<SubmittedUrlItem[]>([]);

  const [url, setUrl] = useState('');

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await apiClient.get('/auth/me');
        setUser(res.data ?? null);
        setIsAuthenticated(true);
      } catch {
        setUser(null);
        setIsAuthenticated(false);
      }
    };
    checkAuth();

    const interceptor = apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          setIsAuthenticated(false);
          setUser(null);
        }
        return Promise.reject(error);
      }
    );
    return () => apiClient.interceptors.response.eject(interceptor);
  }, []);

  const handleLogout = async () => {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      setIsAuthenticated(false);
      setUser(null);
    }
  };

  const handleAuthSuccess = () => {
    setIsAuthenticated(true);
    setAuthPage('login');
  };

  const scrollToValidJob = (jobId: string) => {
    setCompareValidJobId(jobId);
    setPendingScrollValidJobId(jobId);
    window.setTimeout(() => setCompareValidJobId(null), 3000);
  };

  const fetchValidJobUrlById = async (jobId: string): Promise<string | null> => {
    try {
      const res = await apiClient.get(`/jobs/valid/${jobId}`);
      const job = res.data as { id: string; source_url: string };
      return job.source_url;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    if (!pendingScrollValidJobId) return;
    const el = validRowRefs.current[pendingScrollValidJobId];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPendingScrollValidJobId(null);
  }, [pendingScrollValidJobId, uniqueUrls]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-job-menu-root="true"]')) return;
      setOpenMenu(null);
    };

    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const openModal = (next: ModalState) => {
    setModal(next);
    setModalError('');
    setModalSubmitting(false);
    setModalUrl(next ? (next.kind === 'replaceInvalid' ? next.invalidUrl : 'currentUrl' in next ? next.currentUrl : '') : '');
    setModalReason('');
    setModalDuplicateOf('');
  };

  const closeModal = () => {
    setModal(null);
    setModalError('');
    setModalSubmitting(false);
    setModalUrl('');
    setModalReason('');
    setModalDuplicateOf('');
  };

  const confirmModal = async () => {
    if (!modal) return;

    try {
      setModalSubmitting(true);
      setModalError('');
      setSubmitNotice('');

      if (modal.kind === 'edit') {
        await apiClient.patch(`/jobs/${modal.table}/${modal.id}/url`, { url: modalUrl });
      }

      if (modal.kind === 'reportInvalid') {
        await apiClient.post(`/jobs/${modal.table}/${modal.id}/report-invalid`, {
          duplication_reason: modalReason.trim() ? modalReason.trim() : null,
        });
      }

      if (modal.kind === 'reportDuplicate') {
        await apiClient.post(`/jobs/${modal.table}/${modal.id}/report-duplicate`, {
          duplicate_of_job_id: modalDuplicateOf.trim() ? modalDuplicateOf.trim() : null,
          duplication_reason: modalReason.trim() ? modalReason.trim() : null,
        });
      }

      if (modal.kind === 'delete') {
        await apiClient.delete(`/jobs/${modal.table}/${modal.id}`);
      }

      if (modal.kind === 'replaceInvalid') {
        await apiClient.patch(`/jobs/valid/${modal.validJobId}/url`, { url: modal.invalidUrl });
        await apiClient.delete(`/jobs/invalid/${modal.invalidJobId}`);
      }

      await refreshLists();
      closeModal();
    } catch (e: any) {
      setModalError(e.response?.data?.detail || 'Action failed');
    } finally {
      setModalSubmitting(false);
      setOpenMenu(null);
    }
  };

  const refreshLists = async (showLoading = true) => {
    if (!isAuthenticated) return;
    const shouldShowLoading = showLoading && isInitialListsLoad.current;
    try {
      if (shouldShowLoading) setLoadingLists(true);

      const [validRes, invalidRes] = await Promise.all([
        apiClient.get(`/jobs/valid?limit=2000`),
        apiClient.get(`/jobs/invalid?limit=2000`),
      ]);

      const valid = validRes.data as Array<{
        id: string;
        source_url: string;
        created_at: string;
        posted_date?: string | null;
        scraped_at: string | null;
        extraction_id: string | null;
        extraction_status: string | null;
        match_overall_score: number | null;
        match_status: string | null;
        click_count?: number;
      }>;
      const invalid = invalidRes.data as Array<{
        id: string;
        source_url: string;
        duplicate_of_job_id: string | null;
        duplication_reason: string | null;
        created_at: string;
      }>;

      setUniqueUrls(
        valid.map((j) => {
          const scrapedMs = j.scraped_at ? Date.parse(j.scraped_at) : NaN;
          return {
            id: j.id,
            url: j.source_url,
            message: 'Job submitted successfully',
            job_id: j.id,
            duplicate_job_id: null,
            created_at_ms: Date.parse(j.created_at),
            scraped_at_ms: Number.isNaN(scrapedMs) ? undefined : scrapedMs,
            extraction_id: j.extraction_id ?? undefined,
            extraction_status: (j.extraction_status as ExtractionStatusLabel | null) ?? undefined,
            match_overall_score: j.match_overall_score ?? undefined,
            match_status: j.match_status ?? undefined,
            click_count: j.click_count ?? 0,
            posted_date_ms:
              j.posted_date && !Number.isNaN(Date.parse(j.posted_date))
                ? Date.parse(j.posted_date)
                : undefined,
            table: 'valid' as const,
          };
        }),
      );

      setDuplicateUrls(
        invalid.map((j) => ({
          id: j.id,
          url: j.source_url,
          message: j.duplication_reason ?? 'Duplicate job detected',
          job_id: j.id,
          duplicate_job_id: j.duplicate_of_job_id,
          created_at_ms: Date.parse(j.created_at),
          table: 'invalid' as const,
        })),
      );
      isInitialListsLoad.current = false;
    } catch (e) {
      return;
    } finally {
      if (shouldShowLoading) setLoadingLists(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      void refreshLists();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !uniqueUrls.length) return;
    const hasExtractionInProgress = uniqueUrls.some(
      (u) => u.extraction_status === 'pending' || u.extraction_status === 'processing'
    );
    const hasMatchInProgress = uniqueUrls.some((u) => u.match_status === 'processing');
    if (!hasExtractionInProgress && !hasMatchInProgress) return;
    const interval = setInterval(() => void refreshLists(), 5000);
    return () => clearInterval(interval);
  }, [isAuthenticated, uniqueUrls, uniqueUrls.length]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const submittedUrl = url.trim();
    if (!submittedUrl) {
      setSubmitError('URL is required');
      setSubmitNotice('');
      return;
    }

    try {
      setLoading(true);
      setSubmitNotice('');
      const axiosResponse = await apiClient.post<SubmissionResponse>(`/jobs/submit`, { url: submittedUrl });
      const response = axiosResponse.data;

      const existedInInvalidList = !!response.job_id && duplicateUrls.some((d) => d.id === response.job_id);

      if (response.success) {
        setSubmitError('');
        if (response.is_duplicate) {
          setSubmitNoticeKind('warning');
          setSubmitNotice(
            existedInInvalidList
              ? 'This job link already exists in Check Required list.'
              : (response.message || 'Duplicate job detected.'),
          );
          if (response.job_id && !existedInInvalidList) {
            setDuplicateUrls((prev) => [
              {
                id: response.job_id!,
                url: submittedUrl,
                message: response.message || 'Duplicate job detected',
                job_id: response.job_id,
                duplicate_job_id: response.duplicate_job_id,
                created_at_ms: Date.now(),
                table: 'invalid' as const,
              },
              ...prev,
            ]);
          }
        } else {
          setSubmitNoticeKind('success');
          setSubmitNotice(response.message || 'Job submitted successfully.');
        }
        await refreshLists(false);
      } else {
        setSubmitError(response.message || 'Error submitting job');
        setSubmitNotice('');
      }
      
      if (response.success) {
        setUrl('');
      }
    } catch (error: any) {
      setSubmitError(error.response?.data?.detail || 'Error submitting job');
      setSubmitNotice('');
    } finally {
      setLoading(false);
    }
  };

  // Get user's initial from email or name
  const getUserInitial = (): string => {
    if (user?.name) {
      return user.name.charAt(0).toUpperCase();
    }
    if (user?.email) {
      return user.email.charAt(0).toUpperCase();
    }
    return 'U';
  };

  // Handle marking jobs as applied
  const handleMarkApplied = (items: SubmittedUrlItem[], userInitial: string) => {
    const updatedUrls = uniqueUrls.map(job => {
      if (items.find(item => item.id === job.id)) {
        return {
          ...job,
          appliedAt: Date.now(),
          appliedBy: userInitial
        };
      }
      return job;
    });
    setUniqueUrls(updatedUrls);
  };

  // Handle marking jobs as unapplied
  const handleMarkUnapplied = (items: SubmittedUrlItem[]) => {
    const updatedUrls = uniqueUrls.map(job => {
      if (items.find(item => item.id === job.id) && job.appliedAt) {
        return {
          ...job,
          appliedAt: undefined,
          appliedBy: undefined
        };
      }
      return job;
    });
    setUniqueUrls(updatedUrls);
  };

  const handleRescrape = async (item: SubmittedUrlItem) => {
    try {
      await apiClient.post(`/jobs/valid/${item.id}/rescrape`, { url: item.url });
      await refreshLists();
    } catch (error: any) {
      setSubmitError(error.response?.data?.detail || 'Failed to rescrape job');
    }
  };

  const handleOpenSelectedUrls = async (items: SubmittedUrlItem[]) => {
    if (!items.length) return;

    const uniqueItems = items.filter(
      (item, index, arr) => arr.findIndex((x) => x.url === item.url) === index,
    );

    uniqueItems.forEach((item) => {
      window.open(item.url, '_blank', 'noopener,noreferrer');
    });

    // Keep click counts consistent with individual URL opens.
    setUniqueUrls((prev) =>
      prev.map((job) => {
        const opened = uniqueItems.find((item) => item.id === job.id);
        if (!opened) return job;
        return { ...job, click_count: (job.click_count ?? 0) + 1 };
      }),
    );

    await Promise.all(
      uniqueItems.map(async (item) => {
        if (item.table !== 'valid') return;
        try {
          const res = await apiClient.post<{ click_count: number }>(`/jobs/valid/${item.id}/click`);
          const serverCount = res.data?.click_count;
          if (typeof serverCount !== 'number') return;
          setUniqueUrls((prev) =>
            prev.map((job) => (job.id === item.id ? { ...job, click_count: serverCount } : job)),
          );
        } catch {
          // Keep optimistic count on failure
        }
      }),
    );
  };

  // Handle batch delete of jobs
  const handleBatchDelete = async (itemsToDelete: SubmittedUrlItem[]) => {
    console.log('handleBatchDelete - Deleting items:', itemsToDelete);
    
    try {
      setLoadingLists(true);
      
      // Delete each job by ID and table
      for (const item of itemsToDelete) {
        const table = item.table || 'valid'; // Default to 'valid' if table not specified
        console.log(`Deleting job ID: ${item.id} from table: ${table}`);
        try {
          await apiClient.delete(`/jobs/${table}/${item.id}`);
          console.log(`Successfully deleted: ${item.id}`);
        } catch (error) {
          console.error(`Error deleting ${item.id}:`, error);
        }
      }
      
      // Refresh the list after all deletions
      console.log('All deletions complete, refreshing lists...');
      await refreshLists();
      
    } catch (error) {
      console.error('Error in batch delete:', error);
      setSubmitError('Error deleting jobs');
    } finally {
      setLoadingLists(false);
    }
  };

  if (isAuthenticated === null) {
    return <div className="flex h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50 text-slate-900">Loading...</div>;
  }

  if (!isAuthenticated) {
    return authPage === 'signup' ? (
      <Signup 
        onSignup={handleAuthSuccess}
        onSwitchToLogin={() => setAuthPage('login')}
      />
    ) : (
      <Login 
        onLogin={handleAuthSuccess}
        onSwitchToSignup={() => setAuthPage('signup')}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 text-slate-900">
      <Header
        onToggleDrawer={() => setDrawerOpen((s) => !s)}
        onLogout={handleLogout}
        onMyProfile={() => setMainView('profiles')}
        userEmail={user?.email}
        userName={user?.name ?? undefined}
      />
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

      {mainView === 'profiles' ? (
        <ProfilesManagementPage onBack={() => setMainView('dashboard')} />
      ) : (
        <div className="flex min-h-screen">
          <SideDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            onMyProfile={() => setMainView('profiles')}
          />

          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="grid min-h-screen grid-cols-1 md:grid-cols-2 min-w-0">
              <ValidJobsPanel
                items={uniqueUrls}
                compareValidJobId={compareValidJobId}
                openMenuId={openMenu?.table === 'valid' ? openMenu.id : null}
                onToggleMenu={(id) => {
                  setOpenMenu((prev) =>
                    prev?.table === 'valid' && prev.id === id ? null : { table: 'valid', id },
                  );
                }}
                onEdit={(item) => openModal({ kind: 'edit', table: 'valid', id: item.id, currentUrl: item.url })}
                onReportInvalid={(item) =>
                  openModal({ kind: 'reportInvalid', table: 'valid', id: item.id, currentUrl: item.url })
                }
                onReportDuplicate={(item) =>
                  openModal({ kind: 'reportDuplicate', table: 'valid', id: item.id, currentUrl: item.url })
                }
                onDelete={(item) => openModal({ kind: 'delete', table: 'valid', id: item.id, currentUrl: item.url })}
                onBatchDelete={handleBatchDelete}
                onMarkApplied={handleMarkApplied}
                onMarkUnapplied={handleMarkUnapplied}
                onOpenSelectedUrls={handleOpenSelectedUrls}
                onShowScrapedContent={(item) => {
                  if (item.extraction_id) {
                    setDetailMode('scraped');
                    setScrapedContentExtractionId(item.extraction_id);
                    setJobMatchValidJobId(null);
                  }
                }}
                onShowJobMatch={(item) => {
                  if (item.match_overall_score != null) {
                    setDetailMode('jobmatch');
                    setJobMatchValidJobId(item.id);
                    setScrapedContentExtractionId(null);
                  }
                }}
                onTriggerJobMatch={async (item) => {
                  try {
                    await apiClient.post(`/jobs/valid/${item.id}/match`);
                    void refreshLists();
                  } catch {
                    // Error toast could be added
                  }
                }}
                onJobUrlClick={async (item) => {
                  if (item.table !== 'valid') return;
                  const jobId = item.id;
                  const prevCount = item.click_count ?? 0;
                  setUniqueUrls((prev) =>
                    prev.map((u) => (u.id === jobId ? { ...u, click_count: prevCount + 1 } : u)),
                  );
                  try {
                    const res = await apiClient.post<{ click_count: number }>(`/jobs/valid/${jobId}/click`);
                    const serverCount = res.data?.click_count ?? prevCount + 1;
                    setUniqueUrls((prev) =>
                      prev.map((u) => (u.id === jobId ? { ...u, click_count: serverCount } : u)),
                    );
                  } catch {
                    // Keep optimistic count on failure
                  }
                }}
                onRescrape={handleRescrape}
                userInitial={getUserInitial()}
              />

              <div className="flex min-h-screen min-w-0 flex-col overflow-hidden md:bg-gradient-to-b md:from-purple-50/50 md:to-white">
                <div className="p-4 rounded-xl border border-slate-200 bg-white shadow-sm">
                  <h3 className="mb-2 text-lg font-semibold text-slate-900">Post a job</h3>
                  <SubmitForm
                    url={url}
                    onUrlChange={setUrl}
                    loading={loading}
                    onSubmit={handleSubmit}
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
                      onClose={() => {
                        setDetailMode(null);
                        setScrapedContentExtractionId(null);
                        setJobMatchValidJobId(null);
                      }}
                      onMatchStored={() => void refreshLists()}
                    />
                  </div>
                ) : (
                  <div className="flex min-h-0 min-w-0 flex-1" />
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setDuplicatePanelOpen(true)}
            className="fixed right-5 top-1/2 z-50 h-11 w-11 -translate-y-1/2 rounded-full bg-orange-600 text-white shadow-lg border-2 border-white hover:bg-orange-500 transition"
            aria-label="Open duplicates drawer"
          >
            <span className="text-lg">⋯</span>
          </button>

          <div className="fixed inset-0 z-40 bg-black/20 transition-opacity duration-300" style={{ opacity: isDuplicatePanelOpen ? 1 : 0, pointerEvents: isDuplicatePanelOpen ? 'auto' : 'none' }} onClick={() => setDuplicatePanelOpen(false)} />

          <div
            className={`fixed right-0 top-1/2 z-50 h-[40vh] w-[50vw] -translate-y-1/2 rounded-xl border border-slate-200 bg-white shadow-2xl overflow-hidden transition-transform duration-300 ease-out ${isDuplicatePanelOpen ? 'translate-x-0' : 'translate-x-full'}`}
          >
            <div className="h-full overflow-auto p-2">
              <DuplicateJobsPanel
                loadingLists={loadingLists}
                items={duplicateUrls}
                openMenuId={openMenu?.table === 'invalid' ? openMenu.id : null}
                onToggleMenu={(id) => {
                  setOpenMenu((prev) =>
                    prev?.table === 'invalid' && prev.id === id ? null : { table: 'invalid', id },
                  );
                }}
                onCloseMenu={() => setOpenMenu(null)}
                onCompare={(item) => {
                  const targetId = item.duplicate_job_id;
                  if (!targetId) {
                    setSubmitError('Cannot compare: missing duplicate_job_id');
                    return;
                  }
                  const inList = uniqueUrls.find((u) => u.id === targetId);
                  if (inList) {
                    scrollToValidJob(inList.id);
                    return;
                  }
                  (async () => {
                    const url = await fetchValidJobUrlById(targetId);
                    if (!url) {
                      setSubmitError('Cannot compare: original job not found in To do list');
                      return;
                    }
                    await refreshLists();
                    scrollToValidJob(targetId);
                  })();
                }}
                onReplace={(item) => {
                  const targetId = item.duplicate_job_id;
                  if (!targetId) {
                    setSubmitError('Cannot replace: missing duplicate_job_id');
                    return;
                  }
                  const inList = uniqueUrls.find((u) => u.id === targetId);
                  if (inList) {
                    openModal({
                      kind: 'replaceInvalid',
                      invalidJobId: item.id,
                      invalidUrl: item.url,
                      validJobId: inList.id,
                      validUrl: inList.url,
                    });
                    return;
                  }
                  (async () => {
                    const url = await fetchValidJobUrlById(targetId);
                    if (!url) {
                      setSubmitError('Cannot replace: original job not found in To do list');
                      return;
                    }
                    openModal({
                      kind: 'replaceInvalid',
                      invalidJobId: item.id,
                      invalidUrl: item.url,
                      validJobId: targetId,
                      validUrl: url,
                    });
                  })();
                }}
                onDelete={(item) => openModal({ kind: 'delete', table: 'invalid', id: item.id, currentUrl: item.url })}
              >
                <></>
              </DuplicateJobsPanel>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
