import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchNewJobsCount } from '@/api/scraperApi';
import { useShellStore } from '@/stores/shellStore';

export const JOBS_PATH = '/app/jobs';
export const newJobsKey = (since: string | null) => ['jobs', 'new-count', since] as const;

/**
 * Scored jobs that reached the board since the user last looked at the Jobs page.
 *
 * Viewing the page (arriving or leaving) marks everything seen, so jobs that
 * land while it is open never count. Lives under the ``jobs`` query prefix,
 * which pipeline websocket events already invalidate.
 */
export function useNewJobsBadge(enabled: boolean): number {
  const seenAt = useShellStore((s) => s.jobsSeenAt);
  const markJobsSeen = useShellStore((s) => s.markJobsSeen);
  const { pathname } = useLocation();
  const onJobs = pathname === JOBS_PATH || pathname.startsWith(`${JOBS_PATH}/`);

  useEffect(() => {
    if (!enabled) return;
    if (onJobs || !seenAt) markJobsSeen();
    if (!onJobs) return;
    return () => useShellStore.getState().markJobsSeen();
    // seenAt only seeds the first visit; re-running on every mark would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onJobs, markJobsSeen]);

  const query = useQuery({
    queryKey: newJobsKey(seenAt),
    queryFn: () => fetchNewJobsCount(seenAt as string),
    enabled: enabled && !onJobs && Boolean(seenAt),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  return enabled && !onJobs ? query.data?.count ?? 0 : 0;
}

export function newJobsBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
