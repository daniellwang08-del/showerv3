import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Unplug,
} from 'lucide-react';
import {
  connectJobSite,
  type JobSiteConnection,
  type JobSitePlugin,
} from '../../api/jobSitesApi';
import { Z_INDEX } from '../../constants/zIndex';
import { InstallExtensionModal } from '../scraper/InstallExtensionModal';
import {
  captureJobSiteNow,
  detectExtension,
  focusJobSiteTab,
  startJobSiteConnect,
  stopJobSiteConnect,
  subscribeJobSiteConnect,
  type JobSiteCapturedSession,
} from '../../lib/extensionBridge';
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

const LOG_PREFIX = '[atomspace:jobsite:modal]';
const MAX_LOG_LINES = 200;

interface LogLine {
  id: number;
  level: 'log' | 'warn' | 'error';
  text: string;
  detail?: string;
}

function errorDetail(err: unknown, fallback: string): string {
  const detail =
    err && typeof err === 'object' && 'response' in err
      ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
      : null;
  return typeof detail === 'string' ? detail : fallback;
}

/** One sentence describing where the tracked tab currently is. */
function statusCopy(state: string, siteName: string): string {
  switch (state) {
    case 'idle':
      return `Opening ${siteName}…`;
    case 'starting':
    case 'navigating':
      return `Opened ${siteName} in a new tab. Watching where it redirects…`;
    case 'loading':
      return `${siteName} is loading…`;
    case 'verifying':
      return `Found a saved ${siteName} session. Opening your jobs page to confirm…`;
    case 'signed_in':
      return `You are already signed in to ${siteName}. Capturing the session…`;
    case 'capturing':
      return `Capturing your ${siteName} session…`;
    case 'connecting':
      return `Verifying the captured session against ${siteName}…`;
    case 'signed_out':
      return `Sign in on the ${siteName} tab. We connect automatically the moment it lands on your jobs page.`;
    case 'cancelled':
      return `The ${siteName} tab was closed before sign-in finished.`;
    case 'need_extension':
      return 'Install the Atomspace extension to detect your login automatically.';
    default:
      return `Connecting ${siteName}…`;
  }
}

export function JobSiteConnectModal({
  plugin,
  connection,
  busy,
  onClose,
  onConnected,
  onDisconnect,
  onBusy,
  onError,
}: {
  plugin: JobSitePlugin;
  connection: JobSiteConnection | null;
  busy: boolean;
  onClose: () => void;
  onConnected: (row: JobSiteConnection) => void;
  onDisconnect: () => void;
  onBusy: (slug: string | null) => void;
  onError: (msg: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState('');
  const [showCredentials, setShowCredentials] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [extReady, setExtReady] = useState<boolean | null>(null);
  const [liveUrl, setLiveUrl] = useState('');
  const [liveState, setLiveState] = useState('idle');
  const [logLines, setLogLines] = useState<LogLine[]>([]);

  const connectingRef = useRef(false);
  const capturedSigRef = useRef('');
  const logIdRef = useRef(0);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const connectCapturedRef = useRef<(session: JobSiteCapturedSession) => void>(() => undefined);

  const capture = plugin.session_capture;
  const usesCredentialForm = plugin.auth_type === 'api_key' || plugin.auth_type === 'account';
  const sessionFlow = Boolean(plugin.connectable && capture && plugin.auth_type === 'account');

  const pushLog = useCallback((level: LogLine['level'], text: string, detail?: unknown) => {
    const line: LogLine = {
      id: (logIdRef.current += 1),
      level,
      text,
      detail:
        detail === undefined
          ? undefined
          : typeof detail === 'string'
            ? detail
            : JSON.stringify(detail),
    };
    if (level === 'warn') console.warn(`${LOG_PREFIX} ${text}`, detail);
    else if (level === 'error') console.error(`${LOG_PREFIX} ${text}`, detail);
    else console.log(`${LOG_PREFIX} ${text}`, detail);
    setLogLines((prev) => [...prev, line].slice(-MAX_LOG_LINES));
  }, []);

  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logLines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);

  // Clicking Connect lands here: open the board in a tab and watch it.
  useEffect(() => {
    if (!sessionFlow || !capture) return undefined;
    let cancelled = false;
    const startUrl = capture.start_url || plugin.login_url || plugin.homepage;

    const unsubscribe = subscribeJobSiteConnect({
      onLog: (entry) => {
        if (cancelled) return;
        pushLog(entry.level, entry.event, entry.detail);
      },
      onStatus: (status) => {
        if (cancelled || (status.slug && status.slug !== plugin.slug)) return;
        if (status.state) setLiveState(status.state);
        if (status.url) setLiveUrl(status.url);
      },
      onSession: (session) => {
        if (cancelled) return;
        connectCapturedRef.current(session);
      },
    });

    void (async () => {
      pushLog('log', 'connect:clicked', { slug: plugin.slug, startUrl });
      const info = await detectExtension(1500, true);
      if (cancelled) return;
      setExtReady(info.installed);
      pushLog('log', 'extension:detect', info);

      if (!info.installed) {
        setLiveState('need_extension');
        pushLog('warn', 'extension:missing', 'Automatic login detection needs the extension.');
        return;
      }

      const ack = await startJobSiteConnect({
        slug: plugin.slug,
        startUrl,
        verifyUrl: capture.verify_url || startUrl,
        cookieDomains: capture.cookie_domains,
        signedInUrlPatterns: capture.signed_in_url_patterns,
        loggedOutUrlPatterns: capture.logged_out_url_patterns,
        sessionCookieNames: capture.session_cookie_names,
      });
      if (cancelled) return;
      pushLog(ack.ok ? 'log' : 'error', 'connect:ack', ack);
      if (!ack.ok) {
        setLocalError(ack.error || 'Could not open the job site. Reload the Atomspace extension.');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      // Modal closed: drop the watch and close the board tab unless a connect
      // is still in flight (the success path closes it after the API call).
      stopJobSiteConnect(connectingRef.current);
    };
  }, [
    sessionFlow,
    capture,
    plugin.slug,
    plugin.login_url,
    plugin.homepage,
    pushLog,
  ]);

  const connectCaptured = (session: JobSiteCapturedSession) => {
    if (session.slug && session.slug !== plugin.slug) return;
    if (!session.cookies.length) {
      pushLog('warn', 'session:empty', 'Captured session had no cookies.');
      return;
    }
    const sig = session.cookieHeader || JSON.stringify(session.cookies.map((c) => c.name));
    if (sig && sig === capturedSigRef.current) {
      pushLog('log', 'session:duplicate_ignored');
      return;
    }
    if (connectingRef.current) {
      pushLog('log', 'session:connect_in_flight');
      return;
    }
    connectingRef.current = true;
    capturedSigRef.current = sig;

    void (async () => {
      onBusy(plugin.slug);
      setLocalError('');
      onError('');
      setLiveState('connecting');
      pushLog('log', 'api:connect_request', {
        slug: plugin.slug,
        cookies: session.cookies.length,
        url: session.url,
      });
      // Only boards that declare a cookie_header field read it; for the rest
      // the structured cookie list is what the backend replays.
      const wantsCookieHeader = plugin.credential_fields.some((f) => f.key === 'cookie_header');
      try {
        const row = await connectJobSite(plugin.slug, {
          credentials:
            wantsCookieHeader && session.cookieHeader
              ? { cookie_header: session.cookieHeader }
              : {},
          cookies: session.cookies,
          storage: session.storage,
        });
        pushLog('log', 'api:connect_ok', {
          listings: row.last_listing_count,
          hints: row.credential_hints,
        });
        stopJobSiteConnect(false);
        onConnected(row);
      } catch (err: unknown) {
        connectingRef.current = false;
        capturedSigRef.current = '';
        const message = errorDetail(
          err,
          `Signed in, but ${plugin.name} rejected the captured session. Sign in again on the tab.`,
        );
        pushLog('error', 'api:connect_failed', message);
        setLocalError(message);
        setLiveState('signed_out');
      } finally {
        onBusy(null);
      }
    })();
  };
  connectCapturedRef.current = connectCaptured;

  const submitCredentials = async () => {
    onBusy(plugin.slug);
    setLocalError('');
    onError('');
    pushLog('log', 'api:manual_connect_request', { slug: plugin.slug });
    try {
      const row = await connectJobSite(plugin.slug, { credentials: values });
      pushLog('log', 'api:manual_connect_ok', { listings: row.last_listing_count });
      onConnected(row);
    } catch (err: unknown) {
      const message = errorDetail(err, `Failed to connect ${plugin.name}.`);
      pushLog('error', 'api:manual_connect_failed', message);
      setLocalError(message);
    } finally {
      onBusy(null);
    }
  };

  const handleFocusTab = async () => {
    setLocalError('');
    pushLog('log', 'tab:focus_requested');
    const ok = await focusJobSiteTab();
    if (!ok) {
      pushLog('warn', 'tab:focus_failed', 'Opening a plain tab instead.');
      window.open(
        capture?.start_url || plugin.login_url || plugin.homepage,
        '_blank',
        'noopener,noreferrer',
      );
    }
  };

  const handleCaptureNow = async () => {
    setLocalError('');
    pushLog('log', 'capture:manual_requested');
    const result = await captureJobSiteNow();
    if (!result.ok) {
      const message =
        result.error || `No signed-in ${plugin.name} session found yet. Sign in, then try again.`;
      pushLog('warn', 'capture:manual_failed', message);
      setLocalError(message);
    }
  };

  const modalWidth = sessionFlow ? 'max-w-2xl' : 'max-w-md';

  return createPortal(
    <>
      <div
        className="fixed inset-0 flex items-center justify-center bg-slate-900/50 p-3 sm:p-4 backdrop-blur-sm"
        style={{ zIndex: Z_INDEX.confirmDialog }}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <div className={`flex w-full ${modalWidth} max-h-[min(92vh,860px)] flex-col p-5 ${card}`}>
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200/80 dark:bg-[var(--app-input)] dark:ring-white/10">
              <img src={plugin.logo_src} alt="" className="h-7 w-7 object-contain" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className={`text-base font-bold ${headingText}`}>{plugin.name}</h3>
              <p className={`mt-0.5 text-xs leading-snug ${mutedText}`}>{plugin.blurb}</p>
            </div>
          </div>

          <div className={`mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto text-sm ${bodyText}`}>
            {!plugin.connectable ? (
              <p className={mutedText}>{plugin.unavailable_reason}</p>
            ) : sessionFlow ? (
              <div className="space-y-3">
                <StatusPanel
                  state={liveState}
                  url={liveUrl}
                  siteName={plugin.name}
                  busy={busy}
                />

                {extReady === false ? (
                  <p className={`text-xs leading-relaxed ${mutedText}`}>
                    Without the extension we cannot read your {plugin.name} login. Install it, or
                    use the manual credentials below.
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {extReady === false ? (
                    <button type="button" onClick={() => setInstallOpen(true)} className={btnSecondary}>
                      Install extension
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={() => void handleFocusTab()} className={btnSecondary}>
                        <ExternalLink size={14} />
                        Show {plugin.name} tab
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCaptureNow()}
                        disabled={busy}
                        className={btnSecondary}
                      >
                        {busy ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={14} />
                        )}
                        I&apos;m signed in — capture now
                      </button>
                    </>
                  )}
                </div>

                <LogPanel lines={logLines} boxRef={logBoxRef} />

                {usesCredentialForm && plugin.credential_fields.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowCredentials((v) => !v)}
                    className="text-xs font-semibold text-sky-600 hover:underline"
                  >
                    {showCredentials
                      ? 'Hide manual credentials'
                      : 'Connect with email, password, or cookies instead'}
                  </button>
                ) : null}
                {showCredentials ? (
                  <CredentialFields plugin={plugin} values={values} setValues={setValues} />
                ) : null}
              </div>
            ) : usesCredentialForm ? (
              <CredentialFields plugin={plugin} values={values} setValues={setValues} />
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
            <button type="button" onClick={onClose} className={btnSecondary} disabled={busy}>
              Close
            </button>
            {plugin.connectable && usesCredentialForm && (!sessionFlow || showCredentials) ? (
              <button
                type="button"
                onClick={() => void submitCredentials()}
                disabled={busy}
                className={btnPrimary}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                {connection ? 'Update & verify' : 'Verify & connect'}
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
      </div>
      <InstallExtensionModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={() => {
          setInstallOpen(false);
          window.location.reload();
        }}
      />
    </>,
    document.body,
  );
}

function StatusPanel({
  state,
  url,
  siteName,
  busy,
}: {
  state: string;
  url: string;
  siteName: string;
  busy: boolean;
}) {
  const done = state === 'signed_in' || state === 'capturing' || state === 'connecting';
  const failed = state === 'cancelled' || state === 'need_extension';
  const spinning = busy || (!failed && !done && state !== 'signed_out');

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-[var(--app-input)]">
      <p className="flex items-start gap-2 text-xs leading-relaxed">
        {spinning ? (
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-sky-600" />
        ) : done ? (
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
        ) : (
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-600" />
        )}
        <span>{statusCopy(state, siteName)}</span>
      </p>
      {url ? (
        <p className="mt-1.5 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
          {url}
        </p>
      ) : null}
    </div>
  );
}

function LogPanel({
  lines,
  boxRef,
}: {
  lines: LogLine[];
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div>
      <p className={`mb-1 text-[11px] font-semibold uppercase tracking-wide ${mutedText}`}>
        Connection log
      </p>
      <div
        ref={boxRef}
        className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-slate-900 p-2.5 font-mono text-[11px] leading-relaxed text-slate-300 dark:border-white/10"
      >
        {lines.length === 0 ? (
          <p className="text-slate-500">Waiting for the browser extension…</p>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className={
                line.level === 'error'
                  ? 'text-rose-400'
                  : line.level === 'warn'
                    ? 'text-amber-300'
                    : 'text-slate-300'
              }
            >
              <span className="text-sky-400">{line.text}</span>
              {line.detail ? <span className="text-slate-500"> {line.detail}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CredentialFields({
  plugin,
  values,
  setValues,
}: {
  plugin: JobSitePlugin;
  values: Record<string, string>;
  setValues: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  return (
    <div className="space-y-2.5">
      {plugin.auth_type === 'account' && plugin.login_url ? (
        <p className={`text-xs leading-relaxed ${mutedText}`}>
          {plugin.slug === 'remoterocketship' ? (
            <>
              Paste a Cookie header from DevTools after signing in on{' '}
              <a
                href={plugin.login_url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-sky-600 hover:underline"
              >
                RemoteRocketship
                <ExternalLink size={11} className="ml-0.5 inline" />
              </a>
              .
            </>
          ) : (
            <>
              Enter the same email and password you use on{' '}
              <a
                href={plugin.homepage}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-sky-600 hover:underline"
              >
                {plugin.name}
                <ExternalLink size={11} className="ml-0.5 inline" />
              </a>
              . We verify against the live API.
            </>
          )}
        </p>
      ) : null}
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
                {plugin.auth_type === 'account' ? 'Open site' : 'Get key'}
                <ExternalLink size={11} className="ml-0.5 inline" />
              </a>
            ) : null}
          </span>
          {field.key === 'cookie_header' ? (
            <textarea
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className={`${input} min-h-[88px] resize-y font-mono text-xs`}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <input
              type={field.secret ? 'password' : field.key === 'email' ? 'email' : 'text'}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className={input}
              autoComplete={field.key === 'email' ? 'username' : 'off'}
            />
          )}
        </label>
      ))}
    </div>
  );
}
