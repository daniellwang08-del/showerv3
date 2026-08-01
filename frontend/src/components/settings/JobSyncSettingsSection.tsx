import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';
import {
  fetchJobSyncSchedule,
  fetchSyncCheckpoints,
  fetchSyncPlatforms,
  saveJobSyncSchedule,
  triggerSync,
} from '../../api/scraperApi';
import type { JobSyncSchedule, SyncCheckpoint, SyncPlatform } from '../../types/scraper';
import { useScraperStore } from '../../stores/scraperStore';
import { BrandedLoader } from '../layout/BrandedLoader';

const INTERVAL_PRESETS = [1, 2, 4, 6, 8, 12, 24] as const;

const TIMEZONE_LABELS: Record<string, string> = {
  'America/Los_Angeles': 'Pacific (Los Angeles)',
  'America/New_York': 'Eastern (New York)',
  'America/Chicago': 'Central (Chicago)',
  'America/Denver': 'Mountain (Denver)',
  UTC: 'UTC',
};

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

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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
    return markers.slice(0, 3).join(', ') || '-';
  }
  if (markers && typeof markers === 'object') {
    const parts = Object.entries(markers).slice(0, 2).map(([title, ids]) => {
      const list = Array.isArray(ids) ? ids.slice(0, 3).join(', ') : String(ids);
      return `${title}: ${list}`;
    });
    return parts.join(' · ') || '-';
  }
  return '-';
}

function PlatformRow({
  platforms,
  selected,
  authByPlatform,
  onToggle,
  onSelectAll,
}: {
  platforms: SyncPlatform[];
  selected: Set<string>;
  authByPlatform: Map<string, boolean>;
  onToggle: (name: string) => void;
  onSelectAll: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">Platforms</span>
        <button
          type="button"
          onClick={onSelectAll}
          className="text-xs font-semibold text-sky-700 hover:text-sky-900"
        >
          Select all
        </button>
      </div>
      <div className="flex flex-nowrap gap-2 overflow-x-auto pb-0.5">
        {platforms.map((platform) => {
          const checked = selected.has(platform.name);
          const authOk = authByPlatform.get(platform.name) !== false;
          return (
            <label
              key={platform.name}
              className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm whitespace-nowrap ${
                checked ? 'border-sky-300 bg-sky-50/60' : 'border-slate-200 bg-white'
              } ${!authOk ? 'opacity-70' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(platform.name)}
                className="shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
              />
              <span className="min-w-0 truncate">{platform.label}</span>
              {platform.requires_auth && (
                <span
                  className={`shrink-0 text-[10px] font-semibold ${
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
    </div>
  );
}

export function JobSyncSettingsSection() {
  const syncing = useScraperStore((s) => s.syncing);
  const syncProgress = useScraperStore((s) => s.syncProgress);
  const loadSpiders = useScraperStore((s) => s.loadSpiders);
  const checkSyncStatus = useScraperStore((s) => s.checkSyncStatus);
  const spiders = useScraperStore((s) => s.spiders);

  const [platforms, setPlatforms] = useState<SyncPlatform[]>([]);
  const [checkpoints, setCheckpoints] = useState<SyncCheckpoint[]>([]);
  const [schedule, setSchedule] = useState<JobSyncSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [postedSince, setPostedSince] = useState(() => daysAgoIsoDate(30));
  const [postedUntil, setPostedUntil] = useState(() => todayIsoDate());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionOk, setActionOk] = useState(false);

  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedCadence, setSchedCadence] = useState<'interval' | 'daily'>('daily');
  const [schedIntervalHours, setSchedIntervalHours] = useState(4);
  const [schedDailyTime, setSchedDailyTime] = useState('04:30');
  const [schedTimezone, setSchedTimezone] = useState('America/Los_Angeles');
  const [schedSyncMode, setSchedSyncMode] = useState<'incremental' | 'date_backfill'>(
    'incremental',
  );
  const [schedLookbackDays, setSchedLookbackDays] = useState(2);
  const [schedPlatforms, setSchedPlatforms] = useState<Set<string>>(new Set());
  const [schedSaving, setSchedSaving] = useState(false);
  const [schedMsg, setSchedMsg] = useState('');
  const [schedOk, setSchedOk] = useState(false);

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

  const schedulePlatformList = useMemo(
    () => platforms.filter((p) => schedPlatforms.has(p.name)).map((p) => p.name),
    [platforms, schedPlatforms],
  );

  const blockedSelection = useMemo(
    () => selectedList.filter((name) => authByPlatform.get(name) === false),
    [selectedList, authByPlatform],
  );

  const blockedScheduleSelection = useMemo(
    () => schedulePlatformList.filter((name) => authByPlatform.get(name) === false),
    [schedulePlatformList, authByPlatform],
  );

  const canRun =
    !syncing &&
    !running &&
    postedSince.trim().length > 0 &&
    selectedList.length > 0 &&
    blockedSelection.length === 0 &&
    (!postedUntil || postedSince <= postedUntil);

  const canSaveSchedule =
    !schedSaving &&
    schedulePlatformList.length > 0 &&
    blockedScheduleSelection.length === 0 &&
    schedIntervalHours >= 1 &&
    schedIntervalHours <= 168 &&
    /^\d{2}:\d{2}$/.test(schedDailyTime);

  const applyScheduleToForm = useCallback(
    (row: JobSyncSchedule, platformRows: SyncPlatform[]) => {
      setSchedule(row);
      setSchedEnabled(row.enabled);
      setSchedCadence(row.cadence);
      setSchedIntervalHours(row.interval_hours);
      setSchedDailyTime(row.daily_time);
      setSchedTimezone(row.timezone);
      setSchedSyncMode(row.sync_mode);
      setSchedLookbackDays(row.lookback_days);
      const names =
        row.spider_names && row.spider_names.length > 0
          ? row.spider_names
          : platformRows.map((p) => p.name);
      setSchedPlatforms(new Set(names));
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [platformRows, checkpointRows, scheduleRow] = await Promise.all([
        fetchSyncPlatforms(),
        fetchSyncCheckpoints(),
        fetchJobSyncSchedule(),
      ]);
      setPlatforms(platformRows);
      setCheckpoints(checkpointRows);
      setSelectedPlatforms(new Set(platformRows.map((p) => p.name)));
      applyScheduleToForm(scheduleRow, platformRows);
      await loadSpiders();
    } catch (err: unknown) {
      setLoadError(extractErrorMessage(err, 'Failed to load sync settings.'));
    } finally {
      setLoading(false);
    }
  }, [applyScheduleToForm, loadSpiders]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePlatform = (name: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setActionMsg('');
  };

  const toggleSchedulePlatform = (name: string) => {
    setSchedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setSchedMsg('');
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

  const handleSaveSchedule = async () => {
    if (!canSaveSchedule) return;
    setSchedSaving(true);
    setSchedMsg('');
    setSchedOk(false);
    try {
      const saved = await saveJobSyncSchedule({
        enabled: schedEnabled,
        cadence: schedCadence,
        interval_hours: schedIntervalHours,
        daily_time: schedDailyTime,
        timezone: schedTimezone,
        sync_mode: schedSyncMode,
        lookback_days: schedLookbackDays,
        spider_names: schedulePlatformList,
      });
      applyScheduleToForm(saved, platforms);
      setSchedOk(true);
      setSchedMsg(
        saved.enabled
          ? `Schedule saved. Next run: ${formatWhen(saved.next_run_at)}.`
          : 'Schedule saved (disabled).',
      );
    } catch (err: unknown) {
      setSchedOk(false);
      setSchedMsg(extractErrorMessage(err, 'Failed to save schedule.'));
    } finally {
      setSchedSaving(false);
    }
  };

  const timezoneOptions = schedule?.allowed_timezones?.length
    ? schedule.allowed_timezones
    : Object.keys(TIMEZONE_LABELS);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-white">
          <CalendarRange size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-slate-900">Job sync</h2>
          <p className="mt-0.5 text-sm leading-snug text-slate-500">
            Manual date-range sync, plus automatic polling on an interval or daily clock time.
            Jobs page <strong>Sync All</strong> is still available for one-off incremental updates.
          </p>

          {loading ? (
            <BrandedLoader compact label="Loading sync settings…" className="mt-2" />
          ) : loadError ? (
            <p className="mt-4 text-sm text-rose-700">{loadError}</p>
          ) : (
            <div className="mt-5 space-y-6">
              {/* ── Scheduled sync ── */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <CalendarClock size={18} className="mt-0.5 text-sky-700" />
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Scheduled sync</h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Runs on the VPS scraper worker. Interval and daily time are fully selectable.
                      </p>
                    </div>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      checked={schedEnabled}
                      onChange={(e) => {
                        setSchedEnabled(e.target.checked);
                        setSchedMsg('');
                      }}
                      className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                    />
                    Enabled
                  </label>
                </div>

                <div className="mt-4 space-y-4">
                  <div>
                    <span className="text-xs font-semibold text-slate-700">Cadence</span>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {(
                        [
                          ['daily', 'Daily at clock time'],
                          ['interval', 'Every N hours'],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            setSchedCadence(value);
                            setSchedMsg('');
                          }}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                            schedCadence === value
                              ? 'border-sky-400 bg-sky-100 text-sky-900'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {schedCadence === 'daily' ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor="sched-daily-time" className="text-xs font-semibold text-slate-700">
                          Run at
                        </label>
                        <input
                          id="sched-daily-time"
                          type="time"
                          value={schedDailyTime}
                          onChange={(e) => {
                            setSchedDailyTime(e.target.value);
                            setSchedMsg('');
                          }}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                        />
                      </div>
                      <div>
                        <label htmlFor="sched-timezone" className="text-xs font-semibold text-slate-700">
                          Timezone
                        </label>
                        <select
                          id="sched-timezone"
                          value={schedTimezone}
                          onChange={(e) => {
                            setSchedTimezone(e.target.value);
                            setSchedMsg('');
                          }}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                        >
                          {timezoneOptions.map((tz) => (
                            <option key={tz} value={tz}>
                              {TIMEZONE_LABELS[tz] || tz}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label htmlFor="sched-interval" className="text-xs font-semibold text-slate-700">
                        Interval (hours)
                      </label>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <input
                          id="sched-interval"
                          type="number"
                          min={1}
                          max={168}
                          value={schedIntervalHours}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            setSchedIntervalHours(Number.isFinite(n) ? n : 1);
                            setSchedMsg('');
                          }}
                          className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {INTERVAL_PRESETS.map((hours) => (
                            <button
                              key={hours}
                              type="button"
                              onClick={() => {
                                setSchedIntervalHours(hours);
                                setSchedMsg('');
                              }}
                              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                                schedIntervalHours === hours
                                  ? 'border-sky-400 bg-sky-100 text-sky-900'
                                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                              }`}
                            >
                              {hours}h
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <span className="text-xs font-semibold text-slate-700">What to poll</span>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {(
                        [
                          ['incremental', 'New since checkpoint (recommended)'],
                          ['date_backfill', 'Recent lookback window'],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            setSchedSyncMode(value);
                            setSchedMsg('');
                          }}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                            schedSyncMode === value
                              ? 'border-sky-400 bg-sky-100 text-sky-900'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {schedSyncMode === 'date_backfill' && (
                      <div className="mt-2 flex items-center gap-2">
                        <label htmlFor="sched-lookback" className="text-xs font-semibold text-slate-700">
                          Lookback days
                        </label>
                        <input
                          id="sched-lookback"
                          type="number"
                          min={1}
                          max={90}
                          value={schedLookbackDays}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            setSchedLookbackDays(Number.isFinite(n) ? n : 1);
                            setSchedMsg('');
                          }}
                          className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                        />
                      </div>
                    )}
                  </div>

                  <PlatformRow
                    platforms={platforms}
                    selected={schedPlatforms}
                    authByPlatform={authByPlatform}
                    onToggle={toggleSchedulePlatform}
                    onSelectAll={() => {
                      setSchedPlatforms(new Set(platforms.map((p) => p.name)));
                      setSchedMsg('');
                    }}
                  />
                  {blockedScheduleSelection.length > 0 && (
                    <p className="text-xs text-rose-700">
                      Schedule platforms need auth: {blockedScheduleSelection.join(', ')}
                    </p>
                  )}

                  {schedule && (
                    <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                      <p>
                        <span className="font-semibold text-slate-700">Next run:</span>{' '}
                        {schedEnabled ? formatWhen(schedule.next_run_at) : '— (disabled)'}
                      </p>
                      <p>
                        <span className="font-semibold text-slate-700">Last run:</span>{' '}
                        {formatWhen(schedule.last_run_at)}
                        {schedule.last_run_status ? ` · ${schedule.last_run_status}` : ''}
                      </p>
                      {schedule.last_run_message && (
                        <p className="sm:col-span-2 text-slate-500">{schedule.last_run_message}</p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSaveSchedule()}
                      disabled={!canSaveSchedule}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {schedSaving ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Save size={14} />
                      )}
                      {schedSaving ? 'Saving…' : 'Save schedule'}
                    </button>
                  </div>
                  {schedMsg && <SectionMessage ok={schedOk} text={schedMsg} />}
                </div>
              </div>

              {/* ── Manual date-range ── */}
              <div>
                <h3 className="text-sm font-bold text-slate-900">Manual date-range sync</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  One-off backfill for a posted-date window.
                </p>

                <div className="mt-4 space-y-4">
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

                  <PlatformRow
                    platforms={platforms}
                    selected={selectedPlatforms}
                    authByPlatform={authByPlatform}
                    onToggle={togglePlatform}
                    onSelectAll={() => {
                      setSelectedPlatforms(new Set(platforms.map((p) => p.name)));
                      setActionMsg('');
                    }}
                  />
                  {blockedSelection.length > 0 && (
                    <p className="text-xs text-rose-700">
                      Selected platforms need auth setup before sync: {blockedSelection.join(', ')}
                    </p>
                  )}

                  {checkpoints.length > 0 && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Saved checkpoint markers
                      </p>
                      <ul className="mt-2 space-y-1 text-xs text-slate-700">
                        {checkpoints.map((cp) => (
                          <li key={cp.spider_name} className="flex flex-wrap gap-x-2">
                            <span className="font-semibold capitalize">{cp.spider_name}</span>
                            <span className="truncate">
                              {formatCheckpointMarkers(cp.marker_job_ids)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {syncing && syncProgress && (
                    <p className="text-xs text-slate-600">{syncProgress.message}</p>
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
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
