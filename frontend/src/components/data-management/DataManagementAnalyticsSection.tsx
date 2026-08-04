import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import {
  fetchAnalysisPlatforms,
  fetchAnalysisUsers,
  fetchAppliedVsFetchedSeries,
  fetchDataManagementMonths,
  fetchDistributionSeries,
  fetchGrowthSeries,
  fetchPipelineSeries,
  fetchPlatformVsAppliedSeries,
  fetchRemoteVsFetchedSeries,
  fetchScrapeHealthSeries,
  fetchUserActivitySeries,
  getClientTimezone,
} from '../../api/dataManagementApi';
import type {
  AnalysisUser,
  AppliedVsFetchedSeries,
  DataManagementMonth,
  MultiSeriesResult,
  PipelineSeriesResult,
  RemoteVsFetchedSeries,
  UserActivityMetric,
} from '../../types/dataManagement';
import { BrandedLoader } from '../layout/BrandedLoader';
import { DualLineChart } from './DualLineChart';
import { MultiLineChart, seriesColorAt } from './MultiLineChart';

/** Keep in sync with backend UserActivitySeriesRequest.user_ids max_length. */
const MAX_ACTIVITY_USERS = 25;

const ACTIVITY_METRICS: Array<{ id: UserActivityMetric; label: string }> = [
  { id: 'board_added', label: 'Board added' },
  { id: 'applied', label: 'Applied' },
];

const PIPELINE_COLORS: Record<string, string> = {
  fetched_count: '#0f766e',
  jd_ready_count: '#2563eb',
  extraction_failed_count: '#be123c',
};

const DISTRIBUTION_COLORS: Record<string, string> = {
  sheet_posted_count: '#059669',
  pumble_posted_count: '#7c3aed',
};

const GROWTH_COLORS: Record<string, string> = {
  new_users_count: '#0369a1',
  team_applied_count: '#2563eb',
};

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (typeof d === 'object' && d && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join('; ');
    }
  }
  return fallback;
}

function fmt(n: number | undefined | null): string {
  return Number(n || 0).toLocaleString();
}

function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  emptyLabel = 'No options',
  maxSelect,
  helperText,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyLabel?: string;
  maxSelect?: number;
  helperText?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selectAllLimit = maxSelect ?? options.length;
  const allSelected =
    options.length > 0 &&
    selected.size > 0 &&
    options.slice(0, selectAllLimit).every((o) => selected.has(o.id)) &&
    selected.size === Math.min(options.length, selectAllLimit);

  const summary =
    selected.size === 0
      ? 'None selected'
      : selected.size === options.length
        ? `All (${options.length})`
        : `${selected.size} selected`;

  return (
    <div ref={rootRef} className="relative w-full min-w-0 sm:min-w-[220px]">
      <p className="mb-1 text-xs font-semibold text-slate-700">{label}</p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm font-medium text-slate-800 shadow-sm hover:border-slate-400"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-400" />
      </button>
      {helperText && <p className="mt-1 text-[11px] text-slate-500">{helperText}</p>}
      {open && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-400">{emptyLabel}</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => {
                    if (allSelected) onChange(new Set());
                    else onChange(new Set(options.slice(0, selectAllLimit).map((o) => o.id)));
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                />
                {maxSelect && options.length > maxSelect
                  ? `Select first ${maxSelect}`
                  : 'Select all'}
              </label>
              <div className="my-1 border-t border-slate-100" />
              {options.map((o) => {
                const checked = selected.has(o.id);
                const atCap = Boolean(maxSelect && !checked && selected.size >= maxSelect);
                return (
                  <label
                    key={o.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50 ${
                      atCap ? 'opacity-50' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={atCap}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(o.id)) next.delete(o.id);
                        else {
                          if (maxSelect && next.size >= maxSelect) return;
                          next.add(o.id);
                        }
                        onChange(next);
                      }}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                    />
                    <span className="min-w-0 break-words">{o.label}</span>
                  </label>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChartCard({
  title,
  summary,
  loading,
  empty,
  children,
}: {
  title: string;
  summary?: string;
  loading?: boolean;
  empty?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
        {summary ? <p className="text-xs text-slate-500">{summary}</p> : null}
      </div>
      {loading ? (
        <BrandedLoader compact label="Loading…" />
      ) : empty ? (
        <p className="py-12 text-center text-sm text-slate-400">{empty}</p>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <div className="min-w-[280px]">{children}</div>
        </div>
      )}
    </div>
  );
}

function KpiStrip({
  items,
}: {
  items: Array<{ label: string; value: string; hint?: string }>;
}) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5"
          title={item.hint}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {item.label}
          </p>
          <p className="mt-0.5 text-lg font-black tabular-nums text-slate-900">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

export function DataManagementAnalyticsSection() {
  const timezone = getClientTimezone();
  const [months, setMonths] = useState<DataManagementMonth[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [appliedSeries, setAppliedSeries] = useState<AppliedVsFetchedSeries | null>(null);
  const [remoteSeries, setRemoteSeries] = useState<RemoteVsFetchedSeries | null>(null);
  const [pipelineSeries, setPipelineSeries] = useState<PipelineSeriesResult | null>(null);
  const [distributionSeries, setDistributionSeries] = useState<MultiSeriesResult | null>(null);
  const [growthSeries, setGrowthSeries] = useState<MultiSeriesResult | null>(null);
  const [scrapeSeries, setScrapeSeries] = useState<MultiSeriesResult | null>(null);
  const [loadingMonths, setLoadingMonths] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [error, setError] = useState('');
  const [userActivityError, setUserActivityError] = useState('');
  const [platformError, setPlatformError] = useState('');

  const [users, setUsers] = useState<AnalysisUser[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [selectedMetrics, setSelectedMetrics] = useState<Set<UserActivityMetric>>(
    () => new Set(['board_added', 'applied']),
  );
  const [userActivity, setUserActivity] = useState<MultiSeriesResult | null>(null);
  const [loadingUserActivity, setLoadingUserActivity] = useState(false);

  const [platforms, setPlatforms] = useState<string[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [platformSeries, setPlatformSeries] = useState<MultiSeriesResult | null>(null);
  const [loadingPlatforms, setLoadingPlatforms] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingMonths(true);
    void Promise.all([
      fetchDataManagementMonths(timezone),
      fetchAnalysisUsers().catch(() => [] as AnalysisUser[]),
      fetchAnalysisPlatforms().catch(() => [] as string[]),
    ])
      .then(([monthRes, userList, platformList]) => {
        if (cancelled) return;
        setMonths(monthRes.months);
        if (monthRes.months.length > 0) {
          const first = monthRes.months[0];
          setSelectedKey(`${first.year}-${first.month}`);
        }
        setUsers(userList);
        if (userList.length > 0) {
          setSelectedUserIds(new Set(userList.slice(0, Math.min(5, MAX_ACTIVITY_USERS)).map((u) => u.id)));
        }
        setPlatforms(platformList);
        if (platformList.length > 0) {
          setSelectedPlatforms(new Set(platformList));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(extractErrorMessage(err, 'Failed to load analysis controls.'));
      })
      .finally(() => {
        if (!cancelled) setLoadingMonths(false);
      });
    return () => {
      cancelled = true;
    };
  }, [timezone]);

  const yearMonth = useMemo(() => {
    if (!selectedKey) return null;
    const [y, m] = selectedKey.split('-').map(Number);
    if (!y || !m) return null;
    return { year: y, month: m };
  }, [selectedKey]);

  const selectedMonthLabel = useMemo(() => {
    const hit = months.find((m) => `${m.year}-${m.month}` === selectedKey);
    return hit?.label ?? '';
  }, [months, selectedKey]);

  const loadOverview = useCallback(
    async (year: number, month: number) => {
      setLoadingOverview(true);
      setError('');
      try {
        const [applied, remote, pipeline, distribution, growth, scrape] = await Promise.all([
          fetchAppliedVsFetchedSeries(year, month, timezone),
          fetchRemoteVsFetchedSeries(year, month, timezone),
          fetchPipelineSeries(year, month, timezone),
          fetchDistributionSeries(year, month, timezone),
          fetchGrowthSeries(year, month, timezone),
          fetchScrapeHealthSeries(year, month, timezone),
        ]);
        setAppliedSeries(applied);
        setRemoteSeries(remote);
        setPipelineSeries(pipeline);
        setDistributionSeries(distribution);
        setGrowthSeries(growth);
        setScrapeSeries(scrape);
      } catch (err: unknown) {
        setError(extractErrorMessage(err, 'Failed to load platform charts.'));
        setAppliedSeries(null);
        setRemoteSeries(null);
        setPipelineSeries(null);
        setDistributionSeries(null);
        setGrowthSeries(null);
        setScrapeSeries(null);
      } finally {
        setLoadingOverview(false);
      }
    },
    [timezone],
  );

  const loadUserActivity = useCallback(
    async (year: number, month: number) => {
      const ids = [...selectedUserIds].slice(0, MAX_ACTIVITY_USERS);
      const metrics = [...selectedMetrics];
      if (ids.length === 0 || metrics.length === 0) {
        setUserActivity(null);
        setUserActivityError(
          ids.length === 0
            ? 'Select at least one user for this month.'
            : 'Select at least one metric for this month.',
        );
        return;
      }
      setLoadingUserActivity(true);
      setUserActivityError('');
      try {
        const data = await fetchUserActivitySeries({
          year,
          month,
          timezone,
          user_ids: ids,
          metrics,
        });
        setUserActivity(data);
      } catch (err: unknown) {
        setUserActivityError(extractErrorMessage(err, 'Failed to load user activity for this month.'));
        setUserActivity(null);
      } finally {
        setLoadingUserActivity(false);
      }
    },
    [selectedMetrics, selectedUserIds, timezone],
  );

  const loadPlatformSeries = useCallback(
    async (year: number, month: number) => {
      setLoadingPlatforms(true);
      setPlatformError('');
      try {
        const data = await fetchPlatformVsAppliedSeries({
          year,
          month,
          timezone,
          platforms: selectedPlatforms.size > 0 ? [...selectedPlatforms] : null,
        });
        setPlatformSeries(data);
      } catch (err: unknown) {
        setPlatformError(extractErrorMessage(err, 'Failed to load platform series for this month.'));
        setPlatformSeries(null);
      } finally {
        setLoadingPlatforms(false);
      }
    },
    [selectedPlatforms, timezone],
  );

  useEffect(() => {
    if (!yearMonth) return;
    void loadOverview(yearMonth.year, yearMonth.month);
  }, [yearMonth, loadOverview]);

  useEffect(() => {
    if (!yearMonth) return;
    void loadUserActivity(yearMonth.year, yearMonth.month);
  }, [yearMonth, loadUserActivity]);

  useEffect(() => {
    if (!yearMonth) return;
    void loadPlatformSeries(yearMonth.year, yearMonth.month);
  }, [yearMonth, loadPlatformSeries]);

  const userOptions = users.map((u) => ({
    id: u.id,
    label: `${u.name} (${u.email})`,
  }));
  const platformOptions = platforms.map((p) => ({ id: p, label: p }));

  const userChartSeries = useMemo(() => {
    if (!userActivity) return [];
    return userActivity.series.map((s, i) => ({
      key: s.key,
      label: s.label,
      color: seriesColorAt(i),
    }));
  }, [userActivity]);

  const platformChartSeries = useMemo(() => {
    if (!platformSeries) return [];
    return platformSeries.series.map((s, i) => ({
      key: s.key,
      label: s.label,
      color: s.kind === 'applied' ? '#2563eb' : seriesColorAt(i + 2),
    }));
  }, [platformSeries]);

  const pipelineChartSeries = useMemo(() => {
    if (!pipelineSeries) return [];
    return pipelineSeries.series.map((s) => ({
      key: s.key,
      label: s.label,
      color: PIPELINE_COLORS[s.key] || seriesColorAt(0),
    }));
  }, [pipelineSeries]);

  const distributionChartSeries = useMemo(() => {
    if (!distributionSeries) return [];
    return distributionSeries.series.map((s) => ({
      key: s.key,
      label: s.label,
      color: DISTRIBUTION_COLORS[s.key] || seriesColorAt(0),
    }));
  }, [distributionSeries]);

  const growthChartSeries = useMemo(() => {
    if (!growthSeries) return [];
    return growthSeries.series.map((s) => ({
      key: s.key,
      label: s.label,
      color: GROWTH_COLORS[s.key] || seriesColorAt(0),
    }));
  }, [growthSeries]);

  const scrapeChartSeries = useMemo(() => {
    if (!scrapeSeries) return [];
    // Prefer aggregate lines; spider lines follow with muted palette offset.
    return scrapeSeries.series.map((s, i) => ({
      key: s.key,
      label: s.label,
      color:
        s.key === 'items_new'
          ? '#0f766e'
          : s.key === 'errors'
            ? '#be123c'
            : seriesColorAt(i + 3),
    }));
  }, [scrapeSeries]);

  const toggleMetric = (id: UserActivityMetric) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const kpiItems = useMemo(() => {
    const p = pipelineSeries?.totals;
    const d = distributionSeries?.totals;
    const g = growthSeries?.totals;
    const s = scrapeSeries?.totals;
    return [
      {
        label: 'Fetched',
        value: fmt(p?.fetched_count),
        hint: 'Jobs created on the platform this month',
      },
      {
        label: 'JD ready',
        value: fmt(p?.jd_ready_count),
        hint: 'Extractions that reached completed this month',
      },
      {
        label: 'Ext. failed',
        value: fmt(p?.extraction_failed_count),
        hint: 'Extractions marked failed this month',
      },
      {
        label: 'Backlog now',
        value: fmt(p?.backlog_now),
        hint: 'Live unfinished JD pool (point-in-time)',
      },
      {
        label: 'Team applied',
        value: fmt(g?.team_applied_count ?? appliedSeries?.totals.applied_count),
        hint: 'Applications marked by all users this month',
      },
      {
        label: 'Scrape new',
        value: fmt(s?.items_new),
        hint: `Sheet ${fmt(d?.sheet_posted_count)} · Pumble ${fmt(d?.pumble_posted_count)} · Runs ${fmt(s?.runs)}`,
      },
    ];
  }, [appliedSeries, distributionSeries, growthSeries, pipelineSeries, scrapeSeries]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">Analysis</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Platform-wide metrics for {timezone}. Fetched means jobs created on Atomspace — not
            employer post date.
          </p>
        </div>
        <label className="flex w-full flex-col gap-1 text-xs font-semibold text-slate-700 sm:w-auto">
          Month period
          <select
            value={selectedKey}
            disabled={loadingMonths || months.length === 0}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 sm:min-w-[200px]"
          >
            {months.map((m) => (
              <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="mt-4 flex items-center gap-1.5 text-sm font-medium text-rose-700">
          <AlertCircle size={16} />
          {error}
        </p>
      )}

      {!loadingMonths && !loadingOverview && (pipelineSeries || growthSeries) ? (
        <KpiStrip items={kpiItems} />
      ) : null}

      {/* Platform overview */}
      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Platform overview</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Team applications and remote share against platform-wide fetches for the selected
              month.
            </p>
          </div>
          {selectedMonthLabel && (
            <span className="text-xs font-medium text-slate-500">{selectedMonthLabel}</span>
          )}
        </div>
        {loadingMonths || loadingOverview ? (
          <BrandedLoader compact label="Loading platform overview…" className="mt-4" />
        ) : (
          <div className="mt-3 grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="Team applied vs fetched"
              summary={
                appliedSeries
                  ? `${fmt(appliedSeries.totals.applied_count)} applied · ${fmt(appliedSeries.totals.fetched_count)} fetched`
                  : undefined
              }
              empty={appliedSeries ? null : 'No data'}
            >
              {appliedSeries ? (
                <DualLineChart
                  data={appliedSeries.days as unknown as Array<Record<string, unknown>>}
                  xKey="date"
                  lineAKey="applied_count"
                  lineBKey="fetched_count"
                  lineAName="Team applied"
                  lineBName="Fetched"
                  lineAColor="#2563eb"
                  lineBColor="#0f766e"
                />
              ) : null}
            </ChartCard>

            <ChartCard
              title="Remote vs fetched"
              summary={
                remoteSeries
                  ? `${fmt(remoteSeries.totals.remote_count)} remote · ${fmt(remoteSeries.totals.fetched_count)} fetched`
                  : undefined
              }
              empty={remoteSeries ? null : 'No data'}
            >
              {remoteSeries ? (
                <DualLineChart
                  data={remoteSeries.days as unknown as Array<Record<string, unknown>>}
                  xKey="date"
                  lineAKey="remote_count"
                  lineBKey="fetched_count"
                  lineAName="Remote"
                  lineBName="Fetched"
                  lineAColor="#7c3aed"
                  lineBColor="#0f766e"
                />
              ) : null}
            </ChartCard>
          </div>
        )}
      </div>

      {/* Pipeline + scrape */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Pipeline & scrape health</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Daily extraction outcomes and scrape_runs items/errors. Backlog is live (not
              historical).
            </p>
          </div>
          {selectedMonthLabel && (
            <span className="text-xs font-medium text-slate-500">{selectedMonthLabel}</span>
          )}
        </div>
        {loadingOverview ? (
          <BrandedLoader compact label="Loading pipeline…" className="mt-4" />
        ) : (
          <div className="mt-3 grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="Extraction pipeline"
              summary={
                pipelineSeries
                  ? `${fmt(pipelineSeries.totals.jd_ready_count)} ready · ${fmt(pipelineSeries.totals.extraction_failed_count)} failed · backlog ${fmt(pipelineSeries.totals.backlog_now)}`
                  : undefined
              }
              empty={pipelineChartSeries.length ? null : 'No extraction events this month'}
            >
              <MultiLineChart
                data={(pipelineSeries?.days ?? []) as Array<Record<string, unknown>>}
                xKey="date"
                series={pipelineChartSeries}
                height={280}
              />
            </ChartCard>

            <ChartCard
              title="Scrape health"
              summary={
                scrapeSeries
                  ? `${fmt(scrapeSeries.totals.items_new)} new · ${fmt(scrapeSeries.totals.errors)} errors · ${fmt(scrapeSeries.totals.runs)} runs`
                  : undefined
              }
              empty={scrapeChartSeries.length ? null : 'No scrape runs this month'}
            >
              <MultiLineChart
                data={(scrapeSeries?.days ?? []) as Array<Record<string, unknown>>}
                xKey="date"
                series={scrapeChartSeries}
                height={280}
              />
            </ChartCard>
          </div>
        )}
      </div>

      {/* Distribution + growth */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Distribution & growth</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              System-wide Sheet/Pumble posts, new user signups, and team applications.
            </p>
          </div>
          {selectedMonthLabel && (
            <span className="text-xs font-medium text-slate-500">{selectedMonthLabel}</span>
          )}
        </div>
        {loadingOverview ? (
          <BrandedLoader compact label="Loading distribution…" className="mt-4" />
        ) : (
          <div className="mt-3 grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="Sheet & Pumble"
              summary={
                distributionSeries
                  ? `${fmt(distributionSeries.totals.sheet_posted_count)} sheet · ${fmt(distributionSeries.totals.pumble_posted_count)} pumble`
                  : undefined
              }
              empty={distributionChartSeries.length ? null : 'No distribution events this month'}
            >
              <MultiLineChart
                data={(distributionSeries?.days ?? []) as Array<Record<string, unknown>>}
                xKey="date"
                series={distributionChartSeries}
                height={280}
              />
            </ChartCard>

            <ChartCard
              title="Users & applications"
              summary={
                growthSeries
                  ? `${fmt(growthSeries.totals.new_users_count)} new users · ${fmt(growthSeries.totals.team_applied_count)} applied`
                  : undefined
              }
              empty={growthChartSeries.length ? null : 'No growth events this month'}
            >
              <MultiLineChart
                data={(growthSeries?.days ?? []) as Array<Record<string, unknown>>}
                xKey="date"
                series={growthChartSeries}
                height={280}
              />
            </ChartCard>
          </div>
        )}
      </div>

      {/* Platform fetch vs applied */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Platform fetch vs applied</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Jobs fetched per scrape source versus applications across all users (same
              platform-wide scope on both axes).
            </p>
          </div>
          {selectedMonthLabel && (
            <span className="text-xs font-medium text-slate-500">{selectedMonthLabel}</span>
          )}
        </div>

        <div className="mt-4">
          <MultiSelectDropdown
            label="Platforms"
            options={platformOptions}
            selected={selectedPlatforms}
            onChange={setSelectedPlatforms}
            emptyLabel="No platforms found"
          />
        </div>

        {platformError && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-rose-700">
            <AlertCircle size={16} />
            {platformError}
          </p>
        )}

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
          {loadingPlatforms ? (
            <BrandedLoader
              compact
              label={`Loading ${selectedMonthLabel || 'month'} platform series…`}
            />
          ) : platformChartSeries.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-slate-400">
              {platformError || 'Select at least one platform for this month.'}
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <div className="min-w-[280px]">
                <MultiLineChart
                  data={(platformSeries?.days ?? []) as Array<Record<string, unknown>>}
                  xKey="date"
                  series={platformChartSeries}
                  height={320}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* User activity drill-down */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">User activity</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Per-user board adds (jobs that appeared on that user&apos;s board) and applications.
              Sheet/Pumble posts are system-wide — see Distribution above.
            </p>
          </div>
          {selectedMonthLabel && (
            <span className="text-xs font-medium text-slate-500">{selectedMonthLabel}</span>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
          <MultiSelectDropdown
            label="Users"
            options={userOptions}
            selected={selectedUserIds}
            onChange={setSelectedUserIds}
            emptyLabel="No users found"
            maxSelect={MAX_ACTIVITY_USERS}
            helperText={`Up to ${MAX_ACTIVITY_USERS} users per month chart`}
          />

          <div>
            <p className="mb-1 text-xs font-semibold text-slate-700">Metrics</p>
            <div className="flex flex-wrap gap-2">
              {ACTIVITY_METRICS.map((m) => {
                const on = selectedMetrics.has(m.id);
                return (
                  <label
                    key={m.id}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                      on
                        ? 'border-blue-300 bg-blue-50 text-blue-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleMetric(m.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                    />
                    {m.label}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {userActivityError && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-rose-700">
            <AlertCircle size={16} />
            {userActivityError}
          </p>
        )}

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
          {loadingUserActivity ? (
            <BrandedLoader
              compact
              label={`Loading ${selectedMonthLabel || 'month'} user activity…`}
            />
          ) : userChartSeries.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-slate-400">
              {userActivityError || 'Select users and metrics to display this month.'}
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <div className="min-w-[280px]">
                <MultiLineChart
                  data={(userActivity?.days ?? []) as Array<Record<string, unknown>>}
                  xKey="date"
                  series={userChartSeries}
                  height={320}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
