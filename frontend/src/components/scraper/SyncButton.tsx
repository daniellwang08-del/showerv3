import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  RefreshCw,
  ChevronDown,
  CheckCircle,
  AlertTriangle,
  Terminal,
  Clock,
  CalendarRange,
  X,
} from 'lucide-react';
import type { SpiderInfo, SyncProgress, ScrapeRun, SyncTriggerOptions } from '../../types/scraper';

interface SyncButtonProps {
  syncing: boolean;
  syncProgress: SyncProgress | null;
  spiders: SpiderInfo[];
  /** Recent scrape runs (newest first) used to derive last-sync timestamps. */
  lastSyncRuns?: ScrapeRun[];
  onSync: (options: SyncTriggerOptions) => void;
}

const WINDOW_STORAGE_KEY = 'scraper_sync_posted_window_v1';
const LOOKBACK_CHIPS = [7, 14, 30, 90] as const;

/** Parse a server timestamp (naive UTC) into epoch ms, treating bare values as UTC. */
function toUtcMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const hasTz = /([zZ])|([+-]\d{2}:?\d{2})$/.test(value);
  const iso = value.includes('T') ? value : value.trim().replace(' ', 'T');
  const ms = Date.parse(hasTz ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The moment a run last produced data: prefer finish, fall back to start. */
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
  if (s === 'running') return 'bg-blue-500';
  return 'bg-slate-300';
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function readStoredWindow(): { since: string; until: string } {
  try {
    const raw = sessionStorage.getItem(WINDOW_STORAGE_KEY);
    if (!raw) return { since: '', until: '' };
    const parsed = JSON.parse(raw) as { since?: string; until?: string };
    return {
      since: typeof parsed.since === 'string' ? parsed.since : '',
      until: typeof parsed.until === 'string' ? parsed.until : '',
    };
  } catch {
    return { since: '', until: '' };
  }
}

const MENU_WIDTH = 320;
/** Above stats tiles / filter board (≤40) and below modals. */
const MENU_Z = 180;

export function SyncButton({ syncing, syncProgress, spiders, lastSyncRuns = [], onSync }: SyncButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showCommandFor, setShowCommandFor] = useState<string | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const stored = useMemo(() => readStoredWindow(), []);
  const [postedSince, setPostedSince] = useState(stored.since);
  const [postedUntil, setPostedUntil] = useState(stored.until);

  const windowActive = Boolean(postedSince.trim());
  const windowInvalid =
    windowActive && Boolean(postedUntil) && postedSince > postedUntil;

  const activeChip = useMemo(() => {
    if (!postedSince) return null;
    const until = postedUntil || todayIsoDate();
    for (const days of LOOKBACK_CHIPS) {
      if (postedSince === daysAgoIsoDate(days) && until === todayIsoDate()) return days;
    }
    return 'custom' as const;
  }, [postedSince, postedUntil]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        WINDOW_STORAGE_KEY,
        JSON.stringify({ since: postedSince, until: postedUntil }),
      );
    } catch {
      /* ignore */
    }
  }, [postedSince, postedUntil]);

  const progressLabel = syncing
    ? (syncProgress?.message || 'Syncing…')
    : 'Sync All';

  // Most-recent run per spider (lastSyncRuns is newest-first) + overall latest.
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

  const closeMenu = () => {
    setDropdownOpen(false);
    setShowCommandFor(null);
  };

  const buildOptions = (spiderName: string): SyncTriggerOptions => {
    if (postedSince.trim() && !windowInvalid) {
      return {
        spider_name: spiderName,
        sync_mode: 'date_backfill',
        posted_since: postedSince.trim(),
        posted_until: postedUntil.trim() || undefined,
      };
    }
    return { spider_name: spiderName, sync_mode: 'incremental' };
  };

  const applyLookback = (days: number) => {
    setPostedSince(daysAgoIsoDate(days));
    setPostedUntil(todayIsoDate());
  };

  const clearWindow = () => {
    setPostedSince('');
    setPostedUntil('');
  };

  const updateMenuPos = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - 8,
    );
    setMenuPos({ top: rect.bottom + 4, left });
  };

  useLayoutEffect(() => {
    if (!dropdownOpen) {
      setMenuPos(null);
      return;
    }
    updateMenuPos();
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onReposition = () => updateMenuPos();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [dropdownOpen]);

  const renderSpiderSyncTime = (spiderName: string) => {
    const run = lastBySpider.get(spiderName.toLowerCase());
    const ms = run ? runTimeMs(run) : undefined;
    if (ms == null) {
      return <span className="text-[10.5px] text-slate-400">Never synced</span>;
    }
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] text-slate-400"
        title={`Last synced ${absoluteLabel(ms)}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${statusDot(run?.status)}`} />
        Synced {relativeAgo(ms)}
      </span>
    );
  };

  const menu =
    dropdownOpen && menuPos
      ? createPortal(
          <>
            <div
              className="fixed inset-0"
              style={{ zIndex: MENU_Z }}
              onClick={closeMenu}
            />
            <div
              className="fixed overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-2xl shadow-slate-900/15 dark:border-white/10 dark:bg-[#0b1220] dark:shadow-black/50"
              style={{ zIndex: MENU_Z + 1, top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
              role="menu"
            >
              <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-white/10">
                <Clock size={13} className="shrink-0 text-slate-400" />
                {overall ? (
                  <span className="text-xs text-slate-500 dark:text-[#94a3b8]" title={`Last synced ${absoluteLabel(overall.ms)}`}>
                    Last sync{' '}
                    <span className="font-semibold text-slate-700 dark:text-[#e2e8f0]">{relativeAgo(overall.ms)}</span>
                    {overall.run.spider_name && (
                      <span className="text-slate-400"> · {overall.run.spider_name}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">No syncs yet</span>
                )}
              </div>

              {/* Posted date window */}
              <div className="border-b border-slate-100 bg-gradient-to-br from-sky-50/80 via-white to-indigo-50/50 px-3 py-3 dark:border-white/10 dark:from-sky-950/40 dark:via-[#0b1220] dark:to-indigo-950/30">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-sky-800 dark:text-sky-300">
                      <CalendarRange size={12} className="shrink-0" />
                      Posted window
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-[#94a3b8]">
                      Only fetch jobs listed in this date range. Leave empty for incremental sync.
                    </p>
                  </div>
                  {windowActive ? (
                    <button
                      type="button"
                      onClick={clearWindow}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-slate-200 bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 transition hover:border-rose-200 hover:text-rose-600 dark:border-white/10 dark:bg-white/5 dark:text-[#94a3b8] dark:hover:text-rose-300"
                      title="Clear date window"
                    >
                      <X size={10} />
                      Clear
                    </button>
                  ) : null}
                </div>

                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {LOOKBACK_CHIPS.map((days) => {
                    const active = activeChip === days;
                    return (
                      <button
                        key={days}
                        type="button"
                        onClick={() => applyLookback(days)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                          active
                            ? 'bg-sky-600 text-white shadow-sm shadow-sky-600/30'
                            : 'border border-slate-200/90 bg-white/90 text-slate-600 hover:border-sky-300 hover:text-sky-700 dark:border-white/10 dark:bg-white/5 dark:text-[#cbd5e1] dark:hover:border-sky-500/40 dark:hover:text-sky-300'
                        }`}
                      >
                        Last {days}d
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                      Since
                    </span>
                    <input
                      type="date"
                      value={postedSince}
                      max={postedUntil || todayIsoDate()}
                      onChange={(e) => setPostedSince(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-white/10 dark:bg-[#060b14] dark:text-white dark:focus:border-sky-500 dark:focus:ring-sky-900/50"
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                      Until
                    </span>
                    <input
                      type="date"
                      value={postedUntil}
                      min={postedSince || undefined}
                      max={todayIsoDate()}
                      onChange={(e) => setPostedUntil(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-white/10 dark:bg-[#060b14] dark:text-white dark:focus:border-sky-500 dark:focus:ring-sky-900/50"
                    />
                  </label>
                </div>

                {windowInvalid ? (
                  <p className="mt-2 text-[11px] font-medium text-rose-600 dark:text-rose-300">
                    “Since” must be on or before “Until”.
                  </p>
                ) : windowActive ? (
                  <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-sky-600/10 px-2 py-1 text-[11px] font-semibold text-sky-800 dark:bg-sky-400/10 dark:text-sky-200">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                    {formatShortDate(postedSince)}
                    {' → '}
                    {postedUntil ? formatShortDate(postedUntil) : 'today'}
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-400 dark:text-[#64748b]">
                    Incremental mode — only new listings since last checkpoint.
                  </p>
                )}
              </div>

              <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#64748b]">
                Run individual spider
              </div>
              <div className="max-h-64 overflow-y-auto pb-1">
                {spiders.map((spider) => {
                  const needsAuth =
                    spider.requires_auth &&
                    !spider.auth_configured &&
                    spider.auth_optional !== true;
                  const disabled = needsAuth || syncing || windowInvalid;
                  return (
                    <div key={spider.name}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (!disabled) {
                            closeMenu();
                            onSync(buildOptions(spider.name));
                          }
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
                          disabled
                            ? 'cursor-not-allowed text-slate-400'
                            : 'text-slate-700 hover:bg-slate-50 dark:text-[#e2e8f0] dark:hover:bg-white/5'
                        }`}
                      >
                        <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                          <span className="truncate">{spider.label}</span>
                          {renderSpiderSyncTime(spider.name)}
                        </span>
                        {spider.requires_auth && spider.auth_configured && (
                          <CheckCircle size={14} className="shrink-0 text-green-500" />
                        )}
                        {needsAuth && (
                          <span
                            className="inline-flex cursor-pointer items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-300"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowCommandFor(showCommandFor === spider.name ? null : spider.name);
                            }}
                          >
                            <AlertTriangle size={10} />
                            Auth Required
                          </span>
                        )}
                        {spider.requires_auth && spider.auth_configured && (
                          <span className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                            Auth
                          </span>
                        )}
                      </button>
                      {needsAuth && showCommandFor === spider.name && spider.auth_setup_command && (
                        <div className="mx-3 mb-2 rounded bg-slate-800 p-2 text-slate-100">
                          <div className="mb-1 flex items-center gap-1.5 text-[10px] text-slate-400">
                            <Terminal size={10} />
                            Run this command to set up auth:
                          </div>
                          <code className="break-all text-xs select-all">{spider.auth_setup_command}</code>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div ref={triggerRef} className="relative inline-flex">
        <button
          type="button"
          disabled={syncing || windowInvalid}
          onClick={() => onSync(buildOptions('all'))}
          className="inline-flex items-center gap-2 rounded-l-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
          {progressLabel}
          {windowActive && !syncing ? (
            <span className="hidden items-center gap-1 rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold sm:inline-flex">
              <CalendarRange size={10} />
              Window
            </span>
          ) : null}
        </button>

        <button
          type="button"
          disabled={syncing}
          onClick={() => setDropdownOpen((v) => !v)}
          aria-expanded={dropdownOpen}
          aria-haspopup="menu"
          className="inline-flex items-center rounded-r-lg border-l border-blue-500 bg-blue-600 px-2 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      {menu}

      {syncing && syncProgress ? (
        <p className="max-w-sm text-right text-[11px] leading-snug text-slate-500">
          {syncProgress.total > 0 && syncProgress.current > 0 && (
            <span className="font-semibold text-blue-700">
              Platform {syncProgress.current}/{syncProgress.total}
              {' · '}
            </span>
          )}
          {syncProgress.message}
        </p>
      ) : overall ? (
        <p
          className="inline-flex items-center gap-1 text-[11px] text-slate-400"
          title={`Last synced ${absoluteLabel(overall.ms)}`}
        >
          <Clock size={11} className="shrink-0" />
          Last synced <span className="font-semibold text-slate-500">{relativeAgo(overall.ms)}</span>
          {windowActive ? (
            <span className="ml-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
              dated
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
