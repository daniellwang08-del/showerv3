import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useShellStore } from '@/stores/shellStore';

export const JOB_PARAM = 'job';

type JobRef = { id: string; title?: string | null; company?: string | null };

/** Opens the job detail panel for any page by setting `?job=<id>`. */
export function useOpenJob() {
  const [, setParams] = useSearchParams();
  const pushRecentJob = useShellStore((s) => s.pushRecentJob);

  return useCallback(
    (job: JobRef) => {
      pushRecentJob({ id: job.id, title: job.title || 'Untitled role', company: job.company || '' });
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(JOB_PARAM, job.id);
          return next;
        },
        { replace: false },
      );
    },
    [setParams, pushRecentJob],
  );
}
