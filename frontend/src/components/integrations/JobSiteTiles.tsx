import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Unplug,
  WifiOff,
} from 'lucide-react';
import {
  connectJobSite,
  disconnectJobSite,
  fetchJobSites,
  syncJobSiteNow,
  updateJobSite,
  type JobSiteConnection,
  type JobSitePlugin,
} from '../../api/jobSitesApi';
import { InstallExtensionModal } from '../scraper/InstallExtensionModal';
import { SettingsToggle } from '../shared/SettingsToggle';
import { Z_INDEX } from '../../constants/zIndex';
import { captureJobSiteSession, detectExtension } from '../../lib/extensionBridge';
import {
  bodyText,
  btnDanger,
  btnPrimary,
  btnSecondary,
  card,
  headingText,
  input,
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
  session: 'Sign in',
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
  const [installOpen, setInstallOpen] = useState(false);

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
          Connect boards with your account, API keys, or session cookies. New openings are pulled
          into your pipeline automatically every few hours.
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
          onNeedExtension={() => setInstallOpen(true)}
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

      <InstallExtensionModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={() => setInstallOpen(false)}
      />
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
          <button type="button" onClick={onOpen} className={`${btnPrimary} w-full`}>
            Connect
          </button>
        )}
      </div>
    </article>
  );
}

function JobSiteConnectModal({
  plugin,
  connection,
  busy,
  onClose,
  onNeedExtension,
  onConnected,
  onDisconnect,
  onBusy,
  onError,
}: {
  plugin: JobSitePlugin;
  connection: JobSiteConnection | null;
  busy: boolean;
  onClose: () => void;
  onNeedExtension: () => void;
  onConnected: (row: JobSiteConnection) => void;
  onDisconnect: () => void;
  onBusy: (slug: string | null) => void;
  onError: (msg: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const submitCredentials = async (extra?: { cookies?: unknown[] }) => {
    onBusy(plugin.slug);
    setLocalError('');
    onError('');
    try {
      const row = await connectJobSite(plugin.slug, {
        credentials: values,
        ...(extra?.cookies ? { cookies: extra.cookies } : {}),
      });
      onConnected(row);
    } catch (err: unknown) {
      setLocalError(errorDetail(err, `Failed to connect ${plugin.name}.`));
    } finally {
      onBusy(null);
    }
  };

  const handleCapture = async () => {
    setCapturing(true);
    setLocalError('');
    const result = await captureJobSiteSession(
      plugin.slug,
      plugin.cookie_domains,
      plugin.host_origins,
    );
    if (!result.ok || !result.cookies?.length) {
      const installed = await detectExtension(800, true);
      if (!installed.installed || result.error === 'timed_out') {
        setCapturing(false);
        onNeedExtension();
        return;
      }
      setCapturing(false);
      setLocalError(
        result.error === 'permission_denied'
          ? 'Cookie permission was denied. Allow it when Chrome asks, then try again.'
          : 'No session cookies found. Sign in on the site in this browser, then capture again.',
      );
      return;
    }
    await submitCredentials({ cookies: result.cookies });
    setCapturing(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-900/50 p-3 sm:p-4 backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.confirmDialog }}
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`w-full max-w-md p-5 ${card}`}>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200/80 dark:bg-[var(--app-input)] dark:ring-white/10">
            <img src={plugin.logo_src} alt="" className="h-7 w-7 object-contain" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className={`text-base font-bold ${headingText}`}>{plugin.name}</h3>
            <p className={`mt-0.5 text-xs leading-snug ${mutedText}`}>{plugin.blurb}</p>
          </div>
        </div>

        <div className={`mt-4 space-y-3 text-sm ${bodyText}`}>
          {!plugin.connectable ? (
            <p className={mutedText}>{plugin.unavailable_reason}</p>
          ) : plugin.auth_type === 'session' ? (
            <ol className={`list-decimal space-y-1.5 pl-4 text-xs ${mutedText}`}>
              <li>Install the Atomspace extension if you have not already.</li>
              <li>
                Open {plugin.name} and sign in with your account.{' '}
                {plugin.login_url ? (
                  <a
                    href={plugin.login_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-sky-600 hover:underline"
                  >
                    Open sign-in
                    <ExternalLink size={11} className="ml-0.5 inline" />
                  </a>
                ) : null}
              </li>
              <li>Return here and capture the live session cookies so we can pull your job list.</li>
            </ol>
          ) : plugin.auth_type === 'api_key' ? (
            <div className="space-y-2.5">
              {plugin.credential_fields.map((field) => (
                <label key={field.key} className="block">
                  <span className={`mb-1 flex items-center justify-between text-xs font-semibold ${mutedText}`}>
                    {field.label}
                    {field.help_url ? (
                      <a
                        href={field.help_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-sky-600 hover:underline"
                      >
                        Get key
                      </a>
                    ) : null}
                  </span>
                  <input
                    type={field.secret ? 'password' : 'text'}
                    value={values[field.key] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className={input}
                    autoComplete="off"
                  />
                </label>
              ))}
            </div>
          ) : (
            <p className={mutedText}>
              This board publishes a public job feed. Connecting enables automatic sync into your
              pipeline — no account required.
            </p>
          )}

          {connection ? (
            <p className={`text-xs ${mutedText}`}>
              {Object.entries(connection.credential_hints)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ') || 'Connected'}
            </p>
          ) : null}

          {localError ? (
            <p className="flex items-start gap-1.5 text-sm font-medium text-rose-700 dark:text-rose-400">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              {localError}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {connection ? (
            <button type="button" onClick={onDisconnect} disabled={busy} className={btnDanger}>
              <Unplug size={14} />
              Disconnect
            </button>
          ) : null}
          <button type="button" onClick={onClose} className={btnSecondary}>
            Close
          </button>
          {plugin.connectable && plugin.auth_type === 'session' ? (
            <button
              type="button"
              onClick={() => void handleCapture()}
              disabled={busy || capturing}
              className={btnPrimary}
            >
              {busy || capturing ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              {connection ? 'Recapture session' : 'Capture session'}
            </button>
          ) : null}
          {plugin.connectable && plugin.auth_type === 'api_key' ? (
            <button
              type="button"
              onClick={() => void submitCredentials()}
              disabled={busy}
              className={btnPrimary}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {connection ? 'Update keys' : 'Verify & connect'}
            </button>
          ) : null}
          {plugin.connectable && plugin.auth_type === 'none' && !connection ? (
            <button
              type="button"
              onClick={() => void submitCredentials()}
              disabled={busy}
              className={btnPrimary}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              Enable
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
