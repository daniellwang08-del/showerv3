import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SubmissionResponse } from './types';
import { apiClient } from './api/client';
import { ModalState, SubmittedUrlItem, ExtractionStatusLabel } from './types/ui';
import { Login } from './components/Login';
import { Signup } from './components/Signup';
import { JobActionModal } from './components/JobActionModal';
import { useAuth } from './hooks/useAuth';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ProfilesPage } from './features/profiles/ProfilesPage';
import { mainViewFromHash, navigateMainView, type MainView } from './mainViewRouting';

function App() {
  const { isAuthenticated, user, authPage, setAuthPage, logout, onAuthSuccess, getUserInitial } = useAuth();
  const [mainView, setMainView] = useState<MainView>(() =>
    typeof window !== 'undefined' ? mainViewFromHash() : 'dashboard',
  );

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
  const [jobAnalysisValidJobId, setJobAnalysisValidJobId] = useState<string | null>(null);

  const validRowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const isInitialListsLoad = useRef(true);

  const [uniqueUrls, setUniqueUrls] = useState<SubmittedUrlItem[]>([]);
  const [duplicateUrls, setDuplicateUrls] = useState<SubmittedUrlItem[]>([]);

  const [url, setUrl] = useState('');

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
    const onHashChange = () => setMainView(mainViewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    setMainView(mainViewFromHash());
  }, [isAuthenticated]);

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
    if (modal.kind === 'promoteInvalidToValid' && !modalReason.trim()) {
      setModalError('Please enter a reason');
      return;
    }

    try {
      setModalSubmitting(true);
      setModalError('');
      setSubmitNotice('');

      if (modal.kind === 'promoteInvalidToValid') {
        const res = await apiClient.post<{ valid_job_id: string }>(`/jobs/invalid/${modal.id}/promote-to-valid`, {
          reason: modalReason.trim(),
        });
        await refreshLists();
        const newId = res.data?.valid_job_id;
        closeModal();
        if (newId) setJobAnalysisValidJobId(newId);
        return;
      }

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
      (u) => u.extraction_status === 'pending' || u.extraction_status === 'processing',
    );
    const hasMatchInProgress = uniqueUrls.some((u) => u.match_status === 'processing');
    // Brief window after scrape completes: match may still be running (sync worker path or race
    // before job_match_in_progress is visible). Without this, polling stops and the list can stay on "—".
    const catchupMs = 15 * 60 * 1000;
    const needsMatchScoreCatchup = uniqueUrls.some((u) => {
      if (u.table !== 'valid' || !u.extraction_id || u.extraction_status !== 'completed') return false;
      if (u.match_overall_score != null || u.match_status === 'processing') return false;
      const refMs = u.scraped_at_ms ?? u.created_at_ms;
      return Date.now() - refMs < catchupMs;
    });
    if (!hasExtractionInProgress && !hasMatchInProgress && !needsMatchScoreCatchup) return;
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

  const handleOpenSelectedUrls = useCallback(async (items: SubmittedUrlItem[]) => {
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
  }, []);

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

  const onCloseDetail = useCallback(() => {
    setJobAnalysisValidJobId(null);
  }, []);

  const onMatchStored = useCallback(() => void refreshLists(), []);

  const onMyProfile = useCallback(() => navigateMainView('profiles'), []);

  const onBackFromProfiles = useCallback(() => navigateMainView('dashboard'), []);

  const onCompareDuplicate = useCallback(
    (item: SubmittedUrlItem) => {
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
    },
    [uniqueUrls],
  );

  const onReplaceDuplicate = useCallback(
    (item: SubmittedUrlItem) => {
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
    },
    [uniqueUrls],
  );

  const dashboardProps = useMemo(() => {
    return {
      userEmail: user?.email,
      userName: user?.name ?? undefined,
      onLogout: logout,
      onMyProfile,
      uniqueUrls,
      duplicateUrls,
      loadingLists,
      url,
      submitNotice,
      submitNoticeKind,
      submitError,
      loading,
      onUrlChange: setUrl,
      onSubmit: handleSubmit,
      openMenu,
      setOpenMenu,
      compareValidJobId,
      onEdit: (item: SubmittedUrlItem) => openModal({ kind: 'edit', table: 'valid', id: item.id, currentUrl: item.url }),
      onReportInvalid: (item: SubmittedUrlItem) => openModal({ kind: 'reportInvalid', table: 'valid', id: item.id, currentUrl: item.url }),
      onReportDuplicate: (item: SubmittedUrlItem) => openModal({ kind: 'reportDuplicate', table: 'valid', id: item.id, currentUrl: item.url }),
      onDelete: (item: SubmittedUrlItem) => openModal({ kind: 'delete', table: item.table ?? 'valid', id: item.id, currentUrl: item.url }),
      onBatchDelete: handleBatchDelete,
      onMarkApplied: handleMarkApplied,
      onMarkUnapplied: handleMarkUnapplied,
      onOpenSelectedUrls: handleOpenSelectedUrls,
      onOpenJobAnalysis: (item: SubmittedUrlItem) => {
        if (item.table === 'valid' && item.extraction_id) {
          setJobAnalysisValidJobId(item.id);
        }
      },
      onTriggerJobMatch: async (item: SubmittedUrlItem) => {
        try {
          await apiClient.post(`/jobs/valid/${item.id}/match`);
          void refreshLists();
        } catch {
          // ignore
        }
      },
      onJobUrlClick: async (item: SubmittedUrlItem) => {
        if (item.table !== 'valid') return;
        const jobId = item.id;
        const prevCount = item.click_count ?? 0;
        setUniqueUrls((prev) => prev.map((u) => (u.id === jobId ? { ...u, click_count: prevCount + 1 } : u)));
        try {
          const res = await apiClient.post<{ click_count: number }>(`/jobs/valid/${jobId}/click`);
          const serverCount = res.data?.click_count ?? prevCount + 1;
          setUniqueUrls((prev) => prev.map((u) => (u.id === jobId ? { ...u, click_count: serverCount } : u)));
        } catch {
          // keep optimistic
        }
      },
      onRescrape: handleRescrape,
      userInitial: getUserInitial(),
      jobAnalysisValidJobId,
      onCloseDetail,
      onMatchStored,
      onCompareDuplicate,
      onReplaceDuplicate,
      onReportDuplicateAsValid: (item: SubmittedUrlItem) =>
        openModal({ kind: 'promoteInvalidToValid', id: item.id, currentUrl: item.url }),
    };
  }, [
    user?.email,
    user?.name,
    logout,
    onMyProfile,
    uniqueUrls,
    duplicateUrls,
    loadingLists,
    url,
    submitNotice,
    submitNoticeKind,
    submitError,
    loading,
    openMenu,
    compareValidJobId,
    handleOpenSelectedUrls,
    jobAnalysisValidJobId,
    onCloseDetail,
    onMatchStored,
    onCompareDuplicate,
    onReplaceDuplicate,
  ]);

  if (isAuthenticated === null) {
    return <div className="flex h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50 text-slate-900">Loading...</div>;
  }

  if (!isAuthenticated) {
    return authPage === 'signup' ? (
      <Signup 
        onSignup={onAuthSuccess}
        onSwitchToLogin={() => setAuthPage('login')}
      />
    ) : (
      <Login 
        onLogin={onAuthSuccess}
        onSwitchToSignup={() => setAuthPage('signup')}
      />
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

      {mainView === 'profiles' ? (
        <ProfilesPage
          onBack={onBackFromProfiles}
          onLogout={logout}
          userEmail={user?.email}
          userName={user?.name ?? undefined}
        />
      ) : (
        <DashboardPage {...dashboardProps} />
      )}
    </>
  );
}

export default App;
