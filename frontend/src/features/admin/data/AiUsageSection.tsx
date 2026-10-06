import { useMemo, useState, type ReactNode } from 'react';
import { SectionCard } from '@/components/app/PageLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { AiUsageMeasure, AiUsageOverview, AiUsageUserRow } from '@/types/dataManagement';
import { BlockedChart, ChartBlock, InlineError, WIDE_CHART_HEIGHT } from './analyticsBlocks';
import {
  cycleSeries,
  DEFAULT_ACTIVITY_USERS,
  extractErrorMessage,
  fmt,
  fmtTokens,
  formatUsd,
  MAX_ACTIVITY_USERS,
  type ChartSeries,
} from './dataUtils';
import { MultiSelectPopover, type MultiOption } from './MultiSelectPopover';
import { useAiUsageOverview, useAiUsageSeries, useAnalysisUsers, useTailoringRunsSeries } from './queries';

type Period = { year: number; month: number; timezone: string };

const FEATURE_LABELS: Record<string, string> = {
  resume_tailoring: 'Resume tailoring',
  extension_autofill: 'Extension autofill',
  job_analysis: 'Job analysis',
  match_quality_check: 'Match quality check',
  agent: 'Assistant agent',
  assistant_chat: 'Assistant chat',
  resume_parse: 'Resume parse',
  generate_tailored_content: 'Resume tailoring',
};

export function featureLabel(feature: string): string {
  if (FEATURE_LABELS[feature]) return FEATURE_LABELS[feature];
  const words = feature.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Other';
}

const MEASURES: Array<{ id: AiUsageMeasure; label: string }> = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
];

const RUN_DASH = undefined;
const JOB_DASH = '5 4';

export function AiUsageSection({
  period,
  monthBadge,
  monthLabel,
}: {
  period: Period;
  monthBadge: ReactNode;
  monthLabel: string;
}) {
  const overview = useAiUsageOverview(period);
  const users = useAnalysisUsers();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [measure, setMeasure] = useState<AiUsageMeasure>('cost');

  const spenders = useMemo(
    () => (overview.data?.users ?? []).filter((u) => u.user_id !== 'system'),
    [overview.data],
  );
  const options = useMemo<MultiOption[]>(() => {
    const seen = new Set<string>();
    const out: MultiOption[] = [];
    for (const u of spenders) {
      seen.add(u.user_id);
      out.push({ id: u.user_id, label: u.email ? `${u.name} (${u.email})` : u.name });
    }
    for (const u of users.data ?? []) {
      if (!seen.has(u.id)) out.push({ id: u.id, label: `${u.name} (${u.email})` });
    }
    return out;
  }, [spenders, users.data]);

  const selected = picked ?? new Set(options.slice(0, DEFAULT_ACTIVITY_USERS).map((o) => o.id));
  const ids = [...selected].slice(0, MAX_ACTIVITY_USERS);
  const settled = !overview.isPending && !users.isPending;
  const usage = useAiUsageSeries(settled ? period : null, ids, measure);
  const tailoring = useTailoringRunsSeries(settled ? period : null, ids);

  const userPicker = (
    <MultiSelectPopover
      label="Users"
      options={options}
      selected={selected}
      onChange={setPicked}
      emptyLabel="No users found"
      maxSelect={MAX_ACTIVITY_USERS}
      helperText="Top spenders this month are selected first"
      disabled={!settled}
    />
  );

  if (overview.isError) {
    return (
      <SectionCard title="AI usage and cost" actions={monthBadge}>
        <InlineError
          message={extractErrorMessage(overview.error, 'Failed to load AI usage.')}
          onRetry={() => void overview.refetch()}
        />
      </SectionCard>
    );
  }

  const tailoringSeries = buildTailoringSeries(tailoring.data?.series);
  const featureSeries: ChartSeries[] = (overview.data?.series ?? []).map((s, i) => ({
    key: s.key,
    label: featureLabel(s.feature ?? s.label),
    ...cycleSeries(i),
  }));
  const usageTotal = Object.values(usage.data?.totals ?? {}).reduce((a, b) => a + b, 0);
  const blocked = settled && ids.length === 0 ? 'Select at least one user for this month.' : null;

  return (
    <>
      <SectionCard
        title="AI usage and cost"
        description="Every AI call NAO made this month, priced at list rates for the model that answered. Streamed assistant replies are estimated."
        actions={monthBadge}
      >
        <UsageKpis data={overview.data} loading={overview.isPending} />

        <div className="mt-6 mb-4 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          {userPicker}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium" id="ai-usage-measure">
              Show
            </span>
            <div role="group" aria-labelledby="ai-usage-measure" className="inline-flex rounded-lg border bg-muted/60 p-0.5">
              {MEASURES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={measure === m.id}
                  onClick={() => setMeasure(m.id)}
                  className={cn(
                    'h-7 rounded-md px-3 text-sm transition-colors',
                    measure === m.id
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {blocked ? (
          <BlockedChart message={blocked} />
        ) : (
          <ChartBlock
            title={measure === 'cost' ? 'Daily AI cost per user' : 'Daily AI tokens per user'}
            summary={
              usage.data
                ? measure === 'cost'
                  ? `${formatUsd(usageTotal)} for the selected users`
                  : `${fmtTokens(usageTotal)} tokens for the selected users`
                : undefined
            }
            query={{ ...usage, isPending: !settled || usage.isPending }}
            data={usage.data?.days}
            series={(usage.data?.series ?? []).map((s, i) => ({ key: s.key, label: s.label, ...cycleSeries(i) }))}
            height={WIDE_CHART_HEIGHT}
            format={measure === 'cost' ? 'usd' : 'number'}
            emptyText="No AI usage for the selected users this month."
            errorFallback="Failed to load AI usage per user."
          />
        )}

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ChartBlock
            title="Daily AI cost by feature"
            summary={overview.data ? `${formatUsd(overview.data.totals.cost_usd)} this month` : undefined}
            query={overview}
            data={overview.data?.days}
            series={featureSeries}
            format="usd"
            emptyText="No AI usage this month."
          />
          <FeatureBreakdown data={overview.data} loading={overview.isPending} />
        </div>
      </SectionCard>

      <SectionCard
        title="Tailoring runs vs jobs"
        description="Solid lines count tailoring runs (resume and cover letter written by AI); dashed lines count the distinct jobs they covered. A gap between them means the same job was tailored again."
        actions={monthBadge}
      >
        <div className="mb-4">{userPicker}</div>
        {blocked ? (
          <BlockedChart message={blocked} />
        ) : (
          <ChartBlock
            title={`${monthLabel || 'Month'} tailoring runs vs jobs`}
            hideTitle
            query={{ ...tailoring, isPending: !settled || tailoring.isPending }}
            data={tailoring.data?.days}
            series={tailoringSeries}
            height={WIDE_CHART_HEIGHT}
            emptyText="No tailoring runs for the selected users this month."
            errorFallback="Failed to load tailoring runs."
          />
        )}
      </SectionCard>

      <SectionCard
        title="AI usage per user"
        description="Month totals per account, highest cost first. Reruns are tailoring runs beyond one per job."
        actions={monthBadge}
      >
        <UsageTable rows={overview.data?.users} loading={overview.isPending} />
      </SectionCard>
    </>
  );
}

function buildTailoringSeries(meta: Array<{ key: string; label: string; user_id?: string; metric?: string }> | undefined) {
  if (!meta) return [];
  const colorIndex = new Map<string, number>();
  return meta.map((s) => {
    const uid = s.user_id ?? s.key;
    if (!colorIndex.has(uid)) colorIndex.set(uid, colorIndex.size);
    const { color } = cycleSeries(colorIndex.get(uid)!);
    return { key: s.key, label: s.label, color, dash: s.metric === 'jobs' ? JOB_DASH : RUN_DASH };
  });
}

function UsageKpis({ data, loading }: { data: AiUsageOverview | undefined; loading: boolean }) {
  const t = data?.totals;
  const reruns = (data?.users ?? []).reduce((a, u) => a + u.reruns, 0);
  const runs = (data?.users ?? []).reduce((a, u) => a + u.tailor_runs, 0);
  const kpis = [
    {
      label: 'Estimated cost',
      value: t ? formatUsd(t.cost_usd) : '-',
      hint: t?.unpriced_calls ? `${fmt(t.unpriced_calls)} calls on unpriced models` : 'At list price per model',
    },
    {
      label: 'Tokens',
      value: t ? fmtTokens(t.total_tokens) : '-',
      hint: t ? `${fmtTokens(t.prompt_tokens)} in · ${fmtTokens(t.completion_tokens)} out` : '',
    },
    { label: 'AI calls', value: t ? fmt(t.calls) : '-', hint: t ? `${fmt(t.users)} users` : '' },
    {
      label: 'Tailoring runs',
      value: data ? fmt(runs) : '-',
      hint: data ? `${fmt(runs - reruns)} distinct jobs` : '',
    },
    {
      label: 'Reruns',
      value: data ? fmt(reruns) : '-',
      hint: runs ? `${Math.round((reruns / runs) * 100)}% of tailoring runs` : 'Same job tailored again',
      warn: reruns > 0,
    },
  ];
  return (
    <section aria-label="AI usage totals" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {kpis.map((k) => (
        <div
          key={k.label}
          className={cn(
            'min-w-0 rounded-xl border bg-card p-3.5',
            k.warn && 'border-status-preparing/50 bg-status-preparing/10',
          )}
        >
          <p className="truncate text-xs text-muted-foreground">{k.label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-16" />
          ) : (
            <p className="mt-1 text-2xl font-semibold tabular-nums">{k.value}</p>
          )}
          {!loading && k.hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{k.hint}</p> : null}
        </div>
      ))}
    </section>
  );
}

function FeatureBreakdown({ data, loading }: { data: AiUsageOverview | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-64 w-full rounded-lg" />;
  const features = data?.by_feature ?? [];
  const total = data?.totals.cost_usd || 0;
  return (
    <div className="min-w-0">
      <h3 className="mb-3 text-sm font-medium">Cost by feature</h3>
      {features.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI usage this month.</p>
      ) : (
        <ul className="space-y-3" aria-label="Cost by feature">
          {features.map((f, i) => {
            const share = total ? (f.cost_usd / total) * 100 : 0;
            return (
              <li key={f.feature}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate">{featureLabel(f.feature)}</span>
                  <span className="shrink-0 font-medium tabular-nums">{formatUsd(f.cost_usd)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(share, 1)}%`, background: cycleSeries(i).color }}
                  />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {fmtTokens(f.total_tokens)} tokens · {Math.round(share)}%
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status || status === 'approved') return null;
  return (
    <Badge variant={status === 'rejected' ? 'destructive' : 'outline'} className="capitalize">
      {status}
    </Badge>
  );
}

function UsageTable({ rows, loading }: { rows: AiUsageUserRow[] | undefined; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />;
  if (!rows?.length) return <BlockedChart message="No AI usage this month." />;
  const shown = expanded ? rows : rows.slice(0, 12);
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1040px] text-sm" aria-label="AI usage per user">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 text-right font-medium">Est. cost</th>
              <th className="px-3 py-2 text-right font-medium">Tokens</th>
              <th className="px-3 py-2 text-right font-medium">Calls</th>
              <th className="px-3 py-2 text-right font-medium">Tailoring runs</th>
              <th className="px-3 py-2 text-right font-medium">Distinct jobs</th>
              <th className="px-3 py-2 text-right font-medium">Reruns</th>
              <th className="px-3 py-2 text-right font-medium">Most runs on one job</th>
              <th className="px-3 py-2 text-right font-medium">Applied</th>
              <th className="px-3 py-2 text-right font-medium">Cost per application</th>
              <th className="px-3 py-2 font-medium">Top feature</th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {shown.map((u) => (
              <tr key={u.user_id} className="hover:bg-muted/30">
                <td className="max-w-64 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{u.name}</span>
                    <StatusBadge status={u.approval_status} />
                  </div>
                  {u.email ? <p className="truncate text-xs text-muted-foreground">{u.email}</p> : null}
                </td>
                <td className="px-3 py-2 text-right font-semibold">{formatUsd(u.cost_usd)}</td>
                <td className="px-3 py-2 text-right" title={`${fmt(u.prompt_tokens)} in · ${fmt(u.completion_tokens)} out`}>
                  {fmtTokens(u.total_tokens)}
                  <p className="text-xs whitespace-nowrap text-muted-foreground">
                    {fmtTokens(u.prompt_tokens)} in · {fmtTokens(u.completion_tokens)} out
                  </p>
                </td>
                <td className="px-3 py-2 text-right">{fmt(u.calls)}</td>
                <td className="px-3 py-2 text-right">{fmt(u.tailor_runs)}</td>
                <td className="px-3 py-2 text-right">{fmt(u.tailored_jobs)}</td>
                <td className="px-3 py-2 text-right">
                  {u.reruns > 0 ? (
                    <span className="inline-flex min-w-7 justify-center rounded-md bg-status-preparing/20 px-1.5 font-semibold text-amber-800 dark:text-amber-300">
                      {fmt(u.reruns)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">{u.max_runs_per_job > 1 ? `${u.max_runs_per_job}×` : fmt(u.max_runs_per_job)}</td>
                <td className="px-3 py-2 text-right">{fmt(u.applied)}</td>
                <td className="px-3 py-2 text-right">{u.cost_per_application != null ? formatUsd(u.cost_per_application) : '-'}</td>
                <td className="px-3 py-2 text-muted-foreground">{u.features[0] ? featureLabel(u.features[0].feature) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 12 ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${rows.length} users`}
        </Button>
      ) : null}
    </div>
  );
}
