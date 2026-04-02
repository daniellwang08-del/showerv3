import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SubmissionResponse } from './types';
import { apiClient } from './api/client';
import { ModalState, SubmittedUrlItem } from './types/ui';
import { Login } from './components/Login';
import { Signup } from './components/Signup';
import { JobActionModal } from './components/JobActionModal';
import { useAuth } from './hooks/useAuth';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ProfilesPage } from './features/profiles/ProfilesPage';
import { mainViewFromHash, navigateMainView, type MainView } from './mainViewRouting';
import { parseServerDateTime } from './utils/serverDate';
import { logger } from './utils/logger';
import {
  JOB_PAGE_SIZE,
  mapInvalidJobRow,
  mapValidJobRow,
  mergeInvalidJobs,
  mergeValidJobs,
  type InvalidJobApiRow,
  type ValidJobApiRow,
} from './utils/jobListPagination';

function App() {
  const { isAuthenticated, user, authPage, setAuthPage, logout, onAuthSuccess } = useAuth();
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

  /** Server offset for the next "older" page (not affected by merge polls). */
  const [validNextOffset, setValidNextOffset] = useState(0);
  const [validHasMore, setValidHasMore] = useState(false);
  const [loadingMoreValid, setLoadingMoreValid] = useState(false);
  const [invalidNextOffset, setInvalidNextOffset] = useState(0);
  const [invalidHasMore, setInvalidHasMore] = useState(false);
  const [loadingMoreInvalid, setLoadingMoreInvalid] = useState(false);

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
        await refreshLists({ showLoading: false, reset: true });
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

      await refreshLists({ showLoading: false, reset: true });
      closeModal();
    } catch (e: any) {
      setModalError(e.response?.data?.detail || 'Action failed');
    } finally {
      setModalSubmitting(false);
      setOpenMenu(null);
    }
  };

  type RefreshOpts = { showLoading?: boolean; reset?: boolean };

  const refreshLists = async (opts: RefreshOpts = {}) => {
    const showLoading = opts.showLoading !== false;
    const reset = opts.reset === true;

    if (!isAuthenticated) return;
    const shouldShowLoading = showLoading && isInitialListsLoad.current;
    try {
      if (shouldShowLoading) setLoadingLists(true);

      const [validRes, invalidRes] = await Promise.all([
        apiClient.get<ValidJobApiRow[]>(`/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=0`),
        apiClient.get<InvalidJobApiRow[]>(`/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=0`),
      ]);

      const mappedValid = (validRes.data ?? []).map((j) => mapValidJobRow(j));
      const mappedInvalid = (invalidRes.data ?? []).map((j) => mapInvalidJobRow(j));

      if (reset) {
        setUniqueUrls(mappedValid);
        setDuplicateUrls(mappedInvalid);
        setValidNextOffset(mappedValid.length);
        setValidHasMore(mappedValid.length === JOB_PAGE_SIZE);
        setInvalidNextOffset(mappedInvalid.length);
        setInvalidHasMore(mappedInvalid.length === JOB_PAGE_SIZE);
      } else {
        setUniqueUrls((prev) => mergeValidJobs(prev, mappedValid));
        setDuplicateUrls((prev) => mergeInvalidJobs(prev, mappedInvalid));
      }
      isInitialListsLoad.current = false;
    } catch {
      return;
    } finally {
      if (shouldShowLoading) setLoadingLists(false);
    }
  };

  const loadMoreValidJobs = async () => {
    if (!isAuthenticated || !validHasMore || loadingMoreValid) return;
    setLoadingMoreValid(true);
    try {
      const res = await apiClient.get<ValidJobApiRow[]>(
        `/jobs/valid?limit=${JOB_PAGE_SIZE}&offset=${validNextOffset}`,
      );
      const chunk = (res.data ?? []).map((j) => mapValidJobRow(j));
      if (chunk.length === 0) {
        setValidHasMore(false);
        return;
      }
      setUniqueUrls((prev) => {
        const seen = new Set(prev.map((j) => j.id));
        const merged = [...prev];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return merged.sort((a, b) => b.created_at_ms - a.created_at_ms);
      });
      setValidNextOffset((o) => o + chunk.length);
      setValidHasMore(chunk.length === JOB_PAGE_SIZE);
    } catch {
      return;
    } finally {
      setLoadingMoreValid(false);
    }
  };

  const loadMoreInvalidJobs = async () => {
    if (!isAuthenticated || !invalidHasMore || loadingMoreInvalid) return;
    setLoadingMoreInvalid(true);
    try {
      const res = await apiClient.get<InvalidJobApiRow[]>(
        `/jobs/invalid?limit=${JOB_PAGE_SIZE}&offset=${invalidNextOffset}`,
      );
      const chunk = (res.data ?? []).map((j) => mapInvalidJobRow(j));
      if (chunk.length === 0) {
        setInvalidHasMore(false);
        return;
      }
      setDuplicateUrls((prev) => {
        const seen = new Set(prev.map((j) => j.id));
        const merged = [...prev];
        for (const j of chunk) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push(j);
          }
        }
        return merged.sort((a, b) => b.created_at_ms - a.created_at_ms);
      });
      setInvalidNextOffset((o) => o + chunk.length);
      setInvalidHasMore(chunk.length === JOB_PAGE_SIZE);
    } catch {
      return;
    } finally {
      setLoadingMoreInvalid(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      void refreshLists({ showLoading: true, reset: true });
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !uniqueUrls.length) return;
    const hasExtractionInProgress = uniqueUrls.some(
      (u) => u.extraction_status === 'pending' || u.extraction_status === 'processing',
    );
    const hasMatchInProgress = uniqueUrls.some((u) => u.match_status === 'processing');
    const catchupMs = 15 * 60 * 1000;
    const needsMatchScoreCatchup = uniqueUrls.some((u) => {
      if (u.table !== 'valid' || !u.extraction_id || u.extraction_status !== 'completed') return false;
      if (u.match_overall_score != null || u.match_status === 'processing') return false;
      const refMs = u.scraped_at_ms ?? u.created_at_ms;
      return Date.now() - refMs < catchupMs;
    });
    if (!hasExtractionInProgress && !hasMatchInProgress && !needsMatchScoreCatchup) return;
    const interval = setInterval(() => void refreshLists({ showLoading: false, reset: false }), 5000);
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
        await refreshLists({ showLoading: false, reset: false });
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

  const handleMarkApplied = async (items: SubmittedUrlItem[]) => {
    const valid_job_ids = [...new Set(items.filter((i) => i.table === 'valid').map((i) => i.id))];
    if (valid_job_ids.length === 0) return;
    try {
      const res = await apiClient.post<{ marked: number; applied_by_name: string; applied_at?: string }>(
        '/jobs/valid/applied/batch',
        { valid_job_ids },
      );
      const label = res.data?.applied_by_name?.trim() ?? '';
      const serverAt = res.data?.applied_at ? parseServerDateTime(res.data.applied_at) : undefined;
      const appliedMs = serverAt ?? Date.now();
      setUniqueUrls((prev) =>
        prev.map((job) =>
          valid_job_ids.includes(job.id)
            ? { ...job, appliedAt: appliedMs, appliedBy: label || job.appliedBy }
            : job,
        ),
      );
      await refreshLists({ showLoading: false, reset: false });
    } catch (error: any) {
      setSubmitError(error.response?.data?.detail || 'Failed to save applied status');
      throw error;
    }
  };

  const handleMarkUnapplied = async (items: SubmittedUrlItem[]) => {
    const valid_job_ids = [...new Set(items.filter((i) => i.table === 'valid').map((i) => i.id))];
    if (valid_job_ids.length === 0) return;
    try {
      await apiClient.post('/jobs/valid/unapplied/batch', { valid_job_ids });
      setUniqueUrls((prev) =>
        prev.map((job) =>
          valid_job_ids.includes(job.id) ? { ...job, appliedAt: undefined, appliedBy: undefined } : job,
        ),
      );
      await refreshLists({ showLoading: false, reset: false });
    } catch (error: any) {
      setSubmitError(error.response?.data?.detail || 'Failed to clear applied status');
      throw error;
    }
  };

  const handleRescrape = async (item: SubmittedUrlItem) => {
    try {
      await apiClient.post(`/jobs/valid/${item.id}/rescrape`, { url: item.url });
      await refreshLists({ showLoading: false, reset: false });
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
    logger.info('ui_batch_delete_started', { count: itemsToDelete.length });
    
    try {
      setLoadingLists(true);
      
      // Delete each job by ID and table
      for (const item of itemsToDelete) {
        const table = item.table || 'valid'; // Default to 'valid' if table not specified
        try {
          await apiClient.delete(`/jobs/${table}/${item.id}`);
          logger.debug('ui_batch_delete_item_success', { job_id: item.id, table });
        } catch (error) {
          logger.error('ui_batch_delete_item_failed', { job_id: item.id, table, error: String(error) });
        }
      }
      
      // Refresh the list after all deletions
      logger.info('ui_batch_delete_refreshing_lists');
      await refreshLists({ showLoading: false, reset: true });
      
    } catch (error) {
      logger.error('ui_batch_delete_failed', { error: String(error) });
      setSubmitError('Error deleting jobs');
    } finally {
      setLoadingLists(false);
    }
  };

  const onCloseDetail = useCallback(() => {
    setJobAnalysisValidJobId(null);
  }, []);

  const onMatchStored = useCallback(() => void refreshLists({ showLoading: false, reset: false }), []);

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
        await refreshLists({ showLoading: false, reset: false });
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
      onTriggerJobMatch: async (item: SubmittedUrlItem, opts?: { force?: boolean }) => {
        try {
          await apiClient.post(`/jobs/valid/${item.id}/match`, null, {
            params: { force: opts?.force === true },
          });
          void refreshLists({ showLoading: false, reset: false });
        } catch {
          // ignore
        }
      },
      onRerunMatchAnalysis: async (items: SubmittedUrlItem[]) => {
        const valid_job_ids = [...new Set(items.map((i) => i.id).filter(Boolean))];
        if (valid_job_ids.length === 0) return;
        try {
          await apiClient.post(`/jobs/valid/match/rerun`, { valid_job_ids });
          void refreshLists({ showLoading: false, reset: false });
        } catch {
          // ignore
        }
      },
      onBatchRescrapePipeline: async (items: SubmittedUrlItem[]) => {
        const valid_job_ids = [...new Set(items.filter((i) => i.table === 'valid').map((i) => i.id))];
        if (valid_job_ids.length === 0) return;
        try {
          await apiClient.post(`/jobs/valid/rescrape/batch`, { valid_job_ids });
          await refreshLists({ showLoading: false, reset: false });
        } catch (error: any) {
          setSubmitError(error.response?.data?.detail || 'Failed to queue re-scrape');
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
      jobAnalysisValidJobId,
      onCloseDetail,
      onMatchStored,
      onCompareDuplicate,
      onReplaceDuplicate,
      onReportDuplicateAsValid: (item: SubmittedUrlItem) =>
        openModal({ kind: 'promoteInvalidToValid', id: item.id, currentUrl: item.url }),
      jobListHasMore: validHasMore,
      loadingMoreValidJobs: loadingMoreValid,
      onLoadMoreValidJobs: loadMoreValidJobs,
      validJobsLoadedCount: uniqueUrls.length,
      duplicateListHasMore: invalidHasMore,
      loadingMoreDuplicates: loadingMoreInvalid,
      onLoadMoreDuplicates: loadMoreInvalidJobs,
      duplicatesLoadedCount: duplicateUrls.length,
    };
  }, [
    user?.email,
    user?.name,
    logout,
    onMyProfile,
    uniqueUrls,
    duplicateUrls,
    loadingLists,
    validHasMore,
    loadingMoreValid,
    loadMoreValidJobs,
    invalidHasMore,
    loadingMoreInvalid,
    loadMoreInvalidJobs,
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
