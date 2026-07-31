import { useEffect, useMemo, useState } from 'react';
import { Activity, Loader2, Play, Square, Trash2 } from 'lucide-react';
import { SettingsCard } from './SettingsCard';
import { MenuSelect } from '../shared/MenuSelect';
import { LlmModelGlyph, llmModelFamilyLabel } from '../shared/LlmModelIcon';
import {
  MultiLineChart,
  seriesColorAt,
} from '../data-management/MultiLineChart';
import { runLlmBenchmark } from '../../api/adminApi';
import type {
  LlmBenchmarkResult,
  LlmDiscoveredModel,
  LlmProvider,
} from '../../types/admin';

const FIELD_HINT = 'text-xs leading-snug text-slate-600 dark:text-[#94a3b8]';
const CONTROL =
  'h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white dark:focus:border-sky-400 dark:focus:ring-sky-900/40';
const SURFACE_CARD =
  'rounded-xl border border-slate-200/80 bg-slate-50/80 dark:border-white/10 dark:bg-[#0b1220]/60';

export type BenchmarkCatalogModel = LlmDiscoveredModel & {
  provider: LlmProvider;
};

type ProviderFilter = 'all' | LlmProvider;

interface LlmBenchmarkSectionProps {
  catalog: BenchmarkCatalogModel[];
  loading?: boolean;
  defaultModelIds?: string[];
}

function seriesKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function errDetail(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'response' in e) {
    const data = (e as { response?: { data?: { detail?: unknown } } }).response?.data;
    const detail = data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export function LlmBenchmarkSection({
  catalog,
  loading = false,
  defaultModelIds = [],
}: LlmBenchmarkSectionProps) {
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState(3);
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<LlmBenchmarkResult[][]>([]);
  const [latest, setLatest] = useState<LlmBenchmarkResult[]>([]);
  const [seededDefaults, setSeededDefaults] = useState(false);
  const [localStatus, setLocalStatus] = useState<{ type: 'ok' | 'err' | 'info'; text: string } | null>(
    null,
  );

  // Seed selection from system default models once the catalogue arrives.
  useEffect(() => {
    if (seededDefaults || catalog.length === 0 || defaultModelIds.length === 0) return;
    setSelected((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set<string>();
      for (const id of defaultModelIds) {
        const hit = catalog.find((m) => m.id === id);
        if (hit) next.add(seriesKey(hit.provider, hit.id));
      }
      return next.size > 0 ? next : prev;
    });
    setSeededDefaults(true);
  }, [catalog, defaultModelIds, seededDefaults]);

  const filteredCatalog = useMemo(() => {
    const list =
      providerFilter === 'all'
        ? catalog
        : catalog.filter((m) => m.provider === providerFilter);
    return [...list].sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog, providerFilter]);

  const selectedTargets = useMemo(() => {
    return filteredCatalog.filter((m) => selected.has(seriesKey(m.provider, m.id)));
  }, [filteredCatalog, selected]);

  const chartSeries = useMemo(() => {
    const keys = new Map<string, { key: string; label: string; color: string }>();
    let i = 0;
    for (const round of history) {
      for (const r of round) {
        const key = seriesKey(r.provider, r.model);
        if (!keys.has(key)) {
          keys.set(key, {
            key,
            label: r.model,
            color: seriesColorAt(i++),
          });
        }
      }
    }
    return [...keys.values()];
  }, [history]);

  const chartData = useMemo(() => {
    return history.map((round, idx) => {
      const row: Record<string, unknown> = { run: String(idx + 1) };
      for (const r of round) {
        const key = seriesKey(r.provider, r.model);
        row[key] = r.ok && typeof r.latency_ms === 'number' ? r.latency_ms : null;
      }
      return row;
    });
  }, [history]);

  const summaryRows = useMemo(() => {
    const byKey = new Map<
      string,
      { provider: string; model: string; samples: number[]; errors: number }
    >();
    for (const round of history) {
      for (const r of round) {
        const key = seriesKey(r.provider, r.model);
        let entry = byKey.get(key);
        if (!entry) {
          entry = { provider: r.provider, model: r.model, samples: [], errors: 0 };
          byKey.set(key, entry);
        }
        if (r.ok && typeof r.latency_ms === 'number') entry.samples.push(r.latency_ms);
        else entry.errors += 1;
      }
    }
    return [...byKey.values()]
      .map((e) => {
        const avg =
          e.samples.length > 0
            ? e.samples.reduce((a, b) => a + b, 0) / e.samples.length
            : null;
        const best = e.samples.length > 0 ? Math.min(...e.samples) : null;
        return { ...e, avg, best };
      })
      .sort((a, b) => {
        if (a.avg == null && b.avg == null) return a.model.localeCompare(b.model);
        if (a.avg == null) return 1;
        if (b.avg == null) return -1;
        return a.avg - b.avg;
      });
  }, [history]);

  const toggle = (provider: LlmProvider, modelId: string) => {
    const key = seriesKey(provider, modelId);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filteredCatalog) next.add(seriesKey(m.provider, m.id));
      return next;
    });
  };

  const clearFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filteredCatalog) next.delete(seriesKey(m.provider, m.id));
      return next;
    });
  };

  const runBenchmark = async () => {
    const targets = catalog.filter((m) => selected.has(seriesKey(m.provider, m.id)));
    if (!targets.length) {
      setLocalStatus({ type: 'err', text: 'Select at least one model to benchmark.' });
      return;
    }
    if (targets.length > 40) {
      setLocalStatus({ type: 'err', text: 'Select at most 40 models per run.' });
      return;
    }

    setBusy(true);
    setLatest([]);
    setLocalStatus({
      type: 'info',
      text: 'Calling providers — this can take a few minutes for large selections.',
    });
    try {
      const res = await runLlmBenchmark({
        models: targets.map((m) => ({
          provider: m.provider,
          model: m.id,
          provider_key_id: null,
        })),
        runs,
        concurrency,
      });

      // Group flat results into rounds (API returns runs × models in order).
      const perRound = targets.length;
      const rounds: LlmBenchmarkResult[][] = [];
      for (let i = 0; i < res.results.length; i += perRound) {
        rounds.push(res.results.slice(i, i + perRound));
      }
      setHistory((h) => [...h, ...rounds]);
      setLatest(res.results);
      const msg = `Benchmark finished · ${res.summary.ok} ok / ${res.summary.failed} failed across ${res.summary.runs} run(s)`;
      setLocalStatus({ type: res.summary.failed ? 'err' : 'ok', text: msg });
    } catch (e: unknown) {
      setLocalStatus({ type: 'err', text: errDetail(e, 'Benchmark failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      icon={Activity}
      iconClass="bg-gradient-to-br from-violet-500 to-fuchsia-600"
      title="LLM response time benchmark"
      description="Time a tiny completion across catalogue models. Retired Gemini ids (1.5 / 2.0) are hidden — gateways still list them but Google returns 404."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void runBenchmark()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {busy ? 'Running…' : 'Run benchmark'}
          </button>
          <button
            type="button"
            disabled={busy || history.length === 0}
            onClick={() => {
              setHistory([]);
              setLatest([]);
              setLocalStatus(null);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:bg-[#0b1220] dark:text-[#e2e8f0] dark:hover:bg-white/5"
          >
            <Trash2 size={13} />
            Clear chart
          </button>
        </div>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block min-w-0">
              <span className={`mb-1 block ${FIELD_HINT}`}>Provider</span>
              <MenuSelect
                aria-label="Benchmark provider filter"
                value={providerFilter}
                options={[
                  { value: 'all', label: 'All providers' },
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'gemini', label: 'Gemini' },
                ]}
                onChange={(v) => setProviderFilter(v as ProviderFilter)}
              />
            </label>
            <label className="block min-w-0">
              <span className={`mb-1 block ${FIELD_HINT}`}>Runs per model</span>
              <select
                className={CONTROL}
                value={runs}
                disabled={busy}
                onChange={(e) => setRuns(Number(e.target.value))}
              >
                {[1, 2, 3, 5, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={`mb-1 block ${FIELD_HINT}`}>Concurrency</span>
              <select
                className={CONTROL}
                value={concurrency}
                disabled={busy}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={`px-3 py-2.5 ${SURFACE_CARD}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className={FIELD_HINT}>
                {loading
                  ? 'Loading catalogue…'
                  : `${selectedTargets.length} selected · ${filteredCatalog.length} shown`}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-xs font-semibold text-violet-600 hover:underline dark:text-violet-300"
                  onClick={selectAllFiltered}
                  disabled={busy || filteredCatalog.length === 0}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-xs font-semibold text-slate-500 hover:underline dark:text-[#94a3b8]"
                  onClick={clearFiltered}
                  disabled={busy}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {filteredCatalog.length === 0 ? (
                <p className={`py-6 text-center text-sm ${FIELD_HINT}`}>
                  {loading ? 'Discovering models…' : 'No chat models in catalogue yet.'}
                </p>
              ) : (
                filteredCatalog.map((m) => {
                  const key = seriesKey(m.provider, m.id);
                  const checked = selected.has(key);
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/70 dark:hover:bg-white/5"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggle(m.provider, m.id)}
                      />
                      <LlmModelGlyph modelId={m.id} size={14} />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-white">
                        {m.id}
                      </span>
                      <span className={`shrink-0 ${FIELD_HINT}`}>
                        {llmModelFamilyLabel(m.id)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Status / warnings live below the model list — never inside the scroll area. */}
          <div className="space-y-2" aria-live="polite">
            {busy || localStatus ? (
              <div
                className={`rounded-xl border px-3 py-2.5 text-xs leading-snug ${
                  busy || localStatus?.type === 'info'
                    ? 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-950/40 dark:text-violet-200'
                    : localStatus?.type === 'ok'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200'
                }`}
              >
                <p className="flex items-start gap-2">
                  {busy ? (
                    <Square size={12} className="mt-0.5 shrink-0 animate-pulse" />
                  ) : null}
                  <span>
                    {busy
                      ? 'Calling providers — this can take a few minutes for large selections.'
                      : localStatus?.text}
                  </span>
                </p>
              </div>
            ) : null}

            {latest.some((r) => !r.ok) ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
                <p className="mb-1.5 font-semibold">Model failures</p>
                <div className="max-h-36 space-y-1 overflow-y-auto">
                  {latest
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <div key={`${r.provider}:${r.model}:${r.ran_at}`}>
                        <span className="font-semibold">{r.model}</span>: {r.error || 'failed'}
                      </div>
                    ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-3">
          <div className={`relative z-10 overflow-hidden px-3 py-2.5 ${SURFACE_CARD}`}>
            <p className={`mb-2 ${FIELD_HINT}`}>Latency (ms) by run</p>
            {history.length === 0 ? (
              <div className="flex h-[240px] items-center justify-center text-sm text-slate-400">
                Run a benchmark to populate the chart
              </div>
            ) : (
              <MultiLineChart
                data={chartData}
                xKey="run"
                series={chartSeries}
                height={240}
                formatXTick={(v) => `Run ${v}`}
                yAllowDecimals
              />
            )}
          </div>

          {summaryRows.length > 0 ? (
            <div className={`relative z-0 overflow-hidden ${SURFACE_CARD}`}>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200/80 bg-white/50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-[#94a3b8]">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Model</th>
                    <th className="px-3 py-2 font-semibold">Avg ms</th>
                    <th className="px-3 py-2 font-semibold">Best ms</th>
                    <th className="px-3 py-2 font-semibold">Fails</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((row) => {
                    const key = seriesKey(row.provider, row.model);
                    const color =
                      chartSeries.find((s) => s.key === key)?.color ?? seriesColorAt(0);
                    return (
                    <tr
                      key={key}
                      className="border-b border-slate-100 last:border-0 dark:border-white/5"
                    >
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5 text-slate-800 dark:text-white">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: color }}
                          />
                          {row.model}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-700 dark:text-[#e2e8f0]">
                        {row.avg != null ? Math.round(row.avg) : '—'}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-700 dark:text-[#e2e8f0]">
                        {row.best != null ? Math.round(row.best) : '—'}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-700 dark:text-[#e2e8f0]">
                        {row.errors}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </SettingsCard>
  );
}
