import { lazy, Suspense, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { runLlmBenchmark } from '@/api/adminApi';
import type { LlmBenchmarkResult, LlmProvider, SystemSettingsResponse } from '@/types/admin';
import { ConfirmDialog, OptionSelect } from './fields';
import type { ModelCatalog } from './queries';
import { errDetail, FAMILY_LABEL, modelFamily, PROVIDERS, savedString, settingsByKey } from './settingsModel';

const BenchmarkChart = lazy(() => import('./BenchmarkChart'));

const MAX_MODELS = 40;
const RUN_OPTIONS = [1, 2, 3, 5, 8, 10].map((n) => ({ value: String(n), label: String(n) }));
const CONCURRENCY_OPTIONS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }));
const PROVIDER_FILTERS = [{ value: 'all', label: 'All providers' }, ...PROVIDERS.map((p) => ({ value: p.id, label: p.label }))];
const TH = 'sticky top-0 bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground';

const seriesKey = (provider: string, model: string) => `${provider}::${model}`;
const colorAt = (i: number) => `var(--chart-${(i % 5) + 1})`;

export function BenchmarkTab({ settings, catalog }: { settings: SystemSettingsResponse; catalog: ModelCatalog }) {
  const models = PROVIDERS.flatMap((p) => catalog.modelsForProvider(p.id).map((m) => ({ id: m.id, provider: p.id as LlmProvider })));
  const loading = PROVIDERS.some((p) => catalog.providerLoading(p.id));
  const items = settingsByKey(settings);
  const defaultIds = PROVIDERS.map((p) => savedString(items.get(p.modelKey))).filter(Boolean);

  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [runs, setRuns] = useState(3);
  const [concurrency, setConcurrency] = useState(1);
  const [history, setHistory] = useState<LlmBenchmarkResult[][]>([]);
  const [latest, setLatest] = useState<LlmBenchmarkResult[]>([]);
  const [confirm, setConfirm] = useState(false);

  if (!seeded && models.length > 0) {
    setSeeded(true);
    const seed = models.filter((m) => defaultIds.includes(m.id)).map((m) => seriesKey(m.provider, m.id));
    if (seed.length && selected.size === 0) setSelected(new Set(seed));
  }

  const shown = (filter === 'all' ? models : models.filter((m) => m.provider === filter)).sort((a, b) => a.id.localeCompare(b.id));
  const targets = models.filter((m) => selected.has(seriesKey(m.provider, m.id)));

  const bench = useMutation({
    mutationFn: () =>
      runLlmBenchmark({
        models: targets.map((m) => ({ provider: m.provider, model: m.id, provider_key_id: null })),
        runs,
        concurrency,
      }),
    onMutate: () => setLatest([]),
    onSuccess: (res) => {
      // Results come back as runs × models in order.
      const perRound = Math.max(1, targets.length);
      const rounds: LlmBenchmarkResult[][] = [];
      for (let i = 0; i < res.results.length; i += perRound) rounds.push(res.results.slice(i, i + perRound));
      setHistory((h) => [...h, ...rounds]);
      setLatest(res.results);
      const msg = `Benchmark finished · ${res.summary.ok} ok / ${res.summary.failed} failed across ${res.summary.runs} run(s)`;
      if (res.summary.failed) toast.warning(msg);
      else toast.success(msg);
    },
    onError: (err) => toast.error(errDetail(err, 'Benchmark failed')),
  });

  const seriesOrder: string[] = [];
  for (const round of history) for (const r of round) {
    const key = seriesKey(r.provider, r.model);
    if (!seriesOrder.includes(key)) seriesOrder.push(key);
  }
  const series = seriesOrder.map((key, i) => ({ key, label: key.split('::')[1], color: colorAt(i) }));
  const chartData = history.map((round, idx) => {
    const row: Record<string, unknown> = { run: String(idx + 1) };
    for (const r of round) row[seriesKey(r.provider, r.model)] = r.ok && typeof r.latency_ms === 'number' ? r.latency_ms : null;
    return row;
  });
  const summary = seriesOrder
    .map((key) => {
      const samples: number[] = [];
      let errors = 0;
      for (const round of history) for (const r of round) {
        if (seriesKey(r.provider, r.model) !== key) continue;
        if (r.ok && typeof r.latency_ms === 'number') samples.push(r.latency_ms);
        else errors += 1;
      }
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
      return { key, model: key.split('::')[1], avg, best: samples.length ? Math.min(...samples) : null, errors };
    })
    .sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity) || a.model.localeCompare(b.model));
  const failures = latest.filter((r) => !r.ok);

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const tooMany = targets.length > MAX_MODELS;
  const calls = targets.length * runs;

  return (
    <SectionCard
      title="LLM response time benchmark"
      description="Time a tiny completion across catalogue models. Retired Gemini ids (1.5 / 2.0) are hidden."
      actions={
        <>
          <Button variant="outline" size="sm" disabled={bench.isPending || history.length === 0} onClick={() => { setHistory([]); setLatest([]); }}>
            <Trash2 />
            Clear results
          </Button>
          <Button size="sm" disabled={bench.isPending || targets.length === 0 || tooMany} onClick={() => setConfirm(true)}>
            {bench.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            {bench.isPending ? 'Running…' : 'Run benchmark'}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="bench-provider">Provider</FieldLabel>
              <OptionSelect id="bench-provider" value={filter} options={PROVIDER_FILTERS} onChange={setFilter} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bench-runs">Runs per model</FieldLabel>
              <OptionSelect id="bench-runs" value={String(runs)} options={RUN_OPTIONS} disabled={bench.isPending} onChange={(v) => setRuns(Number(v))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bench-concurrency">Concurrency</FieldLabel>
              <OptionSelect
                id="bench-concurrency"
                value={String(concurrency)}
                options={CONCURRENCY_OPTIONS}
                disabled={bench.isPending}
                onChange={(v) => setConcurrency(Number(v))}
              />
            </Field>
          </div>

          <div className="rounded-lg border">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <p className="text-xs text-muted-foreground tabular-nums">
                {loading && models.length === 0 ? 'Loading catalogue…' : `${targets.length} selected · ${shown.length} shown`}
              </p>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={bench.isPending || shown.length === 0}
                  onClick={() => setSelected((prev) => new Set([...prev, ...shown.map((m) => seriesKey(m.provider, m.id))]))}
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={bench.isPending}
                  onClick={() =>
                    setSelected((prev) => new Set([...prev].filter((k) => !shown.some((m) => seriesKey(m.provider, m.id) === k))))
                  }
                >
                  Clear
                </Button>
              </div>
            </div>
            <ul className="max-h-72 overflow-y-auto p-1" aria-label="Benchmark models">
              {shown.length === 0 ? (
                <li className="py-6 text-center text-sm text-muted-foreground">
                  {loading ? 'Discovering models…' : 'No chat models in the catalogue yet.'}
                </li>
              ) : (
                shown.map((m) => {
                  const key = seriesKey(m.provider, m.id);
                  const id = `bench-${key.replace(/[^a-z0-9]/gi, '-')}`;
                  return (
                    <li key={key}>
                      <label htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                        <Checkbox id={id} checked={selected.has(key)} disabled={bench.isPending} onCheckedChange={(v) => toggle(key, Boolean(v))} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{FAMILY_LABEL[modelFamily(m.id)]}</span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
          {tooMany ? <p className="text-sm text-destructive">Select at most {MAX_MODELS} models per run.</p> : null}

          <div aria-live="polite" className="space-y-2">
            {bench.isPending ? (
              <p role="status" className="flex items-center gap-2 rounded-lg border bg-brand-soft px-3 py-2 text-sm">
                <Loader2 className="size-3.5 animate-spin text-brand" aria-hidden />
                Calling providers ({calls.toLocaleString()} calls). This can take a few minutes; you can keep using the page.
              </p>
            ) : null}
            {failures.length ? (
              <Alert variant="destructive">
                <AlertTitle>Model failures</AlertTitle>
                <AlertDescription>
                  <ul className="max-h-36 space-y-1 overflow-y-auto">
                    {failures.map((r) => (
                      <li key={`${r.provider}:${r.model}:${r.ran_at}`}>
                        <span className="font-medium">{r.model}</span>: {r.error || 'failed'}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs text-muted-foreground">Latency (ms) by run</p>
            {history.length === 0 ? (
              <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
                Run a benchmark to populate the chart
              </div>
            ) : (
              <Suspense fallback={<Skeleton className="h-60 w-full" />}>
                <BenchmarkChart data={chartData} series={series} />
              </Suspense>
            )}
          </div>
          {summary.length ? (
            <div className="max-h-80 overflow-auto rounded-lg border">
              <table className="w-full text-sm" aria-label="Benchmark summary">
                <thead>
                  <tr>
                    <th className={TH}>Model</th>
                    <th className={`${TH} text-right`}>Avg ms</th>
                    <th className={`${TH} text-right`}>Best ms</th>
                    <th className={`${TH} text-right`}>Fails</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {summary.map((row) => (
                    <tr key={row.key}>
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                          <span
                            className="size-2 rounded-full"
                            style={{ background: series.find((s) => s.key === row.key)?.color }}
                            aria-hidden
                          />
                          {row.model}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{row.avg != null ? Math.round(row.avg) : '-'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{row.best != null ? Math.round(row.best) : '-'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{row.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run the benchmark?"
        description={`Makes ${calls.toLocaleString()} billed provider call${calls === 1 ? '' : 's'} (${targets.length} model${
          targets.length === 1 ? '' : 's'
        } × ${runs} run${runs === 1 ? '' : 's'}, concurrency ${concurrency}). Large selections can take several minutes.`}
        confirmLabel="Run benchmark"
        onConfirm={() => bench.mutate()}
      />
    </SectionCard>
  );
}
