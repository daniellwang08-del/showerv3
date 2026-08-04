/**
 * Permanent job-fetch control board for the admin stats dashboard.
 * Posted window is shared with System Settings → Job Sync.
 * "Sync all sites" uses the platforms saved in the Job Sync schedule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle,
  Clock,
  RefreshCw,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { fetchJobSyncSchedule, stopJobFetch } from '../../api/scraperApi';
import { usePostedSyncWindow } from '../../hooks/usePostedSyncWindow';
import { useScraperStore } from '../../stores/scraperStore';
import type { JobSyncSchedule, ScrapeRun, SyncTriggerOptions } from '../../types/scraper';
import {
  formatPostedWindowShort,
  JOB_SYNC_SCHEDULE_UPDATED_EVENT,
  todayIsoDate,
} from '../../utils/postedSyncWindow';

function toUtcMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const hasTz = /([zZ])|([+-]\d{2}:?\d{2})$/.test(value);
  const iso = value.includes('T') ? value : value.trim().replace(' ', 'T');
  const ms = Date.parse(hasTz ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

function runTimeMs(run: ScrapeRun): number | undefined {
  return toUtcMs(run.finished_at) ?? toUtcMs(run.started_at);
}

function relativeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 45_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(ms).toLocaleDateString();
}

function absoluteLabel(ms: number): string {
  return new Date(ms).toLocaleString();
}

function statusDot(status: string | null | undefined): string {
  const s = (status || '').toLowerCase();
  if (s === 'completed' || s === 'success') return 'bg-emerald-500';
  if (s === 'failed' || s === 'error') return 'bg-rose-500';
  if (s === 'running') return 'bg-blue-500 animate-pulse';
  return 'bg-slate-300';
}

function spiderRunnable(
  spider: {
    requires_auth: boolean;
    auth_configured: boolean;
    auth_optional?: boolean;
  },
): boolean {
  return !spider.requires_auth || spider.auth_optional === true || spider.auth_configured;
}

export function SyncControlBoard() {
  const syncing = useScraperStore((s) => s.syncing);
  const syncProgress = useScraperStore((s) => s.syncProgress);
  const spiders = useScraperStore((s) => s.spiders);
  const lastSyncRuns = useScraperStore((s) => s.lastSyncRuns);
  const startSync = useScraperStore((s) => s.startSync);

  const {
    postedSince,
    postedUntil,
    windowActive,
    windowInvalid,
    setPostedSince,
    setPostedUntil,
    clearPostedWindow,
  } = usePostedSyncWindow();

  const [showCommandFor, setShowCommandFor] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [schedule, setSchedule] = useState<JobSyncSchedule | null>(null);

  const loadSchedule = useCallback(async () => {
    try {
      const row = await fetchJobSyncSchedule();
      setSchedule(row);
    } catch {
      /* keep last known; Sync all falls back to all runnable spiders */
    }
  }, []);

  useEffect(() => {
    void loadSchedule();
    const onUpdated = () => void loadSchedule();
    const onFocus = () => void loadSchedule();
    window.addEventListener(JOB_SYNC_SCHEDULE_UPDATED_EVENT, onUpdated);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(JOB_SYNC_SCHEDULE_UPDATED_EVENT, onUpdated);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadSchedule]);

  const schedulePlatforms = useMemo(() => {
    const names = schedule?.spider_names;
    if (!Array.isArray(names) || names.length === 0) return null;
    return names.map((n) => n.toLowerCase());
  }, [schedule]);

  const syncAllTargets = useMemo(() => {
    const runnable = spiders.filter(spiderRunnable);
    if (!schedulePlatforms) return runnable;
    const allowed = new Set(schedulePlatforms);
    const filtered = runnable.filter((s) => allowed.has(s.name.toLowerCase()));
    return filtered.length > 0 ? filtered : runnable;
  }, [spiders, schedulePlatforms]);

  const { lastBySpider, overall } = useMemo(() => {
    const map = new Map<string, ScrapeRun>();
    let latest: { run: ScrapeRun; ms: number } | null = null;
    for (const run of lastSyncRuns) {
      const key = (run.spider_name || '').toLowerCase();
      if (key && !map.has(key)) map.set(key, run);
      const ms = runTimeMs(run);
      if (ms != null && (!latest || ms > latest.ms)) latest = { run, ms };
    }
    return { lastBySpider: map, overall: latest };
  }, [lastSyncRuns]);

  const buildOptions = (spiderName: string): SyncTriggerOptions => {
    const dated = postedSince.trim() && !windowInvalid;
    if (spiderName === 'all') {
      const names = syncAllTargets.map((s) => s.name);
      return {
        spider_name: 'all',
        spider_names: names.length > 0 ? names : undefined,
        sync_mode: dated ? 'date_backfill' : 'incremental',
        posted_since: dated ? postedSince.trim() : undefined,
        posted_until: dated && postedUntil.trim() ? postedUntil.trim() : undefined,
      };
    }
    if (dated) {
      return {
        spider_name: spiderName,
        sync_mode: 'date_backfill',
        posted_since: postedSince.trim(),
        posted_until: postedUntil.trim() || undefined,
      };
    }
    return { spider_name: spiderName, sync_mode: 'incremental' };
  };

  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await stopJobFetch();
    } catch {
      /* store WS / status poll will settle */
    } finally {
      setStopping(false);
    }
  };

  const progressLabel = syncing
    ? (syncProgress?.message || 'Syncing…')
    : 'Sync all sites';

  const usingScheduleSubset =
    Boolean(schedulePlatforms) &&
    syncAllTargets.length > 0 &&
    syncAllTargets.length < spiders.filter(spiderRunnable).length;

  return (
    <div className="stats-side-tile relative flex h-full min-h-[220px] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 shadow-sm dark:border-slate-700/80 dark:bg-[#141d31]/95">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-400/10 via-transparent to-indigo-500/10 opacity-80" />

      {/* Header */}
      <div className="relative flex shrink-0 items-start justify-between gap-2 border-b border-slate-200/80 px-3 py-2.5 dark:border-slate-700/70">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">
            Job fetch
          </p>
          {syncing && syncProgress ? (
            <p className="mt-0.5 truncate text-[11px] font-medium text-blue-600 dark:text-sky-300">
              {syncProgress.total > 0 && syncProgress.current > 0
                ? `Platform ${syncProgress.current}/${syncProgress.total} · `
                : ''}
              {syncProgress.message}
            </p>
          ) : overall ? (
            <p
              className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-[11px] text-slate-500"
              title={`Last synced ${absoluteLabel(overall.ms)}`}
            >
              <Clock size={11} className="shrink-0" />
              Last <span className="font-semibold text-slate-600 dark:text-[#cbd5e1]">{relativeAgo(overall.ms)}</span>
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-slate-400">No syncs yet</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {syncing ? (
            <button
              type="button"
              disabled={stopping}
              onClick={() => void handleStop()}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-300"
              title="Stop current fetch"
            >
              <Square size={11} className="fill-current" />
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : null}
          <button
            type="button"
            disabled={syncing || windowInvalid || syncAllTargets.length === 0}
            onClick={() => void startSync(buildOptions('all'))}
            title={
              usingScheduleSubset
                ? `Syncs ${syncAllTargets.length} site(s) from Job Sync settings`
                : 'Sync all runnable sites'
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            <span className="max-w-[7.5rem] truncate">{progressLabel}</span>
            {windowActive && !syncing ? (
              <span className="hidden rounded-full bg-white/20 px-1.5 py-0.5 text-[9px] font-semibold sm:inline">
                Dated
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {/* Posted window — shared with System Settings → Job Sync */}
      <div className="relative shrink-0 border-b border-slate-100 bg-gradient-to-br from-sky-50/90 via-white to-indigo-50/40 px-3 py-2.5 dark:border-white/10 dark:from-sky-950/35 dark:via-[#0b1220] dark:to-indigo-950/25">
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-800 dark:text-sky-300">
              <CalendarRange size={11} className="shrink-0" />
              Posted window
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-[#94a3b8]">
              Same dates as Job Sync settings. Empty = incremental.
            </p>
          </div>
          <button
            type="button"
            onClick={clearPostedWindow}
            aria-hidden={!windowActive}
            tabIndex={windowActive ? 0 : -1}
            className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-slate-200 bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 transition hover:border-rose-200 hover:text-rose-600 dark:border-white/10 dark:bg-white/5 dark:text-[#94a3b8] ${
              windowActive ? '' : 'pointer-events-none invisible'
            }`}
            title="Clear date window"
          >
            <X size={10} />
            Clear
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <label className="block min-w-0">
            <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
              Since
            </span>
            <input
              type="date"
              value={postedSince}
              max={postedUntil || todayIsoDate()}
              onChange={(e) => setPostedSince(e.target.value)}
              className="h-7 w-full rounded-md border border-slate-200 bg-white px-1.5 text-[11px] text-slate-800 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-200 dark:border-white/10 dark:bg-[#060b14] dark:text-white"
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
              Until
            </span>
            <input
              type="date"
              value={postedUntil}
              min={postedSince || undefined}
              max={todayIsoDate()}
              onChange={(e) => setPostedUntil(e.target.value)}
              className="h-7 w-full rounded-md border border-slate-200 bg-white px-1.5 text-[11px] text-slate-800 outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-200 dark:border-white/10 dark:bg-[#060b14] dark:text-white"
            />
          </label>
        </div>

        {/* Fixed-height status row so toggling dated/incremental never reflows */}
        <div className="mt-1.5 flex h-5 items-center">
          {windowInvalid ? (
            <p className="truncate text-[10px] font-medium text-rose-600 dark:text-rose-300">
              “Since” must be on or before “Until”.
            </p>
          ) : windowActive ? (
            <p className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-sky-600/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-400/10 dark:text-sky-200">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
              {formatPostedWindowShort(postedSince)}
              {' → '}
              {postedUntil ? formatPostedWindowShort(postedUntil) : 'today'}
            </p>
          ) : (
            <p className="truncate text-[10px] text-slate-400 dark:text-[#64748b]">
              Incremental — new since checkpoint
              {usingScheduleSubset
                ? ` · ${syncAllTargets.length} site(s)`
                : ''}
            </p>
          )}
        </div>
      </div>

      {/* Per-platform actions */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#64748b]">
          Pull by site
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-1.5 timeline-scroll">
          {spiders.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-slate-500">
              No job sites configured. Add them in System Settings.
            </p>
          ) : (
            spiders.map((spider) => {
              const needsAuth =
                spider.requires_auth &&
                !spider.auth_configured &&
                spider.auth_optional !== true;
              const inSchedule =
                !schedulePlatforms || schedulePlatforms.includes(spider.name.toLowerCase());
              const disabled = needsAuth || syncing || windowInvalid;
              const run = lastBySpider.get(spider.name.toLowerCase());
              const ms = run ? runTimeMs(run) : undefined;

              return (
                <div key={spider.name}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (!disabled) void startSync(buildOptions(spider.name));
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                      disabled
                        ? 'cursor-not-allowed text-slate-400'
                        : 'text-slate-700 hover:bg-slate-50 dark:text-[#e2e8f0] dark:hover:bg-white/5'
                    } ${!inSchedule && !needsAuth ? 'opacity-55' : ''}`}
                    title={
                      !inSchedule
                        ? 'Not in Job Sync settings platform list — still pullable individually'
                        : undefined
                    }
                  >
                    <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                      <span className="truncate font-semibold">{spider.label}</span>
                      {ms == null ? (
                        <span className="text-[10px] text-slate-400">Never synced</span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] text-slate-400"
                          title={`Last synced ${absoluteLabel(ms)}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${statusDot(run?.status)}`} />
                          Synced {relativeAgo(ms)}
                        </span>
                      )}
                    </span>
                    {spider.requires_auth && spider.auth_configured && (
                      <CheckCircle size={13} className="shrink-0 text-green-500" />
                    )}
                    {needsAuth && (
                      <span
                        className="inline-flex cursor-pointer items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-medium text-red-600 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowCommandFor(showCommandFor === spider.name ? null : spider.name);
                        }}
                      >
                        <AlertTriangle size={9} />
                        Auth
                      </span>
                    )}
                    {!needsAuth && (
                      <RefreshCw size={12} className="shrink-0 text-slate-400 opacity-70" />
                    )}
                  </button>
                  {needsAuth && showCommandFor === spider.name && spider.auth_setup_command && (
                    <div className="mx-3 mb-2 rounded bg-slate-800 p-2 text-slate-100">
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] text-slate-400">
                        <Terminal size={10} />
                        Run this command to set up auth:
                      </div>
                      <code className="break-all text-[11px] select-all">{spider.auth_setup_command}</code>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
