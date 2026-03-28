import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CalendarRange,
  Check,
  ClipboardList,
  Loader2,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type { SubmittedUrlItem } from '../types/ui';
import { jobMarkedApplied } from '../utils/appliedStatus';
import { localCalendarDayKey, toFiniteTimeMs } from '../utils/serverDate';

export type PipelineRangePreset = '7d' | '14d' | '30d' | 'all';

type Props = {
  jobs: SubmittedUrlItem[];
  duplicateCount: number;
  loading?: boolean;
};

type PipelineStats = {
  total: number;
  applied: number;
  notApplied: number;
  applicationRate: number;
  extraction: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    unknown: number;
  };
  scrapedReady: number;
  matchScored: number;
  matchProcessing: number;
  matchAwaiting: number;
};

function isApplied(j: SubmittedUrlItem): boolean {
  return jobMarkedApplied(j);
}

function computeStats(jobs: SubmittedUrlItem[]): PipelineStats {
  const total = jobs.length;
  const applied = jobs.filter(isApplied).length;
  const notApplied = Math.max(0, total - applied);
  const applicationRate = total > 0 ? Math.round((applied / total) * 100) : 0;

  const extraction = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
  };
  for (const j of jobs) {
    const s = j.extraction_status;
    if (!s) extraction.unknown++;
    else if (s === 'pending') extraction.pending++;
    else if (s === 'processing') extraction.processing++;
    else if (s === 'completed') extraction.completed++;
    else if (s === 'failed') extraction.failed++;
  }

  const scrapedReady = jobs.filter(
    (j) => j.extraction_status === 'completed' || (j.scraped_at_ms != null && j.extraction_id),
  ).length;

  let matchScored = 0;
  let matchProcessing = 0;
  let matchAwaiting = 0;
  for (const j of jobs) {
    const extracted =
      j.extraction_status === 'completed' || (j.scraped_at_ms != null && Boolean(j.extraction_id));
    if (!extracted) continue;
    if (j.match_overall_score != null) matchScored++;
    else if (j.match_status === 'processing') matchProcessing++;
    else matchAwaiting++;
  }

  return {
    total,
    applied,
    notApplied,
    applicationRate,
    extraction,
    scrapedReady,
    matchScored,
    matchProcessing,
    matchAwaiting,
  };
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

/** Jobs added today (local) vs how many of that cohort are now applied. */
function computeTodayCohort(jobs: SubmittedUrlItem[]): {
  postedToday: number;
  appliedToday: number;
  rateToday: number;
} {
  const tk = localCalendarDayKey(Date.now());
  let postedToday = 0;
  let appliedToday = 0;
  for (const j of jobs) {
    const ms = toFiniteTimeMs(j.created_at_ms as unknown);
    if (ms == null) continue;
    if (localCalendarDayKey(ms) !== tk) continue;
    postedToday++;
    if (jobMarkedApplied(j)) appliedToday++;
  }
  const rateToday = postedToday > 0 ? Math.round((appliedToday / postedToday) * 100) : 0;
  return { postedToday, appliedToday, rateToday };
}

function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Last `n` local calendar days ending today (n ≥ 1). */
function getLastNLocalDayStarts(n: number): number[] {
  const starts: number[] = [];
  const count = Math.max(1, Math.floor(n));
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    starts.push(d.getTime());
  }
  return starts;
}

/** Every local calendar day from `firstDayMs` through `lastDayMs` inclusive (caps at a large max). */
const MAX_HISTORY_DAYS = 5000;

function getLocalDayStartsInclusiveRange(firstDayMs: number, lastDayMs: number): number[] {
  const starts: number[] = [];
  let cur = startOfLocalDayMs(firstDayMs);
  const end = startOfLocalDayMs(lastDayMs);
  if (cur > end) {
    return [end];
  }
  let guard = 0;
  while (cur <= end && guard < MAX_HISTORY_DAYS) {
    starts.push(cur);
    const d = new Date(cur);
    d.setDate(d.getDate() + 1);
    cur = d.getTime();
    guard++;
  }
  return starts;
}

type WeekDayBucket = {
  /** Midnight local time for this bucket */
  dayStart: number;
  /** Short label for axis */
  label: string;
  /** Jobs added to To do on this calendar day */
  posted: number;
  /** Of those jobs, how many are currently marked applied (pipeline progress; apply date ignored) */
  applied: number;
};

type WeekSeries = {
  days: WeekDayBucket[];
  maxCount: number;
  /** Sum of posted counts shown in the chart (window or all jobs). */
  sumPostedWeek: number;
  /** Sum of applied cohort counts aligned with those buckets. */
  sumAppliedWeek: number;
  preset: PipelineRangePreset;
  /** All-time range exceeded cap; chart shows the most recent days only. */
  historyTruncated?: boolean;
};

/**
 * Cohort / pipeline by **day added**.
 * For each calendar day in the window: posted = jobs added that day; applied = those jobs now marked applied.
 */
function fillPipelineBuckets(jobs: SubmittedUrlItem[], dayStarts: number[], preset: PipelineRangePreset): WeekSeries {
  const bucketKeys = dayStarts.map((t) => localCalendarDayKey(t));
  const keySet = new Set(bucketKeys.filter(Boolean));
  const posted = new Map<string, number>();
  const applied = new Map<string, number>();
  for (const k of bucketKeys) {
    if (k) {
      posted.set(k, 0);
      applied.set(k, 0);
    }
  }

  for (const j of jobs) {
    const ms = toFiniteTimeMs(j.created_at_ms as unknown);
    if (ms == null) continue;
    const k = localCalendarDayKey(ms);
    if (!k || !keySet.has(k)) continue;
    posted.set(k, (posted.get(k) ?? 0) + 1);
    if (jobMarkedApplied(j)) {
      applied.set(k, (applied.get(k) ?? 0) + 1);
    }
  }

  const n = dayStarts.length;
  const labelOptsShort = { weekday: 'short' as const, month: 'short' as const, day: 'numeric' as const };
  const labelOptsTiny = { month: 'numeric' as const, day: 'numeric' as const };
  const useTiny = n > 14;

  const days: WeekDayBucket[] = dayStarts.map((dayStart, idx) => {
    const d = new Date(dayStart);
    const label = d.toLocaleDateString(undefined, useTiny ? labelOptsTiny : labelOptsShort);
    const k = bucketKeys[idx];
    return {
      dayStart,
      label,
      posted: k ? posted.get(k) ?? 0 : 0,
      applied: k ? applied.get(k) ?? 0 : 0,
    };
  });

  let maxCount = 0;
  for (const b of days) {
    maxCount = Math.max(maxCount, b.posted, b.applied);
  }
  const sumPostedWeek = days.reduce((a, b) => a + b.posted, 0);
  const sumAppliedWeek = days.reduce((a, b) => a + b.applied, 0);

  return { days, maxCount, sumPostedWeek, sumAppliedWeek, preset };
}

function computePipelineSeries(jobs: SubmittedUrlItem[], preset: PipelineRangePreset): WeekSeries {
  const todayStart = startOfLocalDayMs(Date.now());

  if (preset === 'all') {
    let minMs: number | null = null;
    for (const j of jobs) {
      const ms = toFiniteTimeMs(j.created_at_ms as unknown);
      if (ms == null) continue;
      if (minMs == null || ms < minMs) minMs = ms;
    }
    const firstDay = minMs != null ? startOfLocalDayMs(minMs) : todayStart;
    const estSpanDays = Math.floor((todayStart - firstDay) / 86_400_000) + 1;
    let historyTruncated = false;
    let dayStarts: number[];
    if (estSpanDays > MAX_HISTORY_DAYS) {
      dayStarts = getLastNLocalDayStarts(MAX_HISTORY_DAYS);
      historyTruncated = true;
    } else {
      dayStarts = getLocalDayStartsInclusiveRange(firstDay, todayStart);
    }
    const base = fillPipelineBuckets(jobs, dayStarts, preset);
    return historyTruncated ? { ...base, historyTruncated: true } : base;
  }

  const n = preset === '7d' ? 7 : preset === '14d' ? 14 : 30;
  const dayStarts = getLastNLocalDayStarts(n);
  return fillPipelineBuckets(jobs, dayStarts, preset);
}

const RANGE_OPTIONS: { value: PipelineRangePreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '14d', label: 'Last 14 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time (first add → today)' },
];

export function DashboardPipelineStats({ jobs, duplicateCount, loading }: Props) {
  const [rangePreset, setRangePreset] = useState<PipelineRangePreset>('7d');
  const s = useMemo(() => computeStats(jobs), [jobs]);
  const pipelineSeries = useMemo(
    () => computePipelineSeries(jobs, rangePreset),
    [jobs, rangePreset],
  );
  const todayCohort = useMemo(() => computeTodayCohort(jobs), [jobs]);

  const todayBatteryPct = pct(todayCohort.appliedToday, todayCohort.postedToday);

  if (loading) {
    return (
      <div className="glass-card flex min-h-[200px] flex-1 flex-col rounded-2xl border border-blue-200/50 bg-white/80 p-5 shadow-sm">
        <div className="mb-4 h-5 w-48 animate-pulse rounded bg-slate-200" />
        <div className="mb-6 h-3 w-full animate-pulse rounded-full bg-slate-100" />
        <div className="mb-6 flex h-36 gap-1 overflow-hidden">
          {[1, 2, 3, 4, 5, 6, 7].map((k) => (
            <div key={k} className="flex min-w-0 flex-1 flex-col justify-end gap-1">
              <div className="mx-auto h-24 w-full max-w-[28px] animate-pulse rounded-t bg-slate-100" />
              <div className="mx-auto h-2 w-8 animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((k) => (
            <div key={k} className="h-16 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card flex min-h-0 flex-1 flex-col overflow-auto rounded-2xl border border-blue-200/60 bg-gradient-to-br from-white via-blue-50/30 to-white p-5 shadow-sm">
      <div className="mb-4 shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <BarChart3 className="h-5 w-5 text-blue-600" aria-hidden />
              Pipeline overview
            </h3>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-600">
              Totals come from your <strong className="font-semibold text-slate-800">To do jobs</strong> list. Track how
              many postings you have opened versus how many you have marked as applied, plus scraping and AI match
              coverage so you know what still needs attention.
            </p>
          </div>
        </div>
      </div>

      {s.total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-blue-200/80 bg-blue-50/40 px-4 py-10 text-center">
          <ClipboardList className="mb-3 h-10 w-10 text-blue-300" aria-hidden />
          <p className="text-sm font-medium text-slate-700">No jobs in your list yet</p>
          <p className="mt-1 max-w-sm text-xs text-slate-500">
            Post URLs on the left. This panel will show posted vs applied, application rate, and pipeline health.
          </p>
        </div>
      ) : (
        <>
          {/* Today: cohort added today — battery bar (gray track, blue = applied share) */}
          <div className="mb-5 shrink-0">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Today — added vs applied (pipeline)
              </span>
              <span className="text-xs text-slate-600">
                <span className="font-semibold text-slate-800">{todayCohort.rateToday}%</span> of today&apos;s adds
                <span className="text-slate-400"> · </span>
                <span className="text-slate-600">{todayCohort.appliedToday}</span>
                <Check className="mx-0.5 inline h-3 w-3 text-blue-600" strokeWidth={3} aria-hidden />
                <span className="text-slate-400"> / </span>
                <span className="font-medium text-slate-800">{todayCohort.postedToday}</span> added today
              </span>
            </div>
            <div className="space-y-1.5">
              <div
                className="today-battery-track relative h-1.5 w-full overflow-hidden rounded-full bg-slate-200/90 shadow-[inset_0_1px_2px_rgba(15,23,42,0.12)] ring-1 ring-slate-300/50"
                role="img"
                aria-label={`Today: ${todayCohort.appliedToday} of ${todayCohort.postedToday} jobs added today are now applied`}
                title={
                  todayCohort.postedToday > 0
                    ? `Track = added today (${todayCohort.postedToday}). Fill = now applied (${todayCohort.appliedToday}).`
                    : 'No jobs added today yet'
                }
              >
                {todayCohort.postedToday > 0 ? (
                  <div
                    className="today-battery-fill-shell absolute inset-y-0 left-0 z-0 min-w-0 overflow-hidden rounded-full"
                    style={{ width: `${todayBatteryPct}%` }}
                  >
                    <div className="today-battery-fill" />
                  </div>
                ) : null}
              </div>
              {todayCohort.postedToday === 0 ? (
                <p className="text-[11px] font-medium leading-snug text-slate-500">
                  No jobs added today — post a URL on the left to see today&apos;s progress.
                </p>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1 w-4 shrink-0 rounded-sm bg-slate-400" aria-hidden />
                Track = added today ({todayCohort.postedToday})
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-1 w-4 shrink-0 rounded-sm bg-gradient-to-r from-blue-600 to-blue-500"
                  aria-hidden
                />
                Fill = now applied ({todayCohort.appliedToday})
              </span>
            </div>
          </div>

          {/* Pipeline by day added — range selectable */}
          <div className="mb-5 shrink-0 rounded-xl border border-blue-100/90 bg-white/60 p-4 shadow-sm ring-1 ring-slate-100/80">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <CalendarRange className="h-4 w-4 shrink-0 text-blue-600" aria-hidden />
                    Pipeline by day added
                  </h4>
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                    <span className="sr-only">Chart time range</span>
                    <select
                      value={rangePreset}
                      onChange={(e) => setRangePreset(e.target.value as PipelineRangePreset)}
                      className="cursor-pointer rounded-lg border border-blue-200/80 bg-white/95 py-1 pl-2 pr-7 text-[11px] font-semibold text-slate-800 shadow-sm outline-none transition hover:border-blue-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30"
                      aria-label="Chart time range"
                    >
                      {RANGE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-600">
                  {pipelineSeries.preset === 'all' ? (
                    <>
                      <strong className="font-medium text-slate-700">All time</strong> — one column per{' '}
                      <strong className="font-medium text-slate-700">calendar day</strong> from your{' '}
                      <strong className="font-medium text-slate-700">earliest add</strong> through today (
                      {pipelineSeries.days.length} days). Same cohort logic as shorter ranges; scroll horizontally to
                      move through history.
                    </>
                  ) : (
                    <>
                      Each column is the <strong className="font-medium text-slate-700">day you added</strong> the job
                      to To do (last {pipelineSeries.days.length} days).{' '}
                      <strong className="font-medium text-slate-700">Posted</strong> is how many you added that day;{' '}
                      <strong className="font-medium text-slate-700">Applied</strong> is how many of{' '}
                      <em>those same jobs</em> are <strong>now</strong> marked applied. Scroll horizontally on small
                      screens when the range is long.
                    </>
                  )}
                </p>
                {pipelineSeries.historyTruncated ? (
                  <p className="mt-1.5 max-w-2xl text-[10px] leading-snug text-amber-800/95">
                    Your history from first add is longer than we can render in one chart; showing the{' '}
                    <strong className="font-semibold">most recent {pipelineSeries.days.length} days</strong> only.
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 text-left text-[11px] text-slate-600 sm:text-right">
                <div className="font-medium text-slate-500">
                  {pipelineSeries.preset === 'all'
                    ? pipelineSeries.historyTruncated
                      ? `Recent segment (${pipelineSeries.days.length} days)`
                      : `First add → today (${pipelineSeries.days.length} days)`
                    : `This window (${pipelineSeries.days.length} days)`}
                </div>
                <div className="mt-0.5">
                  <span className="font-semibold text-slate-800">{pipelineSeries.sumPostedWeek}</span> added
                  <span className="text-slate-400"> · </span>
                  <span className="font-semibold text-blue-700">{pipelineSeries.sumAppliedWeek}</span> now applied
                  <span className="text-slate-500">
                    {pipelineSeries.preset === 'all' ? ' (in chart range)' : ' (in window)'}
                  </span>
                </div>
              </div>
            </div>

            <WeeklyPostedAppliedChart series={pipelineSeries} />

            <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-4 rounded-sm border border-slate-400/80 bg-slate-300" aria-hidden />
                Gray column height ∝ added that day
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-4 rounded-sm border border-blue-700/40 bg-gradient-to-t from-blue-600 to-blue-500"
                  aria-hidden
                />
                Blue fill = share of that cohort now applied
                <Check className="h-3 w-3 text-blue-600" strokeWidth={3} aria-hidden />
              </span>
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat
              icon={<Wrench className="h-4 w-4 text-amber-600" />}
              label="Scrape ready"
              value={`${s.scrapedReady}/${s.total}`}
              hint="Page scraped; you can read the posting"
            />
            <MiniStat
              icon={<Sparkles className="h-4 w-4 text-indigo-600" />}
              label="Match scored"
              value={s.matchScored}
              hint="Jobs with an AI profile match score"
            />
            <MiniStat
              icon={<Loader2 className="h-4 w-4 text-amber-500" />}
              label="Match pending"
              value={s.matchProcessing + s.matchAwaiting}
              hint="Running or not analyzed yet"
            />
            <MiniStat
              icon={<AlertTriangle className="h-4 w-4 text-orange-600" />}
              label="Duplicates"
              value={duplicateCount}
              hint="Rows in Check required"
            />
          </div>

          <div className="mt-4 shrink-0 border-t border-blue-100/80 pt-4">
            <div className="rounded-xl border border-slate-200/80 bg-white/70 px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Scraping status</div>
              <p className="mt-1 text-xs leading-snug text-slate-700">
                {s.extraction.failed > 0 && (
                  <span className="mr-2 inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-700">
                    Failed {s.extraction.failed}
                  </span>
                )}
                <span className="text-slate-600">
                  Queue {s.extraction.pending + s.extraction.processing}
                  <span className="text-slate-400"> · </span>
                  Done {s.extraction.completed}
                </span>
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const WEEK_CHART_H = 120;

function WeeklyPostedAppliedChart({ series }: { series: WeekSeries }) {
  const maxPosted = Math.max(
    ...series.days.map((d) => d.posted),
    1,
  );
  const n = series.days.length;
  const compact = n > 14;
  /** Last 7 days view: narrow bars centered in each column (grid still full width for labels). */
  const isWeeklyPreset = series.preset === '7d';
  /** Up to ~42 days: equal columns fill the card. Beyond that: min column width so long ranges scroll instead of vanishing. */
  const minColPx = n > 42 ? 10 : 0;
  const gridTemplateColumns =
    minColPx > 0
      ? `repeat(${n}, minmax(${minColPx}px, 1fr))`
      : `repeat(${n}, minmax(0, 1fr))`;

  return (
    <div
      className="relative w-full overflow-x-auto overflow-y-visible pb-1 [-webkit-overflow-scrolling:touch]"
      role="img"
      aria-label="Each day: gray column height by jobs added that day; blue fill is applied share of that cohort"
    >
      <div
        className={`grid w-full min-w-0 ${isWeeklyPreset ? 'gap-2 sm:gap-3' : 'gap-1 sm:gap-1.5'}`}
        style={{ gridTemplateColumns }}
      >
        {series.days.map((d, idx) => {
          const trackPx =
            d.posted > 0 ? Math.max(10, Math.round((d.posted / maxPosted) * WEEK_CHART_H)) : 6;
          const fillPct = d.posted > 0 ? (d.applied / d.posted) * 100 : 0;
          const cellKey = `${d.dayStart}-${idx}`;
          const dateTitle = new Date(d.dayStart).toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
          return (
            <div key={cellKey} className="flex min-w-0 flex-col items-center">
              <div className="flex h-[120px] w-full max-w-full items-end justify-center px-px sm:px-0.5">
                <div
                  className={`pipeline-col-track group/cell relative overflow-hidden border border-slate-300/90 bg-slate-200 shadow-inner ${
                    isWeeklyPreset
                      ? 'w-full max-w-[13px] rounded-t-sm sm:max-w-[14px]'
                      : 'w-full max-w-full rounded-t-md'
                  }`}
                  style={{
                    height: trackPx,
                    minHeight: d.posted > 0 ? 10 : 6,
                  }}
                  title={`${d.label}: ${d.posted} added · ${d.applied} now applied`}
                >
                  <div
                    className="pipeline-col-fill absolute bottom-0 left-0 right-0 transition-[height] duration-500 ease-out"
                    style={{ height: `${fillPct}%` }}
                  />
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden w-max max-w-[min(220px,70vw)] -translate-x-1/2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left text-[10px] font-medium text-slate-800 shadow-lg group-hover/cell:block">
                    <span className="block text-slate-500">Added that day</span>
                    <span className="tabular-nums text-slate-900">{d.posted}</span>
                    <span className="mt-1 block text-slate-500">Now applied (cohort)</span>
                    <span className="tabular-nums text-blue-700">
                      {d.applied}
                      {d.posted > 0 ? ` (${Math.round(fillPct)}%)` : ''}
                    </span>
                  </span>
                </div>
              </div>
              <div
                className={`mt-1.5 w-full min-w-0 truncate text-center font-medium leading-tight text-slate-600 ${
                  compact ? 'text-[8px]' : 'text-[9px] sm:text-[10px]'
                }`}
                title={dateTitle}
              >
                {d.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div
      className="rounded-xl border border-slate-200/90 bg-white/80 px-3 py-2.5 shadow-sm"
      title={hint}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
