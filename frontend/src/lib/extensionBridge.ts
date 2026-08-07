// Bridge to the "Job Application Assistant" browser extension.
//
// Detection strategy (most reliable first):
//   1. web_accessible_resource probe against the extension's FIXED id. The page
//      simply loads chrome-extension://<id>/installed.svg; if it loads, the
//      extension is installed. This is independent of content-script injection,
//      tab state, or page origin - so it works even for tabs that were already
//      open when the extension was installed, and on LAN IPs / custom domains.
//   2. content-script postMessage handshake (PING/PONG) as a fallback for pages
//      whose CSP blocks loading extension subresources.
//
// The apply hand-off still travels through the content-script bridge
// (extension/content/webapp-bridge.js) -> background worker.

const WEBAPP_SOURCE = 'atomspace-webapp';
const EXT_SOURCE = 'atomspace-extension';

// Fixed id derived from the "key" pinned in extension/manifest.json. If you ever
// regenerate that key, update this to match (background logs the id on install).
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

// Positive detections are cached for the session (the extension can't be
// uninstalled without a page reload). Negative results are NOT cached so a
// user who installs mid-session succeeds on their next click.
let cachedInstalled: ExtensionInfo | null = null;

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Direct probe: try to load the extension's web-accessible marker file. */
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

/** Fallback: content-script PING/PONG handshake. */
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

/**
 * Detect the extension. Tries the direct resource probe first, then the
 * handshake. Resolves { installed: false } if neither responds in time.
 */
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
 *
 * IMPORTANT: call this synchronously inside the click handler (do NOT `await`
 * anything before it). It dispatches a synchronous DOM CustomEvent so the
 * extension can open the side panel while the user gesture is still valid -
 * user activation would be lost through window.postMessage or any async gap.
 *
 * Returns a promise that resolves `true` once the in-page bridge acknowledges
 * receipt, or `false` if no bridge answered in time (e.g. the dashboard tab
 * predates the extension and hasn't been reloaded) so the caller can fall back.
 *
 * ACK is primarily a synchronous DOM attribute set by the content script during
 * the CustomEvent dispatch. postMessage is only a backup — relying on it alone
 * caused a double-tab bug when the page ignored CS postMessage (`event.source`
 * checks) and then `window.open`'d after the background had already opened the
 * application URL.
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
      // Do NOT require event.source === window: content-script postMessage
      // source handling differs across Chrome builds and was rejecting valid ACKs.
      const data = event.data as ExtMessage | undefined;
      if (!data || data.source !== EXT_SOURCE) return;
      if (data.type === 'APPLY_ACK' && data.requestId === requestId) finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    window.addEventListener('message', onMessage);
  });

  // Synchronous dispatch - must run within the caller's user gesture.
  try {
    document.dispatchEvent(
      new CustomEvent(APPLY_EVENT, {
        detail: JSON.stringify({ jobId: String(jobId), url: url ?? null, requestId }),
      }),
    );
  } catch {
    /* ignore */
  }

  // Preferred ACK: content script sets this attribute inside the same turn.
  try {
    if (document.documentElement.getAttribute(ACK_ATTR) === requestId) {
      return Promise.resolve(true);
    }
  } catch {
    /* ignore */
  }

  return ack;
}

/** Forget a cached positive detection (e.g. to re-probe). */
export function clearExtensionCache(): void {
  cachedInstalled = null;
}
