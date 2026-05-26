import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarRange,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  fetchSyncCheckpoints,
  fetchSyncPlatforms,
  triggerSync,
} from '../../api/scraperApi';
import type { SyncCheckpoint, SyncPlatform } from '../../types/scraper';
import { useScraperStore } from '../../stores/scraperStore';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIsoDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return fallback;
}

function SectionMessage({ ok, text }: { ok?: boolean; text: string }) {
  if (!text) return null;
  return (
    <p
      className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${
        ok ? 'text-emerald-700' : 'text-rose-700'
      }`}
    >
      {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      {text}
    </p>
  );
}

function formatCheckpointMarkers(markers: SyncCheckpoint['marker_job_ids']): string {
  if (Array.isArray(markers)) {
    return markers.slice(0, 3).join(', ') || '—';
  }
  if (markers && typeof markers === 'object') {
    const parts = Object.entries(markers).slice(0, 2).map(([title, ids]) => {
      const list = Array.isArray(ids) ? ids.slice(0, 3).join(', ') : String(ids);
      return `${title}: ${list}`;
    });
    return parts.join(' · ') || '—';
  }
  return '—';
}

export function JobSyncSettingsSection() {
  const syncing = useScraperStore((s) => s.syncing);
  const syncProgress = useScraperStore((s) => s.syncProgress);
  const loadSpiders = useScraperStore((s) => s.loadSpiders);
  const checkSyncStatus = useScraperStore((s) => s.checkSyncStatus);
  const spiders = useScraperStore((s) => s.spiders);

  const [platforms, setPlatforms] = useState<SyncPlatform[]>([]);
  const [checkpoints, setCheckpoints] = useState<SyncCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [postedSince, setPostedSince] = useState(() => daysAgoIsoDate(30));
  const [postedUntil, setPostedUntil] = useState(() => todayIsoDate());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionOk, setActionOk] = useState(false);

  const authByPlatform = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const spider of spiders) {
      map.set(spider.name, !spider.requires_auth || spider.auth_configured);
    }
    return map;
  }, [spiders]);

  const selectedList = useMemo(
    () => platforms.filter((p) => selectedPlatforms.has(p.name)).map((p) => p.name),
    [platforms, selectedPlatforms],
  );

  const blockedSelection = useMemo(
    () => selectedList.filter((name) => authByPlatform.get(name) === false),
    [selectedList, authByPlatform],
  );

  const canRun =
    !syncing &&
    !running &&
    postedSince.trim().length > 0 &&
    selectedList.length > 0 &&
    blockedSelection.length === 0 &&
    (!postedUntil || postedSince <= postedUntil);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [platformRows, checkpointRows] = await Promise.all([
        fetchSyncPlatforms(),
        fetchSyncCheckpoints(),
      ]);
      setPlatforms(platformRows);
      setCheckpoints(checkpointRows);
      setSelectedPlatforms(new Set(platformRows.map((p) => p.name)));
      await loadSpiders();
    } catch (err: unknown) {
      setLoadError(extractErrorMessage(err, 'Failed to load sync settings.'));
    } finally {
      setLoading(false);
    }
  }, [loadSpiders]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePlatform = (name: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
    setActionMsg('');
  };

  const selectAllPlatforms = () => {
    setSelectedPlatforms(new Set(platforms.map((p) => p.name)));
    setActionMsg('');
  };

  const handleRunDateSync = async () => {
    if (!canRun) return;
    setRunning(true);
    setActionMsg('');
    setActionOk(false);
    try {
      const status = await triggerSync({
        spider_name: 'all',
        sync_mode: 'date_backfill',
        spider_names: selectedList,
        posted_since: postedSince,
        posted_until: postedUntil || undefined,
      });
      useScraperStore.setState({
        syncing: true,
        syncProgress: {
          spiderName: 'all',
          current: 0,
          total: selectedList.length,
          itemsScraped: 0,
          itemsNew: 0,
          elapsedSeconds: 0,
          message: 'Date-range sync queued…',
        },
        syncStatus: status,
      });
      void checkSyncStatus();
      setActionOk(true);
      setActionMsg(status.message || 'Date-range sync queued.');
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to queue date-range sync.'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-600 to-blue-700 text-white">
          <CalendarRange className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-slate-900">Job sync</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            The Jobs page <strong>Sync All</strong> button runs incremental sync: spiders paginate
            newest-first and stop when they hit the last saved 3-job checkpoint markers (not a
            timestamp window). Use this section for initial backfill or manual date-range sync.
            Date sync ignores old checkpoints, filters by posted date where available, and saves
            fresh 3-job markers when each spider finishes.
          </p>

          {loading ? (
            <p className="mt-4 text-sm text-slate-500">Loading sync settings…</p>
          ) : loadError ? (
            <p className="mt-4 text-sm text-rose-700">{loadError}</p>
          ) : (
            <div className="mt-5 space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="sync-posted-since" className="text-xs font-semibold text-slate-700">
                    Posted since (required)
                  </label>
                  <input
                    id="sync-posted-since"
                    type="date"
                    value={postedSince}
                    max={postedUntil || undefined}
                    onChange={(e) => {
                      setPostedSince(e.target.value);
                      setActionMsg('');
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                  />
                </div>
                <div>
                  <label htmlFor="sync-posted-until" className="text-xs font-semibold text-slate-700">
                    Posted until (optional)
                  </label>
                  <input
                    id="sync-posted-until"
                    type="date"
                    value={postedUntil}
                    min={postedSince || undefined}
                    onChange={(e) => {
                      setPostedUntil(e.target.value);
                      setActionMsg('');
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {[7, 14, 30, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => {
                      setPostedSince(daysAgoIsoDate(days));
                      setPostedUntil(todayIsoDate());
                      setActionMsg('');
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-300"
                  >
                    Last {days}d
                  </button>
                ))}
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700">Platforms</span>
                  <button
                    type="button"
                    onClick={selectAllPlatforms}
                    className="text-xs font-semibold text-sky-700 hover:text-sky-900"
                  >
                    Select all
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {platforms.map((platform) => {
                    const checked = selectedPlatforms.has(platform.name);
                    const authOk = authByPlatform.get(platform.name) !== false;
                    return (
                      <label
                        key={platform.name}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                          checked ? 'border-sky-300 bg-sky-50/60' : 'border-slate-200 bg-white'
                        } ${!authOk ? 'opacity-70' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePlatform(platform.name)}
                          className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        <span className="flex-1">{platform.label}</span>
                        {platform.requires_auth && (
                          <span
                            className={`text-[10px] font-semibold ${
                              authOk ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {authOk ? 'Auth OK' : 'Auth required'}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
                {blockedSelection.length > 0 && (
                  <p className="mt-2 text-xs text-rose-700">
                    Selected platforms need auth setup before sync: {blockedSelection.join(', ')}
                  </p>
                )}
              </div>

              {checkpoints.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Saved checkpoint markers
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-slate-700">
                    {checkpoints.map((cp) => (
                      <li key={cp.spider_name} className="flex flex-wrap gap-x-2">
                        <span className="font-semibold capitalize">{cp.spider_name}</span>
                        <span className="truncate">{formatCheckpointMarkers(cp.marker_job_ids)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {syncing && syncProgress && (
                <p className="text-xs text-slate-600">
                  {syncProgress.message}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleRunDateSync()}
                  disabled={!canRun}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {running || syncing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {running || syncing ? 'Sync running…' : 'Run date-range sync'}
                </button>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>

              {actionMsg && <SectionMessage ok={actionOk} text={actionMsg} />}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
