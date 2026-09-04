import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Clock3,
  Filter,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { BrandedLoader } from '../components/layout/BrandedLoader';
import { Pagination } from '../components/shared/Pagination';
import { ConfirmDialog } from '../components/extraction/ConfirmDialog';
import {
  fetchRequestTimeline,
  fetchSystemLogStats,
  fetchSystemLogs,
  purgeSystemLogs,
} from '../api/systemLogsApi';
import type { SystemLogEvent, SystemLogStats } from '../types/systemLogs';
import { btnGhost, btnPrimary, btnSecondary, card, input, mutedText, pagePad } from '../ui/tokens';

const LEVELS = ['', 'debug', 'info', 'warning', 'error', 'critical'] as const;
const CATEGORIES = ['', 'http', 'worker', 'process', 'system'] as const;
const SERVICES = [
  '',
  'api',
  'extraction',
  'analysis',
  'tailoring',
  'save',
  'resume',
  'autopost',
  'scraper',
  'encoding',
] as const;
const HOUR_WINDOWS = [1, 6, 24, 72, 168] as const;

function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof msg === 'string' ? msg : fallback;
}

function levelClass(level: string): string {
  switch (level) {
    case 'error':
    case 'critical':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200';
    case 'warning':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200';
    case 'debug':
      return 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300';
    default:
      return 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200';
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).toLocaleString();
  } catch {
    return iso;
  }
}

function StatChip({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className={`${card} px-4 py-3`}>
      <p className={`text-[11px] font-semibold uppercase tracking-wide ${mutedText}`}>{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">{value}</p>
      {hint ? <p className={`mt-0.5 text-xs ${mutedText}`}>{hint}</p> : null}
    </div>
  );
}

export function SystemLogsPage() {
  const [hours, setHours] = useState(24);
  const [level, setLevel] = useState('');
  const [category, setCategory] = useState('');
  const [service, setService] = useState('');
  const [pathContains, setPathContains] = useState('');
  const [eventContains, setEventContains] = useState('');
  const [requestId, setRequestId] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);

  const [items, setItems] = useState<SystemLogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [stats, setStats] = useState<SystemLogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [timelineId, setTimelineId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<SystemLogEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [selected, setSelected] = useState<SystemLogEvent | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState('');

  const load = useCallback(
    async (opts?: { soft?: boolean }) => {
      if (opts?.soft) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const [list, st] = await Promise.all([
          fetchSystemLogs({
            page,
            per_page: perPage,
            hours,
            level: level || undefined,
            category: category || undefined,
            service: service || undefined,
            path_contains: pathContains.trim() || undefined,
            event_contains: eventContains.trim() || undefined,
            request_id: requestId.trim() || undefined,
          }),
          fetchSystemLogStats(hours),
        ]);
        setItems(list.items);
        setTotal(list.total);
        setPages(list.pages);
        setPage(list.page);
        setStats(st);
      } catch (e: unknown) {
        setError(errDetail(e, 'Failed to load system logs'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [page, perPage, hours, level, category, service, pathContains, eventContains, requestId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openTimeline = async (rid: string) => {
    setTimelineId(rid);
    setTimeline([]);
    setTimelineLoading(true);
    try {
      setTimeline(await fetchRequestTimeline(rid));
    } catch (e: unknown) {
      setError(errDetail(e, 'Failed to load request timeline'));
      setTimelineId(null);
    } finally {
      setTimelineLoading(false);
    }
  };

  const runPurge = async () => {
    setPurgeBusy(true);
    setPurgeError('');
    try {
      await purgeSystemLogs();
      setPurgeOpen(false);
      setPage(1);
      await load({ soft: true });
    } catch (e: unknown) {
      setPurgeError(errDetail(e, 'Purge failed'));
    } finally {
      setPurgeBusy(false);
    }
  };

  if (loading && !items.length) {
    return <BrandedLoader fullscreen label="Loading system logs…" />;
  }

  return (
    <PageScrollArea>
      <div className={pagePad}>
        <PageHeader
          icon={ScrollText}
          gradient="from-slate-700 to-sky-600"
          title="System Logs"
          description="Request/response lifecycle, worker tasks, and process events across the platform."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={btnSecondary}
                onClick={() => void load({ soft: true })}
                disabled={refreshing}
              >
                {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh
              </button>
              <button type="button" className={btnGhost} onClick={() => setPurgeOpen(true)}>
                <Trash2 size={16} />
                Purge old
              </button>
            </div>
          }
        />

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatChip label="Events" value={stats?.total ?? total} hint={`Last ${hours}h`} />
          <StatChip label="Error rate" value={`${stats?.error_rate ?? 0}%`} hint="error + critical" />
          <StatChip
            label="HTTP"
            value={stats?.by_category?.http ?? 0}
            hint={`Workers: ${stats?.by_category?.worker ?? 0}`}
          />
          <StatChip
            label="Retention"
            value={`${stats?.retention_days ?? 14}d`}
            hint="Auto-purged on API start"
          />
        </div>

        <div className={`${card} space-y-3 p-3 sm:p-4`}>
          <div className={`flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white`}>
            <Filter size={16} />
            Filters
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Window
              <select
                className={`${input} mt-1`}
                value={hours}
                onChange={(e) => {
                  setPage(1);
                  setHours(Number(e.target.value));
                }}
              >
                {HOUR_WINDOWS.map((h) => (
                  <option key={h} value={h}>
                    Last {h}h
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Level
              <select
                className={`${input} mt-1`}
                value={level}
                onChange={(e) => {
                  setPage(1);
                  setLevel(e.target.value);
                }}
              >
                {LEVELS.map((l) => (
                  <option key={l || 'all'} value={l}>
                    {l || 'All levels'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Category
              <select
                className={`${input} mt-1`}
                value={category}
                onChange={(e) => {
                  setPage(1);
                  setCategory(e.target.value);
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c || 'all'} value={c}>
                    {c || 'All categories'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Service
              <select
                className={`${input} mt-1`}
                value={service}
                onChange={(e) => {
                  setPage(1);
                  setService(e.target.value);
                }}
              >
                {SERVICES.map((s) => (
                  <option key={s || 'all'} value={s}>
                    {s || 'All services'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 sm:col-span-2">
              Path contains
              <div className="relative mt-1">
                <Search size={14} className={`absolute left-3 top-1/2 -translate-y-1/2 ${mutedText}`} />
                <input
                  className={`${input} pl-8`}
                  value={pathContains}
                  placeholder="/api/v1/…"
                  onChange={(e) => setPathContains(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setPage(1);
                      void load({ soft: true });
                    }
                  }}
                />
              </div>
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 sm:col-span-2">
              Event contains
              <input
                className={`${input} mt-1`}
                value={eventContains}
                placeholder="http_request_completed"
                onChange={(e) => setEventContains(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setPage(1);
                    void load({ soft: true });
                  }
                }}
              />
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 sm:col-span-2">
              Request ID
              <input
                className={`${input} mt-1 font-mono text-xs`}
                value={requestId}
                placeholder="uuid…"
                onChange={(e) => setRequestId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setPage(1);
                    void load({ soft: true });
                  }
                }}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                setPage(1);
                void load({ soft: true });
              }}
            >
              Apply filters
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setLevel('');
                setCategory('');
                setService('');
                setPathContains('');
                setEventContains('');
                setRequestId('');
                setPage(1);
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {stats && Object.keys(stats.by_service).length > 0 ? (
          <div className={`${card} p-3 sm:p-4`}>
            <p className={`mb-2 text-xs font-semibold uppercase tracking-wide ${mutedText}`}>
              By service ({hours}h)
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.by_service)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setService(name);
                      setPage(1);
                    }}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-sky-300 hover:bg-sky-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
                  >
                    {name} · {count}
                  </button>
                ))}
            </div>
          </div>
        ) : null}

        <div className={`${card} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Time</th>
                  <th className="px-3 py-2.5 font-semibold">Level</th>
                  <th className="px-3 py-2.5 font-semibold">Cat</th>
                  <th className="px-3 py-2.5 font-semibold">Event / HTTP</th>
                  <th className="px-3 py-2.5 font-semibold">Service</th>
                  <th className="px-3 py-2.5 font-semibold">Request</th>
                  <th className="px-3 py-2.5 font-semibold">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className={`px-3 py-10 text-center ${mutedText}`}>
                      No log events match these filters yet.
                    </td>
                  </tr>
                ) : (
                  items.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer hover:bg-slate-50/80 dark:hover:bg-white/5"
                      onClick={() => setSelected(row)}
                    >
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                        {formatTime(row.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase ${levelClass(row.level)}`}
                        >
                          {row.level}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                        {row.category}
                      </td>
                      <td className="max-w-[28rem] px-3 py-2">
                        <div className="truncate font-medium text-slate-900 dark:text-white">
                          {row.event}
                        </div>
                        {(row.method || row.path) && (
                          <div className={`truncate font-mono text-xs ${mutedText}`}>
                            {[row.method, row.path, row.status_code != null ? `→ ${row.status_code}` : '']
                              .filter(Boolean)
                              .join(' ')}
                          </div>
                        )}
                        {row.message ? (
                          <div className={`truncate text-xs ${mutedText}`}>{row.message}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                        {row.service}
                      </td>
                      <td className="px-3 py-2">
                        {row.request_id ? (
                          <button
                            type="button"
                            className="font-mono text-[11px] text-sky-700 hover:underline dark:text-sky-300"
                            title="Open request timeline"
                            onClick={(e) => {
                              e.stopPropagation();
                              void openTimeline(row.request_id!);
                            }}
                          >
                            {row.request_id.slice(0, 8)}…
                          </button>
                        ) : (
                          <span className={mutedText}>—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-xs text-slate-600 dark:text-slate-300">
                        {row.duration_ms != null ? `${row.duration_ms} ms` : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pages={pages}
            total={total}
            perPage={perPage}
            onPageChange={setPage}
            onPerPageChange={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        </div>
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
          <div className={`${card} max-h-[85vh] w-full max-w-2xl overflow-hidden shadow-xl`}>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-white/10">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">{selected.event}</p>
                <p className={`text-xs ${mutedText}`}>{formatTime(selected.created_at)}</p>
              </div>
              <button type="button" className={btnGhost} onClick={() => setSelected(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                {(
                  [
                    ['Level', selected.level],
                    ['Category', selected.category],
                    ['Service', selected.service],
                    ['Logger', selected.logger_name],
                    ['Request ID', selected.request_id],
                    ['User ID', selected.user_id],
                    ['Job ID', selected.job_id],
                    ['Method', selected.method],
                    ['Path', selected.path],
                    ['Status', selected.status_code != null ? String(selected.status_code) : null],
                    ['Duration', selected.duration_ms != null ? `${selected.duration_ms} ms` : null],
                    ['Client IP', selected.client_ip],
                  ] as const
                ).map(([k, v]) =>
                  v ? (
                    <div key={k} className="contents">
                      <dt className={mutedText}>{k}</dt>
                      <dd className="break-all font-mono text-slate-800 dark:text-slate-200">{v}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
              {selected.message ? (
                <p className="rounded-lg bg-slate-50 p-3 text-slate-700 dark:bg-white/5 dark:text-slate-200">
                  {selected.message}
                </p>
              ) : null}
              {selected.payload ? (
                <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              ) : null}
              {selected.request_id ? (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    const rid = selected.request_id!;
                    setSelected(null);
                    void openTimeline(rid);
                  }}
                >
                  <Clock3 size={16} />
                  View full request timeline
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {timelineId ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
          <div className={`${card} max-h-[85vh] w-full max-w-3xl overflow-hidden shadow-xl`}>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-white/10">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Request timeline</p>
                <p className="font-mono text-xs text-sky-700 dark:text-sky-300">{timelineId}</p>
              </div>
              <button
                type="button"
                className={btnGhost}
                onClick={() => setTimelineId(null)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-4">
              {timelineLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-slate-500">
                  <Loader2 className="animate-spin" size={18} />
                  Loading timeline…
                </div>
              ) : timeline.length === 0 ? (
                <p className={`py-8 text-center ${mutedText}`}>No events for this request id.</p>
              ) : (
                <ol className="relative space-y-3 border-l border-slate-200 pl-4 dark:border-white/10">
                  {timeline.map((ev) => (
                    <li key={ev.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-sky-500" />
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase ${levelClass(ev.level)}`}
                        >
                          {ev.level}
                        </span>
                        <span className="text-sm font-medium text-slate-900 dark:text-white">
                          {ev.event}
                        </span>
                        <span className={`text-xs ${mutedText}`}>{formatTime(ev.created_at)}</span>
                      </div>
                      {(ev.method || ev.path) && (
                        <p className={`mt-0.5 font-mono text-xs ${mutedText}`}>
                          {[ev.method, ev.path, ev.status_code != null ? `→ ${ev.status_code}` : '']
                            .filter(Boolean)
                            .join(' ')}
                          {ev.duration_ms != null ? ` · ${ev.duration_ms} ms` : ''}
                        </p>
                      )}
                      {ev.message ? <p className={`mt-1 text-xs ${mutedText}`}>{ev.message}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={purgeOpen}
        title="Purge old system logs?"
        description={`Delete log events older than the retention window (${stats?.retention_days ?? 14} days). Recent activity is kept.`}
        confirmLabel="Purge"
        cancelLabel="Cancel"
        variant="danger"
        loading={purgeBusy}
        error={purgeError}
        onConfirm={() => void runPurge()}
        onCancel={() => setPurgeOpen(false)}
      />
    </PageScrollArea>
  );
}
