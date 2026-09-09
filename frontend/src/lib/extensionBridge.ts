// Bridge to the Atomspace browser extension (Apply Assistant + install detect).
//
// Detection strategy (most reliable first):
//   1. web_accessible_resource probe against the extension's FIXED id.
//   2. content-script postMessage handshake (PING/PONG) as a fallback.
//
// The apply hand-off travels through the content-script bridge
// (extension/content/webapp-bridge.js) -> background worker.
//
// Job-site account connect does NOT use the extension.

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
