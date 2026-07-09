import { DEFAULT_BACKEND_URL } from "../config.js";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Recognize local / LAN dashboard origins (localhost, 127.0.0.1, RFC1918). */
export function isPrivateLanHostname(hostname) {
  const host = (hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function isDashboardUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && isPrivateLanHostname(u.hostname);
  } catch {
    return false;
  }
}

/** Dev dashboard origin (Vite proxies /api/v1 on the same host:port). */
export function backendUrlFromDashboardOrigin(origin) {
  return (origin || "").replace(/\/+$/, "");
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

/** True when config.js pins a specific LAN IP instead of localhost dev defaults. */
export function isConfiguredLanBackend() {
  const host = configuredBackendHostname();
  return Boolean(host && !LOCALHOST_HOSTS.has(host));
}

/** Reject stray dashboard tabs (e.g. router at 172.20.1.1) when config pins one IP. */
export function shouldAcceptBackendOrigin(origin) {
  if (!origin) return false;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!isPrivateLanHostname(hostname)) return false;
  if (!isConfiguredLanBackend()) return true;
  return hostname === configuredBackendHostname();
}
