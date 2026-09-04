import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Database, FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import {
  diagnoseMatchEngine,
  fetchMatchEngineShadowStats,
  triggerMatchEngineBackfill,
  type MatchDiagnoseResult,
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

function DiagnosePanel() {
  const [jobId, setJobId] = useState('');
  const [userId, setUserId] = useState('');
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MatchDiagnoseResult | null>(null);

  const run = async () => {
    if (!jobId.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await diagnoseMatchEngine({
        job_id: jobId.trim(),
        user_id: userId.trim() || undefined,
        persist,
        include_logs: true,
        encode_if_missing: true,
      });
      setResult(data);
    } catch {
      setError('Diagnose failed. Check job id / auth and try again.');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const vr = result?.vector_result;
  const explain = (vr?.explain || {}) as Record<string, unknown>;
  const cosines = (explain.cosines || {}) as Record<string, number | null>;
  const contributions = (explain.dimension_contributions || {}) as Record<
    string,
    { score?: number; weight?: number; weighted?: number }
  >;
  const skills = (explain.skills || {}) as {
    matched?: string[];
    missing_required?: string[];
    job_skills?: Record<string, string>;
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-500/30 dark:bg-[#0b1220]/60">
      <div className="flex items-center gap-2">
        <FlaskConical size={16} className="text-indigo-600 dark:text-indigo-300" />
        <h4 className="text-sm font-bold text-slate-900 dark:text-white">
          Test specific job match
        </h4>
      </div>
      <p className="text-xs text-slate-500 dark:text-[#94a3b8]">
        Runs a timed vector score with full reasoning (cosines, skill overlap, weighted
        contributions) and recent job logs. Does not change saved scores unless Persist is checked.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-600 dark:text-[#94a3b8]">
          Job ID
          <input
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            placeholder="uuid from jobs table"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white"
          />
        </label>
        <label className="block text-xs font-semibold text-slate-600 dark:text-[#94a3b8]">
          User ID (optional — defaults to you)
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="leave blank for current admin"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-[#e2e8f0]">
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            className="rounded border-slate-300"
          />
          Persist analysis (save match score)
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !jobId.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
          Run diagnose
        </button>
        {error ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-rose-700 dark:text-rose-400">
            <AlertCircle size={14} /> {error}
          </span>
        ) : null}
      </div>

      {result ? (
        <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-500/30">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="OK" value={result.ok ? 'yes' : 'no'} />
            <Stat
              label="Score"
              value={vr?.overall_score != null ? String(vr.overall_score) : '—'}
            />
            <Stat label="Total time" value={`${result.timing?.total_ms ?? '—'} ms`} />
            <Stat label="Engine setting" value={result.match_engine_setting || '—'} />
          </div>

          {(result.errors?.length || result.warnings?.length) ? (
            <div className="space-y-1 text-xs">
              {result.errors?.map((e) => (
                <p key={e} className="font-medium text-rose-700 dark:text-rose-300">
                  Error: {e}
                </p>
              ))}
              {result.warnings?.map((w) => (
                <p key={w} className="font-medium text-amber-700 dark:text-amber-300">
                  Warning: {w}
                </p>
              ))}
            </div>
          ) : null}

          {result.timing?.steps?.length ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                Step timings
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-500/30">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 dark:bg-[#0b1220] dark:text-[#94a3b8]">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Step</th>
                      <th className="px-2 py-1.5 font-semibold">ms</th>
                      <th className="px-2 py-1.5 font-semibold">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.timing.steps.map((s) => (
                      <tr
                        key={`${s.step}-${s.duration_ms}`}
                        className="border-t border-slate-100 dark:border-slate-500/20"
                      >
                        <td className="px-2 py-1.5 font-mono text-slate-800 dark:text-[#e2e8f0]">
                          {s.step}
                        </td>
                        <td className="px-2 py-1.5 tabular-nums text-slate-700 dark:text-[#cbd5e1]">
                          {s.duration_ms}
                        </td>
                        <td className="max-w-md truncate px-2 py-1.5 font-mono text-slate-500 dark:text-[#94a3b8]">
                          {s.detail ? JSON.stringify(s.detail) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {vr ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                  Reasoning
                </p>
                <p className="text-sm text-slate-800 dark:text-[#e2e8f0]">{vr.summary || '—'}</p>
                {vr.strengths?.length ? (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-emerald-800 dark:text-emerald-300">
                    {vr.strengths.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                ) : null}
                {vr.gaps?.length ? (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-amber-800 dark:text-amber-300">
                    {vr.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded-md border border-slate-200 px-1.5 py-0.5 dark:border-slate-500/40">
                    exp↔content: {cosines.experience_to_content ?? '—'}
                  </span>
                  <span className="rounded-md border border-slate-200 px-1.5 py-0.5 dark:border-slate-500/40">
                    title: {cosines.best_title ?? '—'}
                  </span>
                  <span className="rounded-md border border-slate-200 px-1.5 py-0.5 dark:border-slate-500/40">
                    prefs: {cosines.prefs_to_content ?? '—'}
                  </span>
                </div>
                {skills.matched?.length || skills.missing_required?.length ? (
                  <p className="mt-2 text-xs text-slate-600 dark:text-[#94a3b8]">
                    Matched: {(skills.matched || []).join(', ') || '—'}
                    <br />
                    Missing required: {(skills.missing_required || []).join(', ') || '—'}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                  Weighted dimensions
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-500/30">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-600 dark:bg-[#0b1220] dark:text-[#94a3b8]">
                      <tr>
                        <th className="px-2 py-1.5 font-semibold">Dimension</th>
                        <th className="px-2 py-1.5 font-semibold">Score</th>
                        <th className="px-2 py-1.5 font-semibold">Weight</th>
                        <th className="px-2 py-1.5 font-semibold">Points</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(contributions).map(([key, c]) => (
                        <tr
                          key={key}
                          className="border-t border-slate-100 dark:border-slate-500/20"
                        >
                          <td className="px-2 py-1.5 font-mono">{key}</td>
                          <td className="px-2 py-1.5 tabular-nums">{c.score ?? '—'}</td>
                          <td className="px-2 py-1.5 tabular-nums">{c.weight ?? '—'}</td>
                          <td className="px-2 py-1.5 tabular-nums">{c.weighted ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}

          {result.recent_logs?.length ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                Recent job logs ({result.recent_logs.length})
              </p>
              <div className="max-h-48 overflow-auto rounded-lg border border-slate-200 dark:border-slate-500/30">
                <table className="min-w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 text-slate-600 dark:bg-[#0b1220] dark:text-[#94a3b8]">
                    <tr>
                      <th className="px-2 py-1 font-semibold">When</th>
                      <th className="px-2 py-1 font-semibold">Event</th>
                      <th className="px-2 py-1 font-semibold">ms</th>
                      <th className="px-2 py-1 font-semibold">Service</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.recent_logs.map((log, idx) => (
                      <tr
                        key={`${log.event}-${idx}`}
                        className="border-t border-slate-100 dark:border-slate-500/20"
                      >
                        <td className="whitespace-nowrap px-2 py-1 text-slate-500">
                          {log.created_at || '—'}
                        </td>
                        <td className="px-2 py-1 font-mono text-slate-800 dark:text-[#e2e8f0]">
                          {log.event}
                        </td>
                        <td className="px-2 py-1 tabular-nums">{log.duration_ms ?? '—'}</td>
                        <td className="px-2 py-1">{log.service}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <details className="text-xs">
            <summary className="cursor-pointer font-semibold text-slate-600 dark:text-[#94a3b8]">
              Raw diagnose JSON
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-950 p-2 text-[10px] text-slate-100">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
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

      <DiagnosePanel />
    </div>
  );
}
