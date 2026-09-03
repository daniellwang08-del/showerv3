import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Database, Loader2, RefreshCw } from 'lucide-react';
import {
  fetchMatchEngineShadowStats,
  triggerMatchEngineBackfill,
  type MatchEngineShadowStats,
} from '../../api/adminApi';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-slate-500/30 dark:bg-[#0b1220]">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-bold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}

/** Backfill trigger + shadow-mode comparison stats for the vector match engine. */
export function MatchEngineOps() {
  const [stats, setStats] = useState<MatchEngineShadowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setStats(await fetchMatchEngineShadowStats());
    } catch {
      setError('Failed to load match engine stats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBackfill = async () => {
    if (backfilling) return;
    setBackfilling(true);
    setNotice('');
    setError('');
    try {
      const result = await triggerMatchEngineBackfill();
      setNotice(
        result.already_running
          ? 'A backfill is already running.'
          : 'Backfill started — jobs and profiles are being encoded in the background.',
      );
      window.setTimeout(() => void load(), 5000);
    } catch {
      setError('Failed to start the backfill. Check that Redis and the encoding worker are up.');
    } finally {
      setBackfilling(false);
    }
  };

  const histogram = stats
    ? Object.entries(stats.abs_delta_histogram).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleBackfill()}
          disabled={backfilling}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {backfilling ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Database size={14} />
          )}
          Backfill encodings
        </button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-500/40 dark:text-[#e2e8f0] dark:hover:bg-slate-500/10"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh stats
        </button>
        {notice ? (
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            {notice}
          </span>
        ) : null}
        {error ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-rose-700 dark:text-rose-400">
            <AlertCircle size={14} /> {error}
          </span>
        ) : null}
      </div>

      {stats ? (
        <>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Jobs encoded" value={stats.jobs_encoded.toLocaleString()} />
            <Stat label="Users encoded" value={stats.users_encoded.toLocaleString()} />
            <Stat
              label={`Comparisons (${stats.window_days}d)`}
              value={stats.comparisons.toLocaleString()}
            />
            <Stat
              label="Mean delta"
              value={stats.mean_delta != null ? String(stats.mean_delta) : '—'}
            />
            <Stat
              label="Mean abs. error"
              value={stats.mean_absolute_error != null ? String(stats.mean_absolute_error) : '—'}
            />
            <Stat
              label="Max abs. error"
              value={stats.max_absolute_error != null ? String(stats.max_absolute_error) : '—'}
            />
          </div>

          {stats.comparisons > 0 && histogram.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-semibold text-slate-600 dark:text-[#94a3b8]">
                |vector − LLM| distribution:
              </span>
              {histogram.map(([bucket, n]) => (
                <span
                  key={bucket}
                  className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-slate-700 dark:border-slate-500/30 dark:bg-[#0b1220] dark:text-[#e2e8f0]"
                >
                  {bucket}: {n}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-[#94a3b8]">
              No shadow comparisons yet. Set the engine to “shadow” and let analyses run; each one
              records an LLM-vs-vector score pair here.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
