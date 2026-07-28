import { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  deleteDataManagementJobs,
  getClientTimezone,
  matchRerunDataManagementJobs,
  previewDataManagement,
  reconcileLocationsDataManagement,
  rescrapeDataManagementJobs,
} from '../../api/dataManagementApi';
import { cleanupJobs } from '../../api/adminApi';
import type {
  DataManagementFilters,
  DataManagementPreview,
} from '../../types/dataManagement';
import type { JobCleanupResult } from '../../types/admin';
import { ConfirmDialog } from '../extraction/ConfirmDialog';

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

type PendingAction = 'delete' | 'rescrape' | 'match' | 'reconcile' | null;

const EXTRACTION_STATUSES = [
  'any',
  'pending',
  'processing',
  'extracted',
  'completed',
  'failed',
] as const;

function defaultFilters(): DataManagementFilters {
  return {
    date_field: 'created_at',
    date_from: daysAgoIsoDate(30),
    date_to: todayIsoDate(),
    timezone: getClientTimezone(),
    visibility: 'visible',
    work_mode: 'any',
    extraction_status: 'any',
    is_job_posting: 'any',
    source: null,
    min_match_score: null,
    max_match_score: null,
    has_application: 'any',
  };
}

export function DataManagementOpsSection() {
  const [filters, setFilters] = useState<DataManagementFilters>(defaultFilters);
  const [preview, setPreview] = useState<DataManagementPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [acting, setActing] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionOk, setActionOk] = useState(false);
  const [cleanupDays, setCleanupDays] = useState(60);
  const [cleanupPreview, setCleanupPreview] = useState<JobCleanupResult | null>(null);
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const patch = useCallback(<K extends keyof DataManagementFilters>(key: K, value: DataManagementFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPreview(null);
    setActionMsg('');
  }, []);

  const handlePreview = async () => {
    setPreviewing(true);
    setActionMsg('');
    try {
      const result = await previewDataManagement(filters);
      setPreview(result);
      setActionOk(true);
      setActionMsg(
        result.capped
          ? `Matched ${result.matched_count} jobs (capped at ${result.limit}).`
          : `Matched ${result.matched_count} job${result.matched_count === 1 ? '' : 's'}.`,
      );
    } catch (err: unknown) {
      setPreview(null);
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Preview failed.'));
    } finally {
      setPreviewing(false);
    }
  };

  const confirmCopy = useMemo(() => {
    const count = preview?.matched_count ?? 0;
    switch (pendingAction) {
      case 'delete':
        return {
          title: 'Delete matching jobs?',
          description: (
            <p>
              Permanently delete <strong>{count}</strong> matching job
              {count === 1 ? '' : 's'} and related match / application / extraction
              rows. This cannot be undone.
            </p>
          ),
          confirmLabel: 'Delete permanently',
          variant: 'danger' as const,
        };
      case 'rescrape':
        return {
          title: 'Re-extract matching jobs?',
          description: (
            <p>
              Queue page extraction for up to <strong>{count}</strong> matching job
              {count === 1 ? '' : 's'}. Match scores for those jobs will be cleared and
              re-run after extraction.
            </p>
          ),
          confirmLabel: 'Queue re-extract',
          variant: 'neutral' as const,
        };
      case 'match':
        return {
          title: 'Re-run match analysis?',
          description: (
            <p>
              Queue AI match analysis for eligible jobs among the{' '}
              <strong>{count}</strong> matches (requires completed extraction).
            </p>
          ),
          confirmLabel: 'Queue match re-run',
          variant: 'neutral' as const,
        };
      case 'reconcile':
        return {
          title: 'Reconcile locations?',
          description: (
            <p>
              Re-classify locations for the <strong>{count}</strong> matching jobs and
              hide non-US / unverified ones. Also restores previously location-hidden
              jobs that now classify as US.
            </p>
          ),
          confirmLabel: 'Run reconcile',
          variant: 'neutral' as const,
        };
      default:
        return null;
    }
  }, [pendingAction, preview]);

  const runAction = async () => {
    if (!pendingAction || !preview) return;
    setActing(true);
    setActionMsg('');
    try {
      if (pendingAction === 'delete') {
        const res = await deleteDataManagementJobs(filters);
        setActionOk(res.failed === 0);
        setActionMsg(
          `Deleted ${res.deleted} of ${res.matched_count} job${res.matched_count === 1 ? '' : 's'}` +
            (res.failed ? ` (${res.failed} failed).` : '.'),
        );
      } else if (pendingAction === 'rescrape') {
        const res = await rescrapeDataManagementJobs(filters);
        setActionOk(true);
        setActionMsg(
          `Queued re-extract for ${res.enqueued} job${res.enqueued === 1 ? '' : 's'}` +
            (res.skipped.length ? `; skipped ${res.skipped.length}.` : '.'),
        );
      } else if (pendingAction === 'match') {
        const res = await matchRerunDataManagementJobs(filters);
        setActionOk(res.enqueued > 0 || res.skipped.length === 0);
        setActionMsg(
          res.message ||
            `Queued match re-run for ${res.enqueued} job${res.enqueued === 1 ? '' : 's'}` +
              (res.skipped.length ? `; skipped ${res.skipped.length}.` : '.'),
        );
      } else if (pendingAction === 'reconcile') {
        const res = await reconcileLocationsDataManagement(filters);
        setActionOk(true);
        setActionMsg(
          `Scanned ${res.scanned}: moved ${res.moved_non_us} non-US, ${res.moved_unknown} unknown; restored ${res.restored}.`,
        );
      }
      setPreview(null);
      setPendingAction(null);
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Action failed.'));
      setPendingAction(null);
    } finally {
      setActing(false);
    }
  };

  const actionsDisabled = !preview || preview.matched_count === 0 || previewing || acting;

  return (
    <>
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 md:p-6">
        <div>
          <h2 className="text-base font-bold text-slate-900">Data management</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Preview jobs for a custom period and parameters, then delete or revalidate.
          </p>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Date field
            <select
              value={filters.date_field}
              onChange={(e) => patch('date_field', e.target.value as DataManagementFilters['date_field'])}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="created_at">Created in DB</option>
              <option value="posted_date">Employer posted date</option>
              <option value="added_at">Added to dashboard</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            From
            <input
              type="date"
              value={filters.date_from}
              onChange={(e) => patch('date_from', e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            To
            <input
              type="date"
              value={filters.date_to}
              onChange={(e) => patch('date_to', e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <div className="md:col-span-2 xl:col-span-3">
            <p className="mb-1.5 text-xs font-semibold text-slate-700">Quick period</p>
            <div className="flex flex-wrap gap-2">
              {[7, 14, 30, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => {
                    setFilters((prev) => ({
                      ...prev,
                      date_from: daysAgoIsoDate(days),
                      date_to: todayIsoDate(),
                    }));
                    setPreview(null);
                    setActionMsg('');
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-300"
                >
                  Last {days}d
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Visibility
            <select
              value={filters.visibility}
              onChange={(e) =>
                patch('visibility', e.target.value as DataManagementFilters['visibility'])
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="visible">Visible (active)</option>
              <option value="hidden">Hidden / excluded</option>
              <option value="all">All (not blocked)</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Work mode
            <select
              value={filters.work_mode}
              onChange={(e) =>
                patch('work_mode', e.target.value as DataManagementFilters['work_mode'])
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="any">Any</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">Onsite / other</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Extraction status
            <select
              value={filters.extraction_status}
              onChange={(e) => patch('extraction_status', e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              {EXTRACTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === 'any' ? 'Any' : s}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Is job posting
            <select
              value={filters.is_job_posting}
              onChange={(e) =>
                patch('is_job_posting', e.target.value as DataManagementFilters['is_job_posting'])
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="any">Any</option>
              <option value="true">Yes</option>
              <option value="false">No / unknown</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Source
            <input
              type="text"
              value={filters.source ?? ''}
              onChange={(e) => patch('source', e.target.value || null)}
              placeholder="e.g. greenhouse, lever, manual"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Has application
            <select
              value={filters.has_application}
              onChange={(e) =>
                patch(
                  'has_application',
                  e.target.value as DataManagementFilters['has_application'],
                )
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
            >
              <option value="any">Any</option>
              <option value="true">Applied</option>
              <option value="false">Not applied</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Min match score
            <input
              type="number"
              min={0}
              max={100}
              value={filters.min_match_score ?? ''}
              onChange={(e) =>
                patch(
                  'min_match_score',
                  e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))),
                )
              }
              placeholder="Any"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Max match score
            <input
              type="number"
              min={0}
              max={100}
              value={filters.max_match_score ?? ''}
              onChange={(e) =>
                patch(
                  'max_match_score',
                  e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))),
                )
              }
              placeholder="Any"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handlePreview()}
            disabled={previewing || acting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {previewing ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {previewing ? 'Previewing…' : 'Preview matches'}
          </button>
        </div>

        {preview && (
          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                {preview.matched_count} match{preview.matched_count === 1 ? '' : 'es'}
                {preview.capped ? ` (capped at ${preview.limit})` : ''}
              </p>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => setPendingAction('rescrape')}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50 sm:flex-none"
                >
                  <RefreshCw size={13} />
                  Re-extract
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => setPendingAction('match')}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-50 sm:flex-none"
                >
                  <Sparkles size={13} />
                  Re-run match
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => setPendingAction('reconcile')}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50 sm:flex-none"
                >
                  <MapPin size={13} />
                  Reconcile locations
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => setPendingAction('delete')}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-800 hover:bg-rose-100 disabled:opacity-50 sm:flex-none"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              </div>
            </div>

            {preview.sample.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Title</th>
                      <th className="px-3 py-2 font-semibold">Company</th>
                      <th className="px-3 py-2 font-semibold">Extraction</th>
                      <th className="px-3 py-2 font-semibold">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row) => (
                      <tr key={row.job_id} className="border-t border-slate-100">
                        <td className="max-w-[220px] truncate px-3 py-2 text-slate-800">
                          {row.title || '-'}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2 text-slate-600">
                          {row.company || '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.extraction_status || '-'}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-600">
                          {row.match_score ?? '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.matched_count > preview.sample.length && (
                  <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                    Showing {preview.sample.length} of {preview.matched_count} matches.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {actionMsg && (
          <p
            className={`mt-4 flex items-center gap-1.5 text-sm font-medium ${
              actionOk ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {actionOk ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {actionMsg}
          </p>
        )}
      </section>

      {confirmCopy && (
        <ConfirmDialog
          open={pendingAction !== null}
          title={confirmCopy.title}
          description={confirmCopy.description}
          confirmLabel={confirmCopy.confirmLabel}
          cancelLabel="Cancel"
          variant={confirmCopy.variant}
          loading={acting}
          onConfirm={() => void runAction()}
          onCancel={() => {
            if (!acting) setPendingAction(null);
          }}
        />
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="mb-3">
          <h2 className="text-sm font-bold text-slate-900">Global job cleanup</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Delete jobs older than a threshold across all users (cascade purge).
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-slate-700">
            Older than (days)
            <input
              type="number"
              min={1}
              max={3650}
              value={cleanupDays}
              onChange={(e) => setCleanupDays(Number(e.target.value) || 60)}
              className="mt-1 block w-28 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={cleanupBusy}
            onClick={async () => {
              setCleanupBusy(true);
              try {
                const result = await cleanupJobs({
                  older_than_days: cleanupDays,
                  preview_only: true,
                });
                setCleanupPreview(result);
              } catch (err) {
                setActionOk(false);
                setActionMsg(extractErrorMessage(err, 'Cleanup preview failed'));
              } finally {
                setCleanupBusy(false);
              }
            }}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Preview
          </button>
          <button
            type="button"
            disabled={!cleanupPreview || cleanupPreview.matching_jobs === 0 || cleanupBusy}
            onClick={() => setCleanupConfirmOpen(true)}
            className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Delete matching jobs
          </button>
        </div>
        {cleanupPreview ? (
          <p className="mt-3 text-sm text-slate-600">
            {cleanupPreview.matching_jobs} job(s) older than {cleanupPreview.older_than_days} days
            (cutoff {new Date(cleanupPreview.cutoff).toLocaleString()}).
          </p>
        ) : null}
      </section>

      <ConfirmDialog
        open={cleanupConfirmOpen}
        title="Delete old jobs?"
        description={
          cleanupPreview ? (
            <>
              Permanently delete <strong>{cleanupPreview.matching_jobs}</strong> job(s) older than{' '}
              {cleanupPreview.older_than_days} days across all users. This cannot be undone.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Delete"
        variant="danger"
        loading={cleanupBusy}
        onConfirm={async () => {
          setCleanupBusy(true);
          try {
            const res = await cleanupJobs({
              older_than_days: cleanupDays,
              confirm: true,
            });
            setCleanupPreview(res);
            setActionOk(true);
            setActionMsg(`Deleted ${res.deleted} job(s)`);
          } catch (err) {
            setActionOk(false);
            setActionMsg(extractErrorMessage(err, 'Cleanup failed'));
          } finally {
            setCleanupBusy(false);
            setCleanupConfirmOpen(false);
          }
        }}
        onCancel={() => {
          if (!cleanupBusy) setCleanupConfirmOpen(false);
        }}
      />
    </>
  );
}
