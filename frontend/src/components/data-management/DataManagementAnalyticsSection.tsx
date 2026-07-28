import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import {
  fetchAnalysisPlatforms,
  fetchAnalysisUsers,
  fetchAppliedVsPostedSeries,
  fetchDataManagementMonths,
  fetchPlatformVsAppliedSeries,
  fetchRemoteVsPostedSeries,
  fetchUserActivitySeries,
  getClientTimezone,
} from '../../api/dataManagementApi';
import type {
  AnalysisUser,
  AppliedVsPostedSeries,
  DataManagementMonth,
  MultiSeriesResult,
  RemoteVsPostedSeries,
  UserActivityMetric,
} from '../../types/dataManagement';
import { BrandedLoader } from '../layout/BrandedLoader';
import { DualLineChart } from './DualLineChart';
import { MultiLineChart, seriesColorAt } from './MultiLineChart';

/** Keep in sync with backend UserActivitySeriesRequest.user_ids max_length. */
const MAX_ACTIVITY_USERS = 25;

const ACTIVITY_METRICS: Array<{ id: UserActivityMetric; label: string }> = [
  { id: 'jobs_added', label: 'Jobs added' },
  { id: 'applied', label: 'Applied' },
  { id: 'sheet_posted', label: 'Sheet posted' },
  { id: 'pumble_posted', label: 'Pumble posted' },
];

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => (typeof d === 'object' && d && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d))).join('; ');
    }
  }
  return fallback;
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

export function DataManagementAnalyticsSection() {
  const timezone = getClientTimezone();
  const [months, setMonths] = useState<DataManagementMonth[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [appliedSeries, setAppliedSeries] = useState<AppliedVsPostedSeries | null>(null);
  const [remoteSeries, setRemoteSeries] = useState<RemoteVsPostedSeries | null>(null);
  const [loadingMonths, setLoadingMonths] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [error, setError] = useState('');
  const [userActivityError, setUserActivityError] = useState('');
  const [platformError, setPlatformError] = useState('');

  const [users, setUsers] = useState<AnalysisUser[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [selectedMetrics, setSelectedMetrics] = useState<Set<UserActivityMetric>>(
    () => new Set(['jobs_added', 'applied']),
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
        // Default to a small set so the month chart loads (API caps user_ids).
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

  const loadOverview = useCallback(async (year: number, month: number) => {
    setLoadingOverview(true);
    setError('');
    try {
      const [applied, remote] = await Promise.all([
        fetchAppliedVsPostedSeries(year, month, timezone),
        fetchRemoteVsPostedSeries(year, month, timezone),
      ]);
      setAppliedSeries(applied);
      setRemoteSeries(remote);
    } catch (err: unknown) {
      setError(extractErrorMessage(err, 'Failed to load overview charts.'));
      setAppliedSeries(null);
      setRemoteSeries(null);
    } finally {
      setLoadingOverview(false);
    }
  }, [timezone]);

  const loadUserActivity = useCallback(async (year: number, month: number) => {
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
  }, [selectedMetrics, selectedUserIds, timezone]);

  const loadPlatformSeries = useCallback(async (year: number, month: number) => {
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
  }, [selectedPlatforms, timezone]);

  // Shared month drives all three chart groups.
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

  const toggleMetric = (id: UserActivityMetric) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">Analysis</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            All charts below use the same month period ({timezone}).
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

      {/* Overview dual charts */}
      <div className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">Your overview</h3>
          {selectedMonthLabel && (
            <span className="text-xs font-medium text-slate-500">{selectedMonthLabel}</span>
          )}
        </div>
        {loadingMonths || loadingOverview ? (
          <BrandedLoader compact label="Loading overview…" className="mt-4" />
        ) : (
          <div className="mt-3 grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-900">Applied vs added</h4>
                {appliedSeries && (
                  <p className="text-xs text-slate-500">
                    {appliedSeries.totals.applied_count} applied ·{' '}
                    {appliedSeries.totals.posted_count} added
                  </p>
                )}
              </div>
              {appliedSeries ? (
                <div className="min-w-0 overflow-x-auto">
                  <div className="min-w-[280px]">
                    <DualLineChart
                      data={appliedSeries.days as unknown as Array<Record<string, unknown>>}
                      xKey="date"
                      lineAKey="applied_count"
                      lineBKey="posted_count"
                      lineAName="Applied"
                      lineBName="Added to platform"
                      lineAColor="#2563eb"
                      lineBColor="#0f766e"
                    />
                  </div>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-slate-400">No data</p>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-900">Remote vs added</h4>
                {remoteSeries && (
                  <p className="text-xs text-slate-500">
                    {remoteSeries.totals.remote_count} remote ·{' '}
                    {remoteSeries.totals.posted_count} added
                  </p>
                )}
              </div>
              {remoteSeries ? (
                <div className="min-w-0 overflow-x-auto">
                  <div className="min-w-[280px]">
                    <DualLineChart
                      data={remoteSeries.days as unknown as Array<Record<string, unknown>>}
                      xKey="date"
                      lineAKey="remote_count"
                      lineBKey="posted_count"
                      lineAName="Remote"
                      lineBName="Added to platform"
                      lineAColor="#7c3aed"
                      lineBColor="#0f766e"
                    />
                  </div>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-slate-400">No data</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* User activity — same month */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">User activity</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Daily lines for the selected month. Choose users and metrics to compare.
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

      {/* Platform scrape vs applied — same month */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Platform scrape vs applied</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Daily jobs added from each scrape platform versus applied jobs for the selected
              month.
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
    </section>
  );
}
