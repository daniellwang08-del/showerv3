import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import {
  disconnectJobSite,
  fetchJobSites,
  syncJobSiteNow,
  updateJobSite,
  type JobSiteConnection,
  type JobSitePlugin,
} from '../../api/jobSitesApi';
import { SettingsToggle } from '../shared/SettingsToggle';
import { JobSiteConnectModal } from './JobSiteConnectModal';
import {
  btnPrimary,
  btnSecondary,
  card,
  headingText,
  mutedText,
} from '../../ui/tokens';

function errorDetail(err: unknown, fallback: string): string {
  const detail =
    err && typeof err === 'object' && 'response' in err
      ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
      : null;
  return typeof detail === 'string' ? detail : fallback;
}

function formatSyncedAt(iso: string | null): string {
  if (!iso) return 'Not synced yet';
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return 'Not synced yet';
  return `Synced ${date.toLocaleString()}`;
}

const AUTH_BADGE: Record<string, string> = {
  account: 'Account',
  api_key: 'API key',
  none: 'Open',
  unavailable: 'Not available',
};

export function JobSiteTiles() {
  const [plugins, setPlugins] = useState<JobSitePlugin[]>([]);
  const [connections, setConnections] = useState<JobSiteConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [active, setActive] = useState<JobSitePlugin | null>(null);

  const bySlug = useMemo(() => {
    const map = new Map<string, JobSiteConnection>();
    connections.forEach((c) => map.set(c.plugin_slug, c));
    return map;
  }, [connections]);

  const load = useCallback(async () => {
    try {
      const data = await fetchJobSites();
      setPlugins(data.plugins);
      setConnections(data.connections);
      setError('');
    } catch {
      setError('Failed to load job sites.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const handleToggle = async (plugin: JobSitePlugin, connection: JobSiteConnection) => {
    setBusySlug(plugin.slug);
    setError('');
    try {
      const updated = await updateJobSite(plugin.slug, { enabled: !connection.enabled });
      setConnections((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to update this job site.'));
    } finally {
      setBusySlug(null);
    }
  };

  const handleDisconnect = async (plugin: JobSitePlugin) => {
    setBusySlug(plugin.slug);
    setError('');
    try {
      await disconnectJobSite(plugin.slug);
      setConnections((prev) => prev.filter((c) => c.plugin_slug !== plugin.slug));
      setNotice(`${plugin.name} disconnected.`);
      setActive(null);
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to disconnect this job site.'));
    } finally {
      setBusySlug(null);
    }
  };

  const handleSync = async (plugin: JobSitePlugin) => {
    setBusySlug(plugin.slug);
    setError('');
    try {
      await syncJobSiteNow(plugin.slug);
      setNotice(`Sync started for ${plugin.name}. New jobs appear on your dashboard shortly.`);
      window.setTimeout(() => void load(), 8000);
    } catch (err: unknown) {
      setError(errorDetail(err, 'Failed to start the sync.'));
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className={`text-sm font-bold ${headingText}`}>Job sites</h2>
        <p className={`mt-0.5 text-xs ${mutedText}`}>
          Connect boards with your account, API keys, or public feeds. Account sites open in a new
          tab — if you are already signed in there, we detect it and connect automatically.
        </p>
      </div>

      {loading ? (
        <p className={`flex items-center gap-1.5 text-sm ${mutedText}`}>
          <Loader2 size={14} className="animate-spin" /> Loading job sites…
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {plugins.map((plugin) => {
            const connection = bySlug.get(plugin.slug);
            const busy = busySlug === plugin.slug;
            return (
              <JobSiteTile
                key={plugin.slug}
                plugin={plugin}
                connection={connection}
                busy={busy}
                onOpen={() => setActive(plugin)}
                onToggle={() => connection && void handleToggle(plugin, connection)}
                onSync={() => void handleSync(plugin)}
              />
            );
          })}
        </div>
      )}

      {notice ? (
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{notice}</p>
      ) : null}
      {error ? (
        <p className={`flex items-center gap-1.5 text-sm font-medium text-rose-700 dark:text-rose-400`}>
          <AlertCircle size={16} />
          {error}
        </p>
      ) : null}

      {active ? (
        <JobSiteConnectModal
          plugin={active}
          connection={bySlug.get(active.slug) ?? null}
          busy={busySlug === active.slug}
          onClose={() => setActive(null)}
          onConnected={(row) => {
            setConnections((prev) => {
              const next = prev.filter((c) => c.plugin_slug !== row.plugin_slug);
              next.push(row);
              return next;
            });
            setNotice(
              `${active.name} connected — first sync started. New jobs appear on your dashboard shortly.`,
            );
            setActive(null);
          }}
          onDisconnect={() => void handleDisconnect(active)}
          onBusy={setBusySlug}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function JobSiteTile({
  plugin,
  connection,
  busy,
  onOpen,
  onToggle,
  onSync,
}: {
  plugin: JobSitePlugin;
  connection?: JobSiteConnection;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onSync: () => void;
}) {
  const connected = Boolean(connection);
  const unavailable = !plugin.connectable;
  return (
    <article
      className={`flex h-full flex-col p-3.5 ${card} ${unavailable ? 'opacity-80' : ''}`}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200/80 dark:bg-[var(--app-input)] dark:ring-white/10">
          <img src={plugin.logo_src} alt="" className="h-6 w-6 object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className={`truncate text-sm font-bold ${headingText}`}>{plugin.name}</h3>
            <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-white/10 dark:text-slate-300">
              {AUTH_BADGE[plugin.auth_type] ?? plugin.auth_type}
            </span>
          </div>
          <p className={`mt-0.5 line-clamp-2 text-xs leading-snug ${mutedText}`}>{plugin.blurb}</p>
        </div>
      </div>

      {connection?.last_error ? (
        <p className="mt-2 line-clamp-2 text-[11px] text-rose-600 dark:text-rose-400">
          {connection.last_error}
        </p>
      ) : connected ? (
        <p className={`mt-2 text-[11px] ${mutedText}`}>
          {formatSyncedAt(connection?.last_synced_at ?? null)}
          {connection?.last_listing_count != null ? ` · ${connection.last_listing_count} listings` : ''}
        </p>
      ) : (
        <div className="mt-2" />
      )}

      <div className="mt-auto flex items-center gap-1.5 pt-3">
        {unavailable ? (
          <button type="button" onClick={onOpen} className={`${btnSecondary} w-full`}>
            <WifiOff size={14} />
            Why not
          </button>
        ) : connected ? (
          <>
            <SettingsToggle
              checked={Boolean(connection?.enabled)}
              disabled={busy}
              onChange={onToggle}
              aria-label={connection?.enabled ? 'Pause auto-sync' : 'Resume auto-sync'}
            />
            <button
              type="button"
              onClick={onSync}
              disabled={busy || !connection?.enabled}
              className={`${btnSecondary} !h-9 !w-9 !px-0`}
              title="Sync now"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
            <button type="button" onClick={onOpen} className={`${btnSecondary} flex-1`}>
              Manage
            </button>
          </>
        ) : (
          <button type="button" onClick={onOpen} disabled={busy} className={`${btnPrimary} w-full`}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            Connect
          </button>
        )}
      </div>
    </article>
  );
}
