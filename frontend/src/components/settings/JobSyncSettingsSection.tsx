import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  Loader2,
  OctagonX,
  RefreshCw,
  Save,
} from 'lucide-react';
import {
  fetchJobSyncSchedule,
  fetchSyncCheckpoints,
  fetchSyncPlatforms,
  saveJobSyncSchedule,
  stopJobFetch,
} from '../../api/scraperApi';
import type { JobSyncSchedule, SyncCheckpoint, SyncPlatform } from '../../types/scraper';
import { useScraperStore } from '../../stores/scraperStore';
import { BrandedLoader } from '../layout/BrandedLoader';
import { SettingsToggle } from '../shared/SettingsToggle';

const INTERVAL_PRESETS = [1, 2, 4, 6, 8, 12, 24] as const;

const TIMEZONE_LABELS: Record<string, string> = {
  'America/Los_Angeles': 'Pacific (Los Angeles)',
  'America/New_York': 'Eastern (New York)',
  'America/Chicago': 'Central (Chicago)',
  'America/Denver': 'Mountain (Denver)',
  UTC: 'UTC',
};

type SyncPanelMode = 'scheduled' | 'manual';

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
      className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
        ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'
      }`}
    >
      {ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
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

const fieldClass =
  'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-[#0b1220] dark:text-slate-100 dark:focus:border-sky-500 dark:focus:ring-sky-500/30';

const chipClass = (active: boolean) =>
  [
    'rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition',
    active
      ? 'border-sky-400 bg-sky-100 text-sky-900 dark:border-sky-400/50 dark:bg-sky-500/20 dark:text-sky-200'
      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-600 dark:bg-[#0b1220] dark:text-slate-300 dark:hover:border-slate-500',
  ].join(' ');

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
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Platforms
        </span>
        <button
          type="button"
          onClick={onSelectAll}
          className="text-xs font-semibold text-sky-700 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-200"
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
              className={[
                'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm whitespace-nowrap transition',
                checked
                  ? 'border-sky-300 bg-sky-50/70 dark:border-sky-400/40 dark:bg-sky-500/10'
                  : 'border-slate-200 bg-white dark:border-slate-600 dark:bg-[#0b1220]',
                !authOk ? 'opacity-70' : '',
              ].join(' ')}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(platform.name)}
                className="shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
              />
              <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">{platform.label}</span>
              {platform.requires_auth && (
                <span
                  className={`shrink-0 text-[10px] font-semibold ${
                    authOk ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'
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

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: SyncPanelMode;
  onChange: (next: SyncPanelMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Sync mode"
      className="inline-flex w-full rounded-xl border border-slate-200 bg-slate-100/80 p-1 dark:border-slate-600 dark:bg-[#0b1220] sm:w-auto"
    >
      {(
        [
          { id: 'scheduled' as const, label: 'Scheduled', icon: CalendarClock },
          { id: 'manual' as const, label: 'Manual date range', icon: CalendarRange },
        ] as const
      ).map(({ id, label, icon: Icon }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={[
              'inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition sm:flex-none sm:px-4',
              active
                ? 'bg-white text-sky-800 shadow-sm dark:bg-slate-700 dark:text-sky-200'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
            ].join(' ')}
          >
            <Icon size={14} className="shrink-0" />
            {label}
          </button>
        );
      })}
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
  const [panelMode, setPanelMode] = useState<SyncPanelMode>('scheduled');
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);

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
  const [stopping, setStopping] = useState(false);
  const [stopMsg, setStopMsg] = useState('');
  const [stopOk, setStopOk] = useState(false);

  const authByPlatform = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const spider of spiders) {
      map.set(
        spider.name,
        !spider.requires_auth || spider.auth_optional === true || spider.auth_configured,
      );
    }
    return map;
  }, [spiders]);

  const activePlatforms = panelMode === 'scheduled' ? schedPlatforms : selectedPlatforms;

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

  useEffect(() => {
    void checkSyncStatus();
    const id = window.setInterval(() => {
      void checkSyncStatus();
    }, 4000);
    return () => window.clearInterval(id);
  }, [checkSyncStatus]);

  const canStop = syncing && !stopping;

  const toggleActivePlatform = (name: string) => {
    if (panelMode === 'scheduled') {
      setSchedPlatforms((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      setSchedMsg('');
      return;
    }
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setActionMsg('');
  };

  const selectAllActivePlatforms = () => {
    const all = new Set(platforms.map((p) => p.name));
    if (panelMode === 'scheduled') {
      setSchedPlatforms(all);
      setSchedMsg('');
      return;
    }
    setSelectedPlatforms(all);
    setActionMsg('');
  };

  const handleRunDateSync = async () => {
    if (!canRun) return;
    setRunning(true);
    setActionMsg('');
    setActionOk(false);
    try {
      await useScraperStore.getState().startSync({
        spider_name: 'all',
        sync_mode: 'date_backfill',
        spider_names: selectedList,
        posted_since: postedSince,
        posted_until: postedUntil || undefined,
      });
      const { syncing: stillSyncing, syncStatus: status } = useScraperStore.getState();
      void checkSyncStatus();
      if (!stillSyncing) {
        throw new Error('Failed to queue date-range sync.');
      }
      setActionOk(true);
      setActionMsg(status?.message || 'Date-range sync queued.');
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

  const handleStopFetching = async () => {
    if (!canStop) return;
    setStopping(true);
    setStopMsg('');
    setStopOk(false);
    try {
      const res = await stopJobFetch();
      useScraperStore.setState({
        syncing: false,
        syncProgress: null,
        syncStatus: {
          status: 'idle',
          spider_name: null,
          message: res.message || 'Job fetching stopped.',
        },
      });
      if (res.schedule_disabled || schedEnabled) {
        setSchedEnabled(false);
        if (schedule) {
          setSchedule({
            ...schedule,
            enabled: false,
            next_run_at: null,
          });
        }
      }
      void checkSyncStatus();
      setStopOk(true);
      setStopMsg(res.message || 'Job fetching stopped.');
    } catch (err: unknown) {
      setStopOk(false);
      setStopMsg(extractErrorMessage(err, 'Failed to stop job fetching.'));
    } finally {
      setStopping(false);
    }
  };

  const timezoneOptions = schedule?.allowed_timezones?.length
    ? schedule.allowed_timezones
    : Object.keys(TIMEZONE_LABELS);

  const blockedActive =
    panelMode === 'scheduled' ? blockedScheduleSelection : blockedSelection;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-500/30 dark:bg-[#0f172a]/80 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white">
          <CalendarRange size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Job sync</h2>
              <p className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
                Schedule automatic polling or run a one-off date backfill. Jobs page Sync All still
                handles quick incremental updates.
              </p>
            </div>
            {!loading && !loadError && (
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-[#0b1220] dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <RefreshCw size={12} />
                Refresh
              </button>
            )}
          </div>

          {loading ? (
            <BrandedLoader compact label="Loading sync settings…" className="mt-2" />
          ) : loadError ? (
            <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{loadError}</p>
          ) : (
            <div className="mt-3 space-y-3">
              {/* Stop strip — compact; emphasized only while a run is active */}
              <div
                className={[
                  'flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2',
                  syncing
                    ? 'border-rose-300 bg-rose-50/90 dark:border-rose-400/40 dark:bg-rose-500/10'
                    : 'border-slate-200 bg-slate-50/80 dark:border-slate-600 dark:bg-slate-200/5',
                ].join(' ')}
              >
                <div className="min-w-0">
                  <p
                    className={[
                      'text-xs font-bold',
                      syncing
                        ? 'text-rose-900 dark:text-rose-200'
                        : 'text-slate-700 dark:text-slate-300',
                    ].join(' ')}
                  >
                    {syncing ? 'Fetch in progress' : 'Stop job fetching'}
                  </p>
                  <p
                    className={[
                      'text-[11px] leading-snug',
                      syncing
                        ? 'text-rose-800/90 dark:text-rose-200/80'
                        : 'text-slate-500 dark:text-slate-400',
                    ].join(' ')}
                  >
                    {syncing
                      ? syncProgress?.message ||
                        syncProgress?.spiderName ||
                        'Stops the current scrape, skips remaining platforms, and disables the schedule.'
                      : 'Available while a sync is queued or running.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleStopFetching()}
                  disabled={!canStop}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-rose-600 dark:hover:bg-rose-500"
                >
                  {stopping ? <Loader2 size={13} className="animate-spin" /> : <OctagonX size={13} />}
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              </div>
              {stopMsg && <SectionMessage ok={stopOk} text={stopMsg} />}

              {/* Mode toggle + shared body */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-600 dark:bg-[#0b1220]/50 sm:p-3.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <ModeSwitch
                    mode={panelMode}
                    onChange={(next) => {
                      setPanelMode(next);
                      setActionMsg('');
                      setSchedMsg('');
                    }}
                  />
                  {panelMode === 'scheduled' && (
                    <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                      <SettingsToggle
                        checked={schedEnabled}
                        onChange={(next) => {
                          setSchedEnabled(next);
                          setSchedMsg('');
                        }}
                        aria-label="Enable scheduled sync"
                      />
                      Auto-run {schedEnabled ? 'on' : 'off'}
                    </label>
                  )}
                </div>

                {/* Mode-specific controls — dense horizontal rows */}
                {panelMode === 'scheduled' ? (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[9rem]">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Cadence
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {(
                            [
                              ['daily', 'Daily'],
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
                              className={chipClass(schedCadence === value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {schedCadence === 'daily' ? (
                        <>
                          <div>
                            <label
                              htmlFor="sched-daily-time"
                              className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                            >
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
                              className={`mt-1 block w-[7.5rem] ${fieldClass}`}
                            />
                          </div>
                          <div className="min-w-[10rem] flex-1">
                            <label
                              htmlFor="sched-timezone"
                              className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                            >
                              Timezone
                            </label>
                            <select
                              id="sched-timezone"
                              value={schedTimezone}
                              onChange={(e) => {
                                setSchedTimezone(e.target.value);
                                setSchedMsg('');
                              }}
                              className={`mt-1 w-full ${fieldClass}`}
                            >
                              {timezoneOptions.map((tz) => (
                                <option key={tz} value={tz}>
                                  {TIMEZONE_LABELS[tz] || tz}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      ) : (
                        <div className="min-w-0 flex-1">
                          <label
                            htmlFor="sched-interval"
                            className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                          >
                            Interval
                          </label>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
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
                              className={`w-16 ${fieldClass}`}
                            />
                            <span className="text-xs text-slate-500 dark:text-slate-400">hours</span>
                            {INTERVAL_PRESETS.map((hours) => (
                              <button
                                key={hours}
                                type="button"
                                onClick={() => {
                                  setSchedIntervalHours(hours);
                                  setSchedMsg('');
                                }}
                                className={chipClass(schedIntervalHours === hours)}
                              >
                                {hours}h
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          What to pull
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {(
                            [
                              ['incremental', 'Since checkpoint'],
                              ['date_backfill', 'Lookback window'],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => {
                                setSchedSyncMode(value);
                                setSchedMsg('');
                              }}
                              className={chipClass(schedSyncMode === value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {schedSyncMode === 'date_backfill' && (
                        <div>
                          <label
                            htmlFor="sched-lookback"
                            className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                          >
                            Days
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
                            className={`mt-1 block w-20 ${fieldClass}`}
                          />
                        </div>
                      )}
                    </div>

                    {schedule && (
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Next:</span>{' '}
                        {schedEnabled ? formatWhen(schedule.next_run_at) : '— (disabled)'}
                        <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Last:</span>{' '}
                        {formatWhen(schedule.last_run_at)}
                        {schedule.last_run_status ? ` · ${schedule.last_run_status}` : ''}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <label
                          htmlFor="sync-posted-since"
                          className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                        >
                          Posted since
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
                          className={`mt-1 block ${fieldClass}`}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="sync-posted-until"
                          className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                        >
                          Posted until
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
                          className={`mt-1 block ${fieldClass}`}
                        />
                      </div>
                      <div className="flex flex-wrap gap-1.5 pb-0.5">
                        {[7, 14, 30, 60].map((days) => (
                          <button
                            key={days}
                            type="button"
                            onClick={() => {
                              setPostedSince(daysAgoIsoDate(days));
                              setPostedUntil(todayIsoDate());
                              setActionMsg('');
                            }}
                            className={chipClass(false)}
                          >
                            Last {days}d
                          </button>
                        ))}
                      </div>
                    </div>

                    {checkpoints.length > 0 && (
                      <div className="rounded-lg border border-slate-200 dark:border-slate-600">
                        <button
                          type="button"
                          onClick={() => setCheckpointsOpen((v) => !v)}
                          className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                        >
                          Checkpoint markers
                          <ChevronDown
                            size={14}
                            className={`transition ${checkpointsOpen ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {checkpointsOpen && (
                          <ul className="space-y-1 border-t border-slate-200 px-2.5 py-2 text-xs text-slate-700 dark:border-slate-600 dark:text-slate-300">
                            {checkpoints.map((cp) => (
                              <li key={cp.spider_name} className="flex flex-wrap gap-x-2">
                                <span className="font-semibold capitalize">{cp.spider_name}</span>
                                <span className="truncate text-slate-500 dark:text-slate-400">
                                  {formatCheckpointMarkers(cp.marker_job_ids)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Shared platforms — one row for whichever mode is active */}
                <div className="mt-3 border-t border-slate-200/80 pt-3 dark:border-slate-600/80">
                  <PlatformRow
                    platforms={platforms}
                    selected={activePlatforms}
                    authByPlatform={authByPlatform}
                    onToggle={toggleActivePlatform}
                    onSelectAll={selectAllActivePlatforms}
                  />
                  {blockedActive.length > 0 && (
                    <p className="mt-1.5 text-xs text-rose-700 dark:text-rose-300">
                      Auth required: {blockedActive.join(', ')}
                    </p>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-3 dark:border-slate-600/80">
                  {panelMode === 'scheduled' ? (
                    <button
                      type="button"
                      onClick={() => void handleSaveSchedule()}
                      disabled={!canSaveSchedule}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500"
                    >
                      {schedSaving ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Save size={14} />
                      )}
                      {schedSaving ? 'Saving…' : 'Save schedule'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleRunDateSync()}
                      disabled={!canRun}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500"
                    >
                      {running || syncing ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      {running || syncing ? 'Sync running…' : 'Run date-range sync'}
                    </button>
                  )}
                </div>

                {panelMode === 'scheduled'
                  ? schedMsg && <SectionMessage ok={schedOk} text={schedMsg} />
                  : actionMsg && <SectionMessage ok={actionOk} text={actionMsg} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
