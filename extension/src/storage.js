// chrome.storage.local wrappers: auth, server address, preferences, and the
// small per-user caches the autofill engines rely on. The auth token lives in
// local (not session) storage so the user stays signed in across restarts; the
// server issues a long-lived token for this client.

import { DEFAULT_BACKEND_URL } from "../config.js";
import {
  configuredBackendHostname,
  isDashboardUrl,
  isPinnedBackendHost,
  resolvedDefaultBackendUrl,
  shouldAcceptBackendOrigin,
} from "./backendOrigin.js";

const LOCAL = chrome.storage.local;

// ── auth ─────────────────────────────────────────────────────────────────────

export async function getToken() {
  const { token } = await LOCAL.get("token");
  return token || null;
}

export async function setToken(token) {
  await LOCAL.set({ token });
}

export async function clearToken() {
  await LOCAL.remove("token");
}

export async function getCurrentUser() {
  const { currentUser } = await LOCAL.get("currentUser");
  return currentUser || null;
}

export async function setCurrentUser(currentUser) {
  await LOCAL.set({ currentUser });
}

export async function clearCurrentUser() {
  await LOCAL.remove("currentUser");
}

export async function getRememberedEmail() {
  const { rememberedEmail } = await LOCAL.get("rememberedEmail");
  return typeof rememberedEmail === "string" ? rememberedEmail : "";
}

export async function setRememberedEmail(email) {
  const trimmed = (email || "").trim();
  if (trimmed) await LOCAL.set({ rememberedEmail: trimmed });
  else await LOCAL.remove("rememberedEmail");
}

// ── server address ───────────────────────────────────────────────────────────
// Resolution order: an address the user typed in Settings (backendUrlManual),
// then one synced from an open dashboard tab, then config.js.

export function normalizeBackendUrl(url) {
  let u = (url || "").trim();
  if (!u) return DEFAULT_BACKEND_URL;
  u = u.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
}

export async function getManualBackendUrl() {
  const { backendUrlManual } = await LOCAL.get("backendUrlManual");
  return backendUrlManual ? normalizeBackendUrl(backendUrlManual) : null;
}

export async function setManualBackendUrl(url) {
  if (!url) {
    await LOCAL.remove("backendUrlManual");
    return null;
  }
  const next = normalizeBackendUrl(url);
  await LOCAL.set({ backendUrlManual: next, backendUrl: next });
  return next;
}

export async function getBackendUrl() {
  const manual = await getManualBackendUrl();
  if (manual) return manual;

  const { backendUrl } = await LOCAL.get("backendUrl");
  const stored = backendUrl ? normalizeBackendUrl(backendUrl) : null;
  const fallback = resolvedDefaultBackendUrl();
  const resolved = isPinnedBackendHost()
    ? stored && shouldAcceptBackendOrigin(stored)
      ? stored
      : fallback
    : stored || fallback;
  if (resolved && stored !== resolved) await LOCAL.set({ backendUrl: resolved });
  return resolved;
}

/** Accepts a dashboard origin unless the user pinned a server by hand. */
export async function setBackendUrl(backendUrl) {
  if (await getManualBackendUrl()) return false;
  const next = normalizeBackendUrl(backendUrl);
  if (!shouldAcceptBackendOrigin(next)) return false;
  await LOCAL.set({ backendUrl: next });
  return true;
}

/** Pick up the server address from an open dashboard tab (prod, localhost, or LAN). */
export async function syncBackendFromOpenTabs() {
  if (await getManualBackendUrl()) return null;
  const preferredHost = isPinnedBackendHost() ? configuredBackendHostname() : null;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.url && isDashboardUrl(active.url)) {
      const origin = new URL(active.url).origin;
      if (shouldAcceptBackendOrigin(origin)) {
        await setBackendUrl(origin);
        return origin;
      }
    }
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !isDashboardUrl(tab.url)) continue;
      const origin = new URL(tab.url).origin;
      if (preferredHost && new URL(origin).hostname.toLowerCase() !== preferredHost) continue;
      if (shouldAcceptBackendOrigin(origin)) {
        await setBackendUrl(origin);
        return origin;
      }
    }
  } catch {
    /* tabs API unavailable in this context */
  }
  return null;
}

// ── per-user profile / settings cache ────────────────────────────────────────

const cacheKey = (userId) => `cache_${userId}`;

export async function getCache(userId) {
  if (!userId) return null;
  const obj = await LOCAL.get(cacheKey(userId));
  return obj[cacheKey(userId)] || null;
}

export async function setCache(userId, cache) {
  if (!userId) return;
  await LOCAL.set({ [cacheKey(userId)]: { ...cache, cachedAt: new Date().toISOString() } });
}

/** Version 1 mirrored the whole job catalog locally; lists are server-paged now. */
export async function dropLegacyCatalog() {
  try {
    const all = await LOCAL.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith("jobsCatalog_") || k.startsWith("jobsCatalogMeta_"));
    if (stale.length) await LOCAL.remove(stale);
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase("nao_jobs");
  } catch {
    /* best effort */
  }
}

// ── preferences ──────────────────────────────────────────────────────────────

export const DEFAULT_MIN_SCORE = 0;
export const DEFAULT_RESUME_SOURCE = "tailored";
export const DEFAULT_DAILY_APPLY_TARGET = 50;
export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_ASK_HOTKEY = { ctrl: false, alt: true, shift: false, meta: false, key: "a" };

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

/** Every preference with its normalizer. Keys match the 1.x storage layout. */
const PREFS = {
  minScore: (v) => clampInt(v, 0, 100, DEFAULT_MIN_SCORE),
  autoAdvance: (v) => v !== false,
  autoSubmit: (v) => v === true,
  resumeSource: (v) => (v === "original" ? "original" : DEFAULT_RESUME_SOURCE),
  answerStrategy: (v) => (typeof v === "string" ? v.trim().slice(0, 2000) : ""),
  pageSize: (v) => (PAGE_SIZES.includes(Number(v)) ? Number(v) : PAGE_SIZES[0]),
  dailyApplyTarget: (v) => (v == null ? DEFAULT_DAILY_APPLY_TARGET : clampInt(v, 0, 200, DEFAULT_DAILY_APPLY_TARGET)),
  askHotkey: (v) => normalizeAskHotkey(v),
  chatStyle: (v) => (["standard", "concise", "detailed"].includes(v) ? v : "standard"),
  answerType: (v) => (typeof v === "string" ? v : ""),
};

export async function loadPrefs() {
  const raw = await LOCAL.get(Object.keys(PREFS));
  const out = {};
  for (const [key, normalize] of Object.entries(PREFS)) out[key] = normalize(raw[key]);
  return out;
}

export async function savePref(key, value) {
  const normalize = PREFS[key];
  if (!normalize) throw new Error(`Unknown preference: ${key}`);
  const next = normalize(value);
  await LOCAL.set({ [key]: next });
  return next;
}

// ── ask-selection hotkey ─────────────────────────────────────────────────────
// A modifier (Ctrl / Alt / Meta) is required so normal typing is never captured.

export function normalizeAskHotkey(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ASK_HOTKEY };
  const key = String(raw.key || "").trim().toLowerCase();
  const combo = { ctrl: !!raw.ctrl, alt: !!raw.alt, shift: !!raw.shift, meta: !!raw.meta, key };
  if (!key || (!combo.ctrl && !combo.alt && !combo.meta)) return { ...DEFAULT_ASK_HOTKEY };
  return combo;
}

export function formatAskHotkey(raw) {
  const c = normalizeAskHotkey(raw);
  const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || "");
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push(isMac ? "Option" : "Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push(isMac ? "Cmd" : "Win");
  const named = { " ": "Space", space: "Space", escape: "Esc" };
  parts.push(named[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1)));
  return parts.join("+");
}

export function askHotkeyFromKeyboardEvent(e) {
  if (!e) return null;
  const key = e.key === " " ? "space" : String(e.key || "").toLowerCase();
  if (!key || ["control", "alt", "shift", "meta"].includes(key)) return null;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return normalizeAskHotkey({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key });
}

// ── autofill memory ──────────────────────────────────────────────────────────
// Remembered answers for stable identity / EEO / work-authorization / consent
// questions, keyed by category -> exact option text. Scoped per (user, platform)
// because each ATS phrases its options differently, so a value learned on one
// platform must never be replayed on another.

const answerCacheKey = (userId, platform) => `answers_${userId || "anon"}_${platform || "generic"}`;

export async function getAnswerCache(userId, platform) {
  const key = answerCacheKey(userId, platform);
  const v = (await LOCAL.get(key))[key];
  return v && typeof v === "object" ? v : {};
}

export async function saveAnswerPairs(userId, platform, pairs) {
  if (!pairs || !Object.keys(pairs).length) return;
  const key = answerCacheKey(userId, platform);
  const next = { ...(await getAnswerCache(userId, platform)) };
  for (const [k, v] of Object.entries(pairs)) if (k && v) next[k] = String(v);
  await LOCAL.set({ [key]: next });
}

// Portal accounts the assistant had to create (iCIMS "Create a login"), keyed by
// (user, host). The password is generated once and kept so the candidate can sign
// back in to check the application.
const atsCredentialKey = (userId, host) => `atscreds_${userId || "anon"}_${String(host || "").toLowerCase()}`;

export async function getAtsCredential(userId, host) {
  if (!host) return null;
  const key = atsCredentialKey(userId, host);
  const v = (await LOCAL.get(key))[key];
  return v && typeof v === "object" && v.password ? v : null;
}

export async function saveAtsCredential(userId, host, creds) {
  if (!host || !creds || !creds.password) return null;
  const value = {
    host: String(host).toLowerCase(),
    login: String(creds.login || ""),
    password: String(creds.password),
    createdAt: creds.createdAt || new Date().toISOString(),
  };
  await LOCAL.set({ [atsCredentialKey(userId, host)]: value });
  return value;
}
