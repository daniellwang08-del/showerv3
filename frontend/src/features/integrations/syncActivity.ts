import type { JobSiteSyncActivity } from '@/api/jobSitesApi';

export interface SyncSummary {
  /** One line for the progress bar ("Scoring new jobs from RemoteRocketship"). */
  label: string;
  /** "12 of 24" while scoring; empty while fetching. */
  detail: string;
  /** 0-100 while scoring; null while listings are still being fetched. */
  percent: number | null;
}

function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? 'your job sites';
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} more`;
}

/** Collapse every running sync into one progress line; null when nothing runs. */
export function summarizeSyncActivity(items: JobSiteSyncActivity[] | undefined): SyncSummary | null {
  const running = (items ?? []).filter(Boolean);
  if (running.length === 0) return null;

  const scoring = running.filter((a) => a.phase === 'analyzing' && a.total > 0);
  if (scoring.length > 0) {
    const total = scoring.reduce((n, a) => n + a.total, 0);
    const done = Math.min(total, scoring.reduce((n, a) => n + a.done, 0));
    const fetching = running.length > scoring.length;
    return {
      label: `Scoring new jobs from ${joinNames(scoring.map((a) => a.plugin_name))}${fetching ? ', fetching more' : ''}`,
      detail: `${done} of ${total}`,
      percent: Math.round((done / total) * 100),
    };
  }

  const names = joinNames(running.map((a) => a.plugin_name));
  const queuedOnly = running.every((a) => a.phase === 'queued');
  return {
    label: queuedOnly ? `Starting sync with ${names}` : `Fetching new jobs from ${names}`,
    detail: '',
    percent: null,
  };
}
