// Bridge to the Atomspace browser extension (Apply Assistant + install detect).
//
// Detection strategy (most reliable first):
//   1. web_accessible_resource probe against the extension's FIXED id.
//   2. content-script postMessage handshake (PING/PONG) as a fallback.
//
// The apply hand-off travels through the content-script bridge
// (extension/content/webapp-bridge.js) -> background worker.
//
// Job-site account connect opens the board in a real tab through the worker,
// which tracks navigation until it settles. Landing on the signed-in page
// (e.g. jobright.ai/jobs/recommend) means the user was already logged in, so
// the worker captures cookies + storage and sends them back here.

const WEBAPP_SOURCE = 'atomspace-webapp';
const EXT_SOURCE = 'atomspace-extension';

export const EXTENSION_ID = 'leemdaklomjjbdfmaepplhpbeomhifmn';
const MARKER_URL = `chrome-extension://${EXTENSION_ID}/installed.svg`;

export interface ExtensionInfo {
  installed: boolean;
  version?: string;
}

interface ExtMessage {
  source?: string;
  type?: string;
  version?: string;
  requestId?: string | null;
  jobId?: string;
}

let cachedInstalled: ExtensionInfo | null = null;

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function probeMarker(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    let done = false;
    const img = new Image();
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(v);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = MARKER_URL;
  });
}

function handshake(timeoutMs: number): Promise<ExtensionInfo> {
  if (typeof window === 'undefined') return Promise.resolve({ installed: false });
  return new Promise<ExtensionInfo>((resolve) => {
    const requestId = randomId();
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    };
    const finish = (info: ExtensionInfo) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(info);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as ExtMessage | undefined;
      if (!data || data.source !== EXT_SOURCE) return;
      if (data.type === 'PONG' && (!data.requestId || data.requestId === requestId)) {
        finish({ installed: true, version: data.version });
      } else if (data.type === 'READY') {
        finish({ installed: true, version: data.version });
      }
    };
    const timer = window.setTimeout(() => finish({ installed: false }), timeoutMs);
    window.addEventListener('message', onMessage);
    window.postMessage({ source: WEBAPP_SOURCE, type: 'PING', requestId }, window.location.origin);
  });
}

export async function detectExtension(timeoutMs = 1000, force = false): Promise<ExtensionInfo> {
  if (cachedInstalled && !force) return cachedInstalled;
  if (typeof window === 'undefined') return { installed: false };

  const viaMarker = await probeMarker(Math.min(timeoutMs, 1500));
  if (viaMarker) {
    cachedInstalled = { installed: true };
    return cachedInstalled;
  }

  const viaHandshake = await handshake(timeoutMs);
  if (viaHandshake.installed) cachedInstalled = viaHandshake;
  return viaHandshake;
}

const APPLY_EVENT = 'atomspace-apply';
const ACK_ATTR = 'data-atomspace-apply-ack';

/**
 * Hand a specific job to the extension AND open its side panel.
 * Call synchronously inside a click handler (do NOT await before it).
 */
export function applyViaExtension(jobId: string, url: string | null, timeoutMs = 1200): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(false);
  const requestId = randomId();

  try {
    document.documentElement.removeAttribute(ACK_ATTR);
  } catch {
    /* ignore */
  }

  const ack = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(v);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as ExtMessage | undefined;
      if (!data || data.source !== EXT_SOURCE) return;
      if (data.type === 'APPLY_ACK' && data.requestId === requestId) finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    window.addEventListener('message', onMessage);
  });

  try {
    document.dispatchEvent(
      new CustomEvent(APPLY_EVENT, {
        detail: JSON.stringify({ jobId: String(jobId), url: url ?? null, requestId }),
      }),
    );
  } catch {
    /* ignore */
  }

  try {
    if (document.documentElement.getAttribute(ACK_ATTR) === requestId) {
      return Promise.resolve(true);
    }
  } catch {
    /* ignore */
  }

  return ack;
}

export function clearExtensionCache(): void {
  cachedInstalled = null;
}

export interface JobSiteConnectSessionSpec {
  slug: string;
  startUrl: string;
  verifyUrl: string;
  cookieDomains: string[];
  signedInUrlPatterns: string[];
  loggedOutUrlPatterns: string[];
  sessionCookieNames: string[];
}

export interface JobSiteCapturedSession {
  slug: string;
  url: string;
  reason: string;
  cookies: Array<Record<string, unknown>>;
  cookieHeader: string;
  storage: {
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  };
}

export interface JobSiteConnectAck {
  ok: boolean;
  tabId?: number | null;
  error?: string;
}

export interface JobSiteConnectStatusEvent {
  slug?: string;
  state: string;
  url: string;
  reason?: string;
}

export interface JobSiteLogEvent {
  slug?: string;
  level: 'log' | 'warn';
  event: string;
  detail: unknown;
  at: number;
}

function postToExtension(type: string, extra?: Record<string, unknown>): string {
  const requestId = randomId();
  window.postMessage(
    { source: WEBAPP_SOURCE, type, requestId, ...(extra || {}) },
    window.location.origin,
  );
  return requestId;
}

function waitForExtType<T extends ExtMessage>(
  type: string,
  requestId: string | null,
  timeoutMs: number,
): Promise<T | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as T | undefined;
      if (!data || data.source !== EXT_SOURCE) return;
      if (data.type !== type) return;
      if (requestId && data.requestId && data.requestId !== requestId) return;
      finish(data);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
  });
}

const JOB_SITE_LOG_PREFIX = '[atomspace:jobsite:web]';

async function requestExtension(
  type: string,
  extra: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<(ExtMessage & { ok?: boolean; error?: string; tabId?: number | null }) | null> {
  if (typeof window === 'undefined') return null;
  const requestId = postToExtension(type, extra);
  console.log(`${JOB_SITE_LOG_PREFIX} page -> extension`, { type, extra });
  const ack = await waitForExtType<ExtMessage & { ok?: boolean; error?: string; tabId?: number | null }>(
    `${type}_ACK`,
    requestId,
    timeoutMs,
  );
  console.log(`${JOB_SITE_LOG_PREFIX} extension -> page`, { type, ack });
  return ack;
}

/**
 * Open the board in a real tab and start navigation tracking. The extension
 * decides "already signed in" from where that tab settles.
 */
export async function startJobSiteConnect(
  session: JobSiteConnectSessionSpec,
  timeoutMs = 4000,
): Promise<JobSiteConnectAck> {
  const ack = await requestExtension('START_JOB_SITE_CONNECT', { session }, timeoutMs);
  if (!ack) {
    return { ok: false, error: 'Atomspace extension did not respond. Reload it and try again.' };
  }
  return { ok: Boolean(ack.ok), tabId: ack.tabId ?? null, error: ack.error };
}

/** End the watch. `keepTab` leaves the board tab open (used on failure). */
export function stopJobSiteConnect(keepTab = false): void {
  if (typeof window === 'undefined') return;
  console.log(`${JOB_SITE_LOG_PREFIX} stop`, { keepTab });
  postToExtension('STOP_JOB_SITE_CONNECT', { keepTab });
}

export async function captureJobSiteNow(timeoutMs = 8000): Promise<{ ok: boolean; error?: string }> {
  const ack = await requestExtension('CAPTURE_JOB_SITE_NOW', undefined, timeoutMs);
  if (!ack) return { ok: false, error: 'Atomspace extension did not respond.' };
  return { ok: Boolean(ack.ok), error: ack.error };
}

export async function focusJobSiteTab(timeoutMs = 2500): Promise<boolean> {
  const ack = await requestExtension('FOCUS_JOB_SITE_TAB', undefined, timeoutMs);
  return Boolean(ack && ack.ok);
}

export function subscribeJobSiteConnect(handlers: {
  onSession?: (session: JobSiteCapturedSession) => void;
  onStatus?: (status: JobSiteConnectStatusEvent) => void;
  onLog?: (entry: JobSiteLogEvent) => void;
}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as ExtMessage &
      JobSiteCapturedSession &
      JobSiteConnectStatusEvent &
      JobSiteLogEvent;
    if (!data || data.source !== EXT_SOURCE) return;

    if (data.type === 'JOB_SITE_LOG') {
      const entry: JobSiteLogEvent = {
        slug: data.slug,
        level: data.level === 'warn' ? 'warn' : 'log',
        event: String(data.event || ''),
        detail: data.detail,
        at: Number(data.at) || Date.now(),
      };
      if (entry.level === 'warn') console.warn(`${JOB_SITE_LOG_PREFIX} ${entry.event}`, entry.detail);
      else console.log(`${JOB_SITE_LOG_PREFIX} ${entry.event}`, entry.detail);
      handlers.onLog?.(entry);
      return;
    }

    if (data.type === 'JOB_SITE_SESSION' && handlers.onSession) {
      const session: JobSiteCapturedSession = {
        slug: String(data.slug || ''),
        url: String(data.url || ''),
        reason: String(data.reason || ''),
        cookies: Array.isArray(data.cookies) ? data.cookies : [],
        cookieHeader: String(data.cookieHeader || ''),
        storage: data.storage || { localStorage: {}, sessionStorage: {} },
      };
      console.log(`${JOB_SITE_LOG_PREFIX} session:received`, {
        url: session.url,
        reason: session.reason,
        cookies: session.cookies.length,
        localKeys: Object.keys(session.storage.localStorage || {}).length,
        sessionKeys: Object.keys(session.storage.sessionStorage || {}).length,
      });
      handlers.onSession(session);
      return;
    }

    if (data.type === 'JOB_SITE_CONNECT_STATUS' && handlers.onStatus) {
      const status: JobSiteConnectStatusEvent = {
        slug: data.slug,
        state: String(data.state || ''),
        url: String(data.url || ''),
        reason: data.reason,
      };
      console.log(`${JOB_SITE_LOG_PREFIX} status`, status);
      handlers.onStatus(status);
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
