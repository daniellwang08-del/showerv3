import { DEFAULT_BACKEND_URL } from "../config.js";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Recognize local / LAN dashboard hosts (localhost, 127.0.0.1, RFC1918). */
export function isPrivateLanHostname(hostname) {
  const host = (hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (LOCALHOST_HOSTS.has(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function resolvedDefaultBackendUrl() {
  return (DEFAULT_BACKEND_URL || "").replace(/\/+$/, "");
}

export function configuredBackendHostname() {
  try {
    return new URL(DEFAULT_BACKEND_URL).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when config.js pins a specific host (prod domain or LAN IP), not localhost. */
export function isPinnedBackendHost() {
  const host = configuredBackendHostname();
  return Boolean(host && !LOCALHOST_HOSTS.has(host));
}

/** @deprecated Use isPinnedBackendHost */
export const isConfiguredLanBackend = isPinnedBackendHost;

function hostMatchesPinned(hostname, pinned) {
  if (!hostname || !pinned) return false;
  if (hostname === pinned) return true;
  if (hostname === `www.${pinned}`) return true;
  if (pinned.startsWith("www.") && hostname === pinned.slice(4)) return true;
  return false;
}

/** Dashboard hosts: private LAN, or the host pinned in config.js (incl. www). */
export function isDashboardHostname(hostname) {
  const host = (hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (isPrivateLanHostname(host)) return true;
  return hostMatchesPinned(host, configuredBackendHostname());
}

export function isDashboardUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && isDashboardHostname(u.hostname);
  } catch {
    return false;
  }
}

/** Dev dashboard origin (Vite proxies /api/v1 on the same host:port). */
export function backendUrlFromDashboardOrigin(origin) {
  return (origin || "").replace(/\/+$/, "");
}

/**
 * Accept backend origins that are valid dashboards. When config pins a host,
 * only that host (and www) is accepted so stray LAN tabs cannot override prod.
 */
export function shouldAcceptBackendOrigin(origin) {
  if (!origin) return false;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!isDashboardHostname(hostname)) return false;
  if (!isPinnedBackendHost()) return true;
  return hostMatchesPinned(hostname, configuredBackendHostname());
}
