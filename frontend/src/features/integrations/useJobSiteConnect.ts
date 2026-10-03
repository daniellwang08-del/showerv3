import { useEffect, useRef, useState } from 'react';
import { connectJobSite, type JobSiteConnection, type JobSitePlugin } from '@/api/jobSitesApi';
import {
  captureJobSiteNow,
  detectExtension,
  focusJobSiteTab,
  startJobSiteConnect,
  stopJobSiteConnect,
  subscribeJobSiteConnect,
  type JobSiteCapturedSession,
} from '@/lib/extensionBridge';
import { errorDetail } from './status';

const MAX_LOG_LINES = 200;

export type ExtensionState =
  | 'idle'
  | 'starting'
  | 'navigating'
  | 'loading'
  | 'verifying'
  | 'signed_in'
  | 'capturing'
  | 'connecting'
  | 'signed_out'
  | 'cancelled'
  | 'need_extension'
  | 'start_failed'
  | (string & {});

export interface ConnectLogLine {
  id: number;
  level: 'log' | 'warn' | 'error';
  text: string;
  detail?: string;
}

/** One sentence describing where the tracked tab currently is. */
export function extensionStatusText(state: ExtensionState, siteName: string): string {
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
      return 'Install the NAO extension to detect your login automatically.';
    case 'start_failed':
      return `The extension could not open ${siteName}. See the error below.`;
    default:
      return `Connecting ${siteName}…`;
  }
}

export type StepState = 'pending' | 'active' | 'done' | 'failed';

/** Progress through: detect extension → open site → sign in → capture & verify. */
export function extensionSteps(state: ExtensionState, extReady: boolean | null, busy: boolean): StepState[] {
  const steps: StepState[] = ['pending', 'pending', 'pending', 'pending'];
  if (extReady === null) {
    steps[0] = 'active';
    return steps;
  }
  if (!extReady || state === 'need_extension') {
    steps[0] = 'failed';
    return steps;
  }
  steps[0] = 'done';
  const failedAt = state === 'start_failed' || state === 'cancelled' ? 1 : -1;
  const current =
    state === 'verifying' || state === 'signed_out'
      ? 2
      : state === 'signed_in' || state === 'capturing' || state === 'connecting' || busy
        ? 3
        : 1;
  for (let i = 1; i < steps.length; i += 1) {
    if (i === failedAt) steps[i] = 'failed';
    else if (failedAt > 0 && i > failedAt) steps[i] = 'pending';
    else if (i < current) steps[i] = 'done';
    else if (i === current) steps[i] = 'active';
  }
  return steps;
}

export function isSessionFlow(plugin: JobSitePlugin): boolean {
  return Boolean(plugin.connectable && plugin.session_capture && plugin.auth_type === 'account');
}

/**
 * Connect a job site: credential/feed connects for every auth type, plus the
 * browser-extension session capture for `account` sites with `session_capture`.
 * The extension watch starts on mount and stops on unmount.
 */
export function useJobSiteConnect(
  plugin: JobSitePlugin,
  { onConnected }: { onConnected: (row: JobSiteConnection) => void },
) {
  const sessionFlow = isSessionFlow(plugin);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [extReady, setExtReady] = useState<boolean | null>(sessionFlow ? null : false);
  const [liveState, setLiveState] = useState<ExtensionState>('idle');
  const [liveUrl, setLiveUrl] = useState('');
  const [logLines, setLogLines] = useState<ConnectLogLine[]>([]);
  const [attempt, setAttempt] = useState(0);

  const logIdRef = useRef(0);
  const connectingRef = useRef(false);
  const capturedSigRef = useRef('');
  const onConnectedRef = useRef(onConnected);
  const onSessionRef = useRef<(session: JobSiteCapturedSession) => void>(() => undefined);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  const pushLog = (level: ConnectLogLine['level'], text: string, detail?: unknown) => {
    logIdRef.current += 1;
    const line: ConnectLogLine = {
      id: logIdRef.current,
      level,
      text,
      detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail),
    };
    setLogLines((prev) => [...prev, line].slice(-MAX_LOG_LINES));
  };
  const pushLogRef = useRef(pushLog);
  useEffect(() => {
    pushLogRef.current = pushLog;
  });

  const connectCaptured = (session: JobSiteCapturedSession) => {
    const log = pushLogRef.current;
    if (session.slug && session.slug !== plugin.slug) return;
    if (!session.cookies.length) {
      log('warn', 'session:empty', 'Captured session had no cookies.');
      return;
    }
    const sig = session.cookieHeader || JSON.stringify(session.cookies.map((c) => c.name));
    if (sig && sig === capturedSigRef.current) {
      log('log', 'session:duplicate_ignored');
      return;
    }
    if (connectingRef.current) {
      log('log', 'session:connect_in_flight');
      return;
    }
    connectingRef.current = true;
    capturedSigRef.current = sig;
    // Only boards that declare a cookie_header field read it; for the rest
    // the structured cookie list is what the backend replays.
    const wantsCookieHeader = plugin.credential_fields.some((f) => f.key === 'cookie_header');

    void (async () => {
      setBusy(true);
      setError('');
      setLiveState('connecting');
      log('log', 'api:connect_request', { slug: plugin.slug, cookies: session.cookies.length, url: session.url });
      try {
        const row = await connectJobSite(plugin.slug, {
          credentials: wantsCookieHeader && session.cookieHeader ? { cookie_header: session.cookieHeader } : {},
          cookies: session.cookies,
          storage: session.storage,
        });
        log('log', 'api:connect_ok', { listings: row.last_listing_count, hints: row.credential_hints });
        stopJobSiteConnect(false);
        onConnectedRef.current(row);
      } catch (err: unknown) {
        connectingRef.current = false;
        capturedSigRef.current = '';
        const message = errorDetail(
          err,
          `Signed in, but ${plugin.name} rejected the captured session. Sign in again on the tab.`,
        );
        log('error', 'api:connect_failed', message);
        setError(message);
        setLiveState('signed_out');
      } finally {
        setBusy(false);
      }
    })();
  };
  useEffect(() => {
    onSessionRef.current = connectCaptured;
  });

  useEffect(() => {
    const capture = plugin.session_capture;
    if (!sessionFlow || !capture) return undefined;
    let cancelled = false;
    const log = (...args: Parameters<typeof pushLog>) => {
      if (!cancelled) pushLogRef.current(...args);
    };
    const startUrl = capture.start_url || plugin.login_url || plugin.homepage;

    const unsubscribe = subscribeJobSiteConnect({
      onLog: (entry) => log(entry.level, entry.event, entry.detail),
      onStatus: (status) => {
        if (cancelled || (status.slug && status.slug !== plugin.slug)) return;
        if (status.state) setLiveState(status.state);
        if (status.url) setLiveUrl(status.url);
      },
      onSession: (session) => {
        if (!cancelled) onSessionRef.current(session);
      },
    });

    void (async () => {
      setExtReady(null);
      setLiveState('idle');
      setError('');
      log('log', 'connect:clicked', { slug: plugin.slug, startUrl });
      const info = await detectExtension(1500, true);
      if (cancelled) return;
      setExtReady(info.installed);
      log('log', 'extension:detect', info);
      if (!info.installed) {
        setLiveState('need_extension');
        log('warn', 'extension:missing', 'Automatic login detection needs the extension.');
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
      log(ack.ok ? 'log' : 'error', 'connect:ack', ack);
      if (!ack.ok) {
        setLiveState('start_failed');
        setError(ack.error || 'Could not open the job site. Reload the NAO extension.');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      // Leave the board tab open only while a captured session is still being verified.
      stopJobSiteConnect(connectingRef.current);
    };
  }, [plugin, sessionFlow, attempt]);

  const submitCredentials = async (credentials: Record<string, string> = values) => {
    setBusy(true);
    setError('');
    pushLog('log', 'api:manual_connect_request', { slug: plugin.slug });
    try {
      const row = await connectJobSite(plugin.slug, { credentials });
      pushLog('log', 'api:manual_connect_ok', { listings: row.last_listing_count });
      onConnectedRef.current(row);
      return true;
    } catch (err: unknown) {
      const message = errorDetail(err, `Failed to connect ${plugin.name}.`);
      pushLog('error', 'api:manual_connect_failed', message);
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const captureNow = async () => {
    setError('');
    pushLog('log', 'capture:manual_requested');
    const result = await captureJobSiteNow();
    if (!result.ok) {
      const message = result.error || `No signed-in ${plugin.name} session found yet. Sign in, then try again.`;
      pushLog('warn', 'capture:manual_failed', message);
      setError(message);
    }
  };

  const focusTab = async () => {
    setError('');
    pushLog('log', 'tab:focus_requested');
    const ok = await focusJobSiteTab();
    if (!ok) {
      pushLog('warn', 'tab:focus_failed', 'Opening a plain tab instead.');
      window.open(
        plugin.session_capture?.start_url || plugin.login_url || plugin.homepage,
        '_blank',
        'noopener,noreferrer',
      );
    }
  };

  /** Re-run detection and the tab watch (e.g. after installing the extension). */
  const retry = () => {
    connectingRef.current = false;
    capturedSigRef.current = '';
    setAttempt((n) => n + 1);
  };

  return {
    sessionFlow,
    values,
    setValue: (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value })),
    error,
    setError,
    busy,
    extReady,
    liveState,
    liveUrl,
    statusText: extensionStatusText(liveState, plugin.name),
    steps: extensionSteps(liveState, extReady, busy),
    logLines,
    submitCredentials,
    captureNow,
    focusTab,
    retry,
  };
}
