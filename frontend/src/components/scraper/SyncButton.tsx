import { useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, CheckCircle, AlertTriangle, Terminal, Clock } from 'lucide-react';
import type { SpiderInfo, SyncProgress, ScrapeRun } from '../../types/scraper';

interface SyncButtonProps {
  syncing: boolean;
  syncProgress: SyncProgress | null;
  spiders: SpiderInfo[];
  /** Recent scrape runs (newest first) used to derive last-sync timestamps. */
  lastSyncRuns?: ScrapeRun[];
  onSync: (spiderName?: string) => void;
}

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

export function SyncButton({ syncing, syncProgress, spiders, lastSyncRuns = [], onSync }: SyncButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showCommandFor, setShowCommandFor] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="relative inline-flex">
        <button
          disabled={syncing}
          onClick={() => onSync('all')}
          className="inline-flex items-center gap-2 rounded-l-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
          {progressLabel}
        </button>

        <button
          disabled={syncing}
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="inline-flex items-center rounded-r-lg border-l border-blue-500 bg-blue-600 px-2 py-2 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={16} />
        </button>

        {dropdownOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => { setDropdownOpen(false); setShowCommandFor(null); }} />
            <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
              {/* Overall last-sync summary */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
                <Clock size={13} className="shrink-0 text-slate-400" />
                {overall ? (
                  <span className="text-xs text-slate-500" title={`Last synced ${absoluteLabel(overall.ms)}`}>
                    Last sync{' '}
                    <span className="font-semibold text-slate-700">{relativeAgo(overall.ms)}</span>
                    {overall.run.spider_name && (
                      <span className="text-slate-400"> · {overall.run.spider_name}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">No syncs yet</span>
                )}
              </div>

              <div className="px-3 py-1.5 text-xs font-medium text-slate-500 uppercase tracking-wider">
                Run individual spider
              </div>
              {spiders.map((spider) => {
                const needsAuth = spider.requires_auth && !spider.auth_configured;
                return (
                  <div key={spider.name}>
                    <button
                      disabled={needsAuth || syncing}
                      onClick={() => {
                        if (!needsAuth) {
                          setDropdownOpen(false);
                          setShowCommandFor(null);
                          onSync(spider.name);
                        }
                      }}
                      className={`flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors ${
                        needsAuth || syncing
                          ? 'text-slate-400 cursor-not-allowed'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                        <span className="truncate">{spider.label}</span>
                        {renderSpiderSyncTime(spider.name)}
                      </span>
                      {spider.requires_auth && spider.auth_configured && (
                        <CheckCircle size={14} className="text-green-500 shrink-0" />
                      )}
                      {needsAuth && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 font-medium cursor-pointer hover:bg-red-100"
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
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium">
                          Auth
                        </span>
                      )}
                    </button>
                    {needsAuth && showCommandFor === spider.name && spider.auth_setup_command && (
                      <div className="mx-3 mb-2 p-2 rounded bg-slate-800 text-slate-100">
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mb-1">
                          <Terminal size={10} />
                          Run this command to set up auth:
                        </div>
                        <code className="text-xs break-all select-all">{spider.auth_setup_command}</code>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

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
        </p>
      ) : null}
    </div>
  );
}
