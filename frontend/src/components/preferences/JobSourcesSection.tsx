import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Building2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  createJobSource,
  deleteJobSource,
  fetchJobSources,
  syncJobSourceNow,
  updateJobSource,
  type JobSource,
} from '../../api/jobSourcesApi';
import { SettingsCard } from '../settings/SettingsCard';
import { SettingsToggle } from '../shared/SettingsToggle';

const ATS_LABELS: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
};

function errorDetail(err: unknown, fallback: string): string {
  const detail =
    err && typeof err === 'object' && 'response' in err
      ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
      : null;
  return typeof detail === 'string' ? detail : fallback;
}

function formatSyncedAt(iso: string | null): string {
  if (!iso) return 'Never synced';
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return 'Never synced';
  return `Synced ${date.toLocaleString()}`;
}

export function JobSourcesSection() {
  const [sources, setSources] = useState<JobSource[]>([]);
  const [maxSources, setMaxSources] = useState(10);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchJobSources();
      setSources(data.sources);
      setMaxSources(data.max_sources);
    } catch {
      setError('Failed to load job sites.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const handleAdd = async () => {
    const trimmed = url.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    setError('');
    try {
      const created = await createJobSource(trimmed);
      setSources((prev) => [...prev, created]);
      setUrl('');
      setNotice(
        `${created.name} added — first sync started. New jobs appear on your dashboard shortly.`,
      );
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to add this job site.'));
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (source: JobSource) => {
    setBusyId(source.id);
    setError('');
    try {
      const updated = await updateJobSource(source.id, { enabled: !source.enabled });
      setSources((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to update this job site.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (source: JobSource) => {
    setBusyId(source.id);
    setError('');
    try {
      await deleteJobSource(source.id);
      setSources((prev) => prev.filter((s) => s.id !== source.id));
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to remove this job site.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleSync = async (source: JobSource) => {
    setBusyId(source.id);
    setError('');
    try {
      await syncJobSourceNow(source.id);
      setNotice(`Sync started for ${source.name}. New jobs appear on your dashboard shortly.`);
      window.setTimeout(() => void load(), 8000);
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to start the sync.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsCard
      icon={Building2}
      iconClass="bg-gradient-to-br from-violet-500 to-purple-600"
      title="My job sites"
      description="Add company job boards (Greenhouse, Lever, Ashby, Workable). New postings are pulled into your pipeline automatically every few hours."
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
            }}
            placeholder="https://boards.greenhouse.io/company"
            disabled={adding || sources.length >= maxSources}
            className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-800 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-200 disabled:opacity-60 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-[#e2e8f0]"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={!url.trim() || adding || sources.length >= maxSources}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add
          </button>
        </div>

        {sources.length >= maxSources ? (
          <p className="text-xs text-slate-500 dark:text-[#94a3b8]">
            Limit reached ({maxSources} sites). Remove one to add another.
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-[#94a3b8]">
            <Loader2 size={14} className="animate-spin" /> Loading job sites…
          </p>
        ) : sources.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500 dark:border-slate-500/40 dark:text-[#94a3b8]">
            No job sites yet. Paste a company board URL above to start pulling their
            openings automatically.
          </p>
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => {
              const busy = busyId === source.id;
              return (
                <li
                  key={source.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-slate-500/30 dark:bg-[#0b1220]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-800 dark:text-[#e2e8f0]">
                        {source.name}
                      </span>
                      <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                        {ATS_LABELS[source.ats_type] ?? source.ats_type}
                      </span>
                    </div>
                    <p className="truncate text-xs text-slate-500 dark:text-[#94a3b8]">
                      {source.last_error ? (
                        <span className="text-rose-600 dark:text-rose-400">
                          Last sync failed: {source.last_error}
                        </span>
                      ) : (
                        <>
                          {formatSyncedAt(source.last_synced_at)}
                          {source.last_listing_count != null
                            ? ` · ${source.last_listing_count} open roles`
                            : ''}
                          {source.last_new_jobs != null
                            ? ` · ${source.last_new_jobs} new last sync`
                            : ''}
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <SettingsToggle
                      checked={source.enabled}
                      disabled={busy}
                      onChange={() => void handleToggle(source)}
                      aria-label={source.enabled ? 'Disable auto-sync' : 'Enable auto-sync'}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSync(source)}
                      disabled={busy || !source.enabled}
                      title="Sync now"
                      className="rounded-lg border border-slate-300 p-1.5 text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-500/40 dark:text-[#94a3b8] dark:hover:bg-slate-500/10"
                    >
                      {busy ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(source)}
                      disabled={busy}
                      title="Remove"
                      className="rounded-lg border border-rose-200 p-1.5 text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-400/40 dark:text-rose-400 dark:hover:bg-rose-500/10"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {notice ? (
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{notice}</p>
        ) : null}
        {error ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-rose-700 dark:text-rose-400">
            <AlertCircle size={16} />
            {error}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
