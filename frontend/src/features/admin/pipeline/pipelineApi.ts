import { apiClient } from '@/api/client';
import { fetchDashboardJobs, type DashboardView } from '@/api/scraperApi';
import type { DashboardJob } from '@/types/scraper';

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const e = err as { response?: { data?: { detail?: unknown } }; message?: string };
    const detail = e.response?.data?.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (e.message) return e.message;
  }
  return fallback;
}

export interface ActionResult {
  ok: boolean;
  partial?: boolean;
  message: string;
  /** Rows whose shared JD extraction was (re)queued. */
  extractIds?: string[];
}

/** Admin extract-only run; `force` resets an existing shared JD (Re-extract). */
export async function prepareJob(jobId: string, force: boolean): Promise<ActionResult> {
  try {
    const { data } = await apiClient.post(`/jobs/valid/${jobId}/prepare`, null, {
      params: force ? { force_rescrape: true } : undefined,
    });
    const mode = String(data?.mode || '');
    const queued = mode === 'extract_then_analyze' || (mode === 'extract_only' && data?.status === 'queued');
    return {
      ok: true,
      message:
        data?.message ||
        (mode === 'extract_only' && data?.status === 'ready' ? 'Shared job description already prepared.' : 'Pipeline queued.'),
      extractIds: queued ? [jobId] : [],
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Failed to prepare job.') };
  }
}

const BATCH_LIMIT = 200;

export async function prepareJobs(jobIds: string[]): Promise<ActionResult> {
  const unique = [...new Set(jobIds)];
  const enqueued: string[] = [];
  const extractIds: string[] = [];
  let analyze = 0;
  let skipped = 0;
  try {
    for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
      const { data } = await apiClient.post<{
        jobs?: { job_id: string; mode?: string; status?: string }[];
        skipped?: { id: string; reason: string }[];
      }>('/jobs/valid/prepare/batch', { job_ids: unique.slice(i, i + BATCH_LIMIT) });
      for (const j of data.jobs ?? []) {
        enqueued.push(j.job_id);
        if (j.mode === 'analyze') analyze += 1;
        else if (j.status !== 'ready') extractIds.push(j.job_id);
      }
      skipped += data.skipped?.length ?? 0;
    }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Batch prepare failed.') };
  }
  const ok = skipped === 0 && enqueued.length === unique.length;
  return {
    ok,
    partial: !ok && enqueued.length > 0,
    extractIds,
    message:
      skipped === 0
        ? `Queued ${enqueued.length} job${enqueued.length === 1 ? '' : 's'} (${analyze} analyze, ${extractIds.length} extract).`
        : `Queued ${enqueued.length}, skipped ${skipped}.`,
  };
}

export async function deleteJobs(jobIds: string[]): Promise<ActionResult & { deleted: string[] }> {
  const results = await Promise.allSettled(jobIds.map((id) => apiClient.delete(`/jobs/valid/${id}`)));
  const deleted = jobIds.filter((_, i) => results[i].status === 'fulfilled');
  const failed = jobIds.length - deleted.length;
  if (jobIds.length === 1) {
    const r = results[0];
    return r.status === 'fulfilled'
      ? { ok: true, deleted, message: 'Deleted.' }
      : { ok: false, deleted, message: errorMessage(r.reason, 'Failed to delete job.') };
  }
  return {
    ok: failed === 0,
    deleted,
    message: failed === 0 ? `Deleted ${deleted.length} jobs.` : `Deleted ${deleted.length}, failed ${failed}.`,
  };
}

export interface ListFilters {
  view: DashboardView;
  source: string;
  q: string;
  sort: string;
  order: 'asc' | 'desc';
}

/** Walks every page of the current filters (used by "not extracted · all pages"). */
export async function fetchAllJobs(filters: ListFilters): Promise<DashboardJob[]> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const out: DashboardJob[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await fetchDashboardJobs({
      page,
      per_page: 200,
      view: filters.view,
      source: filters.source || undefined,
      q: filters.q || undefined,
      sort: filters.sort,
      order: filters.order,
      timezone,
    });
    out.push(...res.items);
    pages = Math.max(1, res.pages || 1);
    page += 1;
  } while (page <= pages);
  return out;
}

export interface LlmModel {
  id: string;
  usable_for_chat: boolean;
}

export async function fetchLlmModels(): Promise<{ models: LlmModel[]; message: string | null }> {
  const { data } = await apiClient.get<{ models?: LlmModel[]; chat_models?: LlmModel[]; message?: string | null }>(
    '/settings/llm/models',
  );
  const raw = data.chat_models?.length ? data.chat_models : (data.models ?? []);
  const models = raw.filter((m) => {
    const id = (m.id || '').toLowerCase();
    return id && !id.startsWith('test-') && !id.startsWith('test_');
  });
  return { models, message: data.message ?? null };
}

/** One-shot backend reconciles the legacy dashboard triggered on first visit per session. */
export function reconcileOncePerSession(onLocationsDone?: () => void) {
  const run = (flag: string, path: string, after?: () => void) => {
    if (sessionStorage.getItem(flag)) return;
    sessionStorage.setItem(flag, 'pending');
    void apiClient
      .post(path)
      .then(() => after?.())
      .catch(() => sessionStorage.removeItem(flag));
  };
  run('company_policy_reconciled_v1', '/jobs/valid/reconcile-company-policy');
  run('location_reconciled_v2', '/jobs/reconcile-locations', onLocationsDone);
}

export { errorMessage };
