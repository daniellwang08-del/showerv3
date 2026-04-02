import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { apiClient } from '../api/client';
import { parseServerDateTime, toFiniteTimeMs } from '../utils/serverDate';
import type { SubmissionResponse } from '../types';
import type { ExtractionStatusLabel, SubmittedUrlItem } from '../types/ui';

export function useJobsLists(isAuthenticated: boolean) {
  const [loading, setLoading] = useState(false);
  const [loadingLists, setLoadingLists] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');
  const [submitNoticeKind, setSubmitNoticeKind] = useState<'success' | 'warning'>('success');

  const [uniqueUrls, setUniqueUrls] = useState<SubmittedUrlItem[]>([]);
  const [duplicateUrls, setDuplicateUrls] = useState<SubmittedUrlItem[]>([]);
  const [url, setUrl] = useState('');

  const isInitialListsLoad = useRef(true);

  const refreshLists = useCallback(
    async (showLoading = true) => {
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
          applied_at?: string | null;
          applied_by_name?: string | null;
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
            const scrapedMs = j.scraped_at ? parseServerDateTime(j.scraped_at) : undefined;
            const createdMs = parseServerDateTime(j.created_at) ?? 0;
            const postedDateMs = j.posted_date ? parseServerDateTime(j.posted_date) : undefined;
            const raw = j as {
              applied_at?: string | null;
              appliedAt?: string | null;
              applied_by_name?: string | null;
            };
            const appliedAtParsed = toFiniteTimeMs(raw.applied_at ?? raw.appliedAt ?? undefined);
            return {
              id: j.id,
              url: j.source_url,
              message: 'Job submitted successfully',
              job_id: j.id,
              duplicate_job_id: null,
              created_at_ms: createdMs,
              scraped_at_ms: scrapedMs,
              extraction_id: j.extraction_id ?? undefined,
              extraction_status: (j.extraction_status as ExtractionStatusLabel | null) ?? undefined,
              match_overall_score: j.match_overall_score ?? undefined,
              match_status: j.match_status ?? undefined,
              click_count: j.click_count ?? 0,
              posted_date_ms: postedDateMs,
              appliedAt: appliedAtParsed,
              appliedBy: raw.applied_by_name?.trim() ? raw.applied_by_name.trim() : undefined,
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
      } catch {
        return;
      } finally {
        if (shouldShowLoading) setLoadingLists(false);
      }
    },
    [isAuthenticated],
  );

  useEffect(() => {
    if (isAuthenticated) {
      void refreshLists();
    }
  }, [isAuthenticated, refreshLists]);

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
    const interval = setInterval(() => void refreshLists(), 5000);
    return () => clearInterval(interval);
  }, [isAuthenticated, refreshLists, uniqueUrls]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
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
                : response.message || 'Duplicate job detected.',
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
            setSubmitNotice('');
          }
          await refreshLists(false);
        } else {
          setSubmitError(response.message || 'Error submitting job');
          setSubmitNotice('');
        }

        if (response.success) setUrl('');
      } catch (error: any) {
        setSubmitError(error.response?.data?.detail || 'Error submitting job');
        setSubmitNotice('');
      } finally {
        setLoading(false);
      }
    },
    [duplicateUrls, refreshLists, url],
  );

  const rescrape = useCallback(
    async (item: SubmittedUrlItem) => {
      try {
        await apiClient.post(`/jobs/valid/${item.id}/rescrape`, { url: item.url });
        await refreshLists();
      } catch (error: any) {
        setSubmitError(error.response?.data?.detail || 'Failed to rescrape job');
      }
    },
    [refreshLists],
  );

  const batchDelete = useCallback(
    async (itemsToDelete: SubmittedUrlItem[]) => {
      try {
        setLoadingLists(true);
        for (const item of itemsToDelete) {
          const table = item.table || 'valid';
          try {
            await apiClient.delete(`/jobs/${table}/${item.id}`);
          } catch {
            // keep going
          }
        }
        await refreshLists();
      } catch {
        setSubmitError('Error deleting jobs');
      } finally {
        setLoadingLists(false);
      }
    },
    [refreshLists],
  );

  const openSelectedUrls = useCallback(async (items: SubmittedUrlItem[]) => {
    if (!items.length) return;

    const uniqueItems = items.filter((item, index, arr) => arr.findIndex((x) => x.url === item.url) === index);
    uniqueItems.forEach((item) => window.open(item.url, '_blank', 'noopener,noreferrer'));

    // optimistic click count
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
          setUniqueUrls((prev) => prev.map((job) => (job.id === item.id ? { ...job, click_count: serverCount } : job)));
        } catch {
          // keep optimistic
        }
      }),
    );
  }, []);

  const clickJobUrl = useCallback(async (item: SubmittedUrlItem) => {
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
  }, []);

  const hasInProgress = useMemo(() => {
    const hasExtractionInProgress = uniqueUrls.some(
      (u) => u.extraction_status === 'pending' || u.extraction_status === 'processing',
    );
    const hasMatchInProgress = uniqueUrls.some((u) => u.match_status === 'processing');
    return hasExtractionInProgress || hasMatchInProgress;
  }, [uniqueUrls]);

  return {
    loading,
    loadingLists,
    submitError,
    submitNotice,
    submitNoticeKind,
    uniqueUrls,
    duplicateUrls,
    url,
    setUrl,
    setSubmitError,
    setSubmitNotice,
    setSubmitNoticeKind,
    refreshLists,
    handleSubmit,
    rescrape,
    batchDelete,
    openSelectedUrls,
    clickJobUrl,
    hasInProgress,
  };
}

