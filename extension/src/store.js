// Thin wrappers over chrome.storage.local. The auth token is stored in local
// (not session) so the user stays signed in across browser restarts; the server
// issues a long-lived token for this client, so the login persists.

import { DEFAULT_BACKEND_URL } from "../config.js";
import {
  configuredBackendHostname,
  isPinnedBackendHost,
  isDashboardUrl,
  resolvedDefaultBackendUrl,
  shouldAcceptBackendOrigin,
} from "./backendOrigin.js";

const LOCAL = chrome.storage.local;

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

export async function getBackendUrl() {
  const { backendUrl } = await LOCAL.get("backendUrl");
  const stored = backendUrl ? normalizeBackendUrl(backendUrl) : null;
  const fallback = resolvedDefaultBackendUrl();

  let resolved;
  if (isPinnedBackendHost()) {
    // Prod / pinned LAN: ignore stale localhost or wrong-host storage.
    resolved = stored && shouldAcceptBackendOrigin(stored) ? stored : fallback;
  } else {
    resolved = stored || fallback;
  }

  // Self-heal stale storage (e.g. old localhost after switching to production).
  if (resolved && stored !== resolved) {
    await LOCAL.set({ backendUrl: resolved });
  }
  return resolved;
}

/** Pick up backend URL from an open dashboard tab (prod, localhost, or LAN). */
export async function syncBackendFromOpenTabs() {
  const fallback = resolvedDefaultBackendUrl();
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

    if (preferredHost) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url || !isDashboardUrl(tab.url)) continue;
        if (new URL(tab.url).hostname.toLowerCase() === preferredHost) {
          const origin = new URL(tab.url).origin;
          await setBackendUrl(origin);
          return origin;
        }
      }
      await setBackendUrl(fallback);
      return fallback;
    }

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !isDashboardUrl(tab.url)) continue;
      const origin = new URL(tab.url).origin;
      if (shouldAcceptBackendOrigin(origin)) {
        await setBackendUrl(origin);
        return origin;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function setBackendUrl(backendUrl) {
  const next = normalizeBackendUrl(backendUrl);
  if (!shouldAcceptBackendOrigin(next)) return false;
  await LOCAL.set({ backendUrl: next });
  return true;
}

export function normalizeBackendUrl(url) {
  let u = (url || "").trim();
  if (!u) return DEFAULT_BACKEND_URL;
  u = u.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
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

const REMEMBER_EMAIL_KEY = "rememberedEmail";

export async function getRememberedEmail() {
  const { [REMEMBER_EMAIL_KEY]: email } = await LOCAL.get(REMEMBER_EMAIL_KEY);
  return typeof email === "string" ? email : "";
}

export async function setRememberedEmail(email) {
  const trimmed = (email || "").trim();
  if (trimmed) await LOCAL.set({ [REMEMBER_EMAIL_KEY]: trimmed });
  else await LOCAL.remove(REMEMBER_EMAIL_KEY);
}

// Per-user cache: profile, profile text, settings, and the last seen data-version.
function cacheKey(userId) {
  return `cache_${userId}`;
}

export async function getCache(userId) {
  if (!userId) return null;
  const key = cacheKey(userId);
  const obj = await LOCAL.get(key);
  return obj[key] || null;
}

export async function setCache(userId, cache) {
  if (!userId) return;
  const key = cacheKey(userId);
  await LOCAL.set({ [key]: { ...cache, cachedAt: new Date().toISOString() } });
}

export async function clearCache(userId) {
  if (!userId) return;
  await LOCAL.remove(cacheKey(userId));
}

// ── Job catalog cache (extension Home lists) ───────────────────────────────
// One canonical jobsById map per user. Lists (today/ready/best/…) are derived
// in memory. Large catalogs fall back to IndexedDB when chrome.storage.local
// hits quota.

export const JOBS_CATALOG_VERSION = 1;

function jobsCatalogMetaKey(userId) {
  return `jobsCatalogMeta_${userId}`;
}

function jobsCatalogLocalKey(userId) {
  return `jobsCatalog_${userId}`;
}

const IDB_NAME = "atomspace_jobs";
const IDB_STORE = "catalogs";

function openJobsIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbGetCatalog(userId) {
  const db = await openJobsIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(String(userId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSetCatalog(userId, catalog) {
  const db = await openJobsIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(catalog, String(userId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbClearCatalog(userId) {
  try {
    const db = await openJobsIdb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(String(userId));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}

/** Strip to list-card fields so chrome.storage / IDB stay small. */
export function slimJob(job) {
  if (!job || !job.id) return null;
  return {
    id: job.id,
    source_url: job.source_url || "",
    normalized_url: job.normalized_url || "",
    domain: job.domain || "",
    title: job.title ?? null,
    company: job.company || "",
    location: job.location ?? null,
    posted_date: job.posted_date ?? null,
    status: job.status || "active",
    created_at: job.created_at || null,
    updated_at: job.updated_at || null,
    match_overall_score: job.match_overall_score ?? null,
    match_in_progress: !!job.match_in_progress,
    resume_build_status: job.resume_build_status ?? null,
    content_generation_status: job.content_generation_status ?? null,
    resume_build_id: job.resume_build_id ?? null,
    resume_pdf_status: job.resume_pdf_status ?? null,
    cover_letter_pdf_status: job.cover_letter_pdf_status ?? null,
    applied_at: job.applied_at ?? null,
    applied_by_name: job.applied_by_name ?? null,
    source: job.source ?? null,
    is_remote: !!job.is_remote,
    work_mode: job.work_mode ?? null,
    from_me: !!job.from_me,
    added_from: job.added_from || "job_sites",
    pool_added_at: job.pool_added_at || job.created_at || null,
    user_status: job.user_status ?? null,
    pumble_posted_at: job.pumble_posted_at ?? null,
    sheet_posted_at: job.sheet_posted_at ?? null,
  };
}

export function emptyJobsCatalog(minScore = 0) {
  return {
    version: JOBS_CATALOG_VERSION,
    since: null,
    checkedAt: null,
    revision: null,
    minScore: Number.isFinite(Number(minScore)) ? Number(minScore) : 0,
    jobsById: {},
    meta: {},
    storage: "local",
  };
}

/**
 * @returns {Promise<object|null>}
 */
export async function getJobsCatalog(userId) {
  if (!userId) return null;
  const metaKey = jobsCatalogMetaKey(userId);
  const localKey = jobsCatalogLocalKey(userId);
  const obj = await LOCAL.get([metaKey, localKey]);
  const meta = obj[metaKey];
  if (meta && meta.storage === "idb") {
    try {
      const catalog = await idbGetCatalog(userId);
      if (catalog && catalog.version === JOBS_CATALOG_VERSION) return catalog;
    } catch (err) {
      console.warn("getJobsCatalog idb failed", err);
    }
    return null;
  }
  const catalog = obj[localKey];
  if (catalog && catalog.version === JOBS_CATALOG_VERSION) return catalog;
  return null;
}

/**
 * Persist catalog. Tries chrome.storage.local first; on quota, uses IndexedDB
 * and keeps a small meta pointer in local storage.
 */
export async function setJobsCatalog(userId, catalog) {
  if (!userId || !catalog) return false;
  const localKey = jobsCatalogLocalKey(userId);
  const metaKey = jobsCatalogMetaKey(userId);
  const payload = {
    ...catalog,
    version: JOBS_CATALOG_VERSION,
    checkedAt: catalog.checkedAt || new Date().toISOString(),
  };
  try {
    await LOCAL.set({ [localKey]: { ...payload, storage: "local" } });
    await LOCAL.remove(metaKey);
    // Best-effort: clear any stale IDB copy so we don't serve two sources.
    void idbClearCatalog(userId);
    return true;
  } catch (err) {
    const msg = String((err && err.message) || err || "");
    const quota =
      /QUOTA|quota|exceed/i.test(msg) ||
      (err && (err.name === "QuotaExceededError" || err.code === 22));
    if (!quota) {
      console.warn("setJobsCatalog local failed", err);
      return false;
    }
  }
  try {
    const idbPayload = { ...payload, storage: "idb" };
    await idbSetCatalog(userId, idbPayload);
    await LOCAL.set({
      [metaKey]: {
        storage: "idb",
        since: idbPayload.since,
        revision: idbPayload.revision,
        minScore: idbPayload.minScore,
        checkedAt: idbPayload.checkedAt,
        jobCount: Object.keys(idbPayload.jobsById || {}).length,
      },
    });
    await LOCAL.remove(localKey);
    return true;
  } catch (err) {
    console.warn("setJobsCatalog idb failed", err);
    return false;
  }
}

export async function clearJobsCatalog(userId) {
  if (!userId) return;
  const localKey = jobsCatalogLocalKey(userId);
  const metaKey = jobsCatalogMetaKey(userId);
  await LOCAL.remove([localKey, metaKey]);
  await idbClearCatalog(userId);
}

/**
 * Merge upserts / removals into an existing catalog object (mutates a copy).
 */
export function mergeJobsCatalog(catalog, { upserts = [], removed_ids = [], since, revision, meta } = {}) {
  const next = {
    ...(catalog || emptyJobsCatalog()),
    jobsById: { ...((catalog && catalog.jobsById) || {}) },
    meta: { ...((catalog && catalog.meta) || {}), ...(meta || {}) },
  };
  for (const raw of upserts) {
    const slim = slimJob(raw);
    if (slim) next.jobsById[slim.id] = slim;
  }
  for (const id of removed_ids || []) {
    if (id) delete next.jobsById[id];
  }
  if (since) next.since = since;
  if (revision != null) next.revision = revision;
  next.checkedAt = new Date().toISOString();
  return next;
}

/** Replace the entire job map (cold bootstrap). */
export function replaceJobsCatalog(catalog, jobs, { since, revision, minScore, meta } = {}) {
  const jobsById = {};
  for (const raw of jobs || []) {
    const slim = slimJob(raw);
    if (slim) jobsById[slim.id] = slim;
  }
  return {
    version: JOBS_CATALOG_VERSION,
    since: since || null,
    revision: revision || null,
    checkedAt: new Date().toISOString(),
    minScore: minScore != null ? minScore : (catalog && catalog.minScore) || 0,
    jobsById,
    meta: { ...((catalog && catalog.meta) || {}), ...(meta || {}) },
  };
}

// Minimum match score filter. Defaults to 0 (same as the web dashboard) so the
// extension shows the same job set unless the user raises the threshold.
export const DEFAULT_MIN_SCORE = 0;

export async function getMinScore() {
  const { minScore } = await LOCAL.get("minScore");
  const n = Number(minScore);
  return Number.isFinite(n) ? n : DEFAULT_MIN_SCORE;
}

export async function setMinScore(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = DEFAULT_MIN_SCORE;
  n = Math.max(0, Math.min(100, Math.round(n)));
  await LOCAL.set({ minScore: n });
  return n;
}

// When enabled, the Workday autofill keeps filling each step, recovers any
// validation errors via the LLM, clicks "Save and Continue", and advances until
// the Review page - where it stops so the user can submit. On by default.
export async function getAutoAdvance() {
  const { autoAdvance } = await LOCAL.get("autoAdvance");
  return autoAdvance !== false;
}

export async function setAutoAdvance(value) {
  const v = value === true;
  await LOCAL.set({ autoAdvance: v });
  return v;
}

// Which resume narrative to use when autofilling: tailored (default) or original profile.
export const DEFAULT_RESUME_SOURCE = "tailored";

export async function getResumeSource() {
  const { resumeSource } = await LOCAL.get("resumeSource");
  return resumeSource === "original" ? "original" : DEFAULT_RESUME_SOURCE;
}

export async function setResumeSource(value) {
  const v = value === "original" ? "original" : "tailored";
  await LOCAL.set({ resumeSource: v });
  return v;
}

// Optional free-text answering strategy passed to the assistant autofill LLM.
export async function getAnswerStrategy() {
  const { answerStrategy } = await LOCAL.get("answerStrategy");
  return typeof answerStrategy === "string" ? answerStrategy : "";
}

export async function setAnswerStrategy(value) {
  const v = String(value || "").trim().slice(0, 2000);
  if (v) await LOCAL.set({ answerStrategy: v });
  else await LOCAL.remove("answerStrategy");
  return v;
}

// Default page size for job / resume lists in the side panel.
export async function getPageSize() {
  const { pageSize } = await LOCAL.get("pageSize");
  const n = Number(pageSize);
  if (n === 25 || n === 50 || n === 100) return n;
  return 25;
}

export async function setPageSize(value) {
  let n = Number(value);
  if (n !== 25 && n !== 50 && n !== 100) n = 25;
  await LOCAL.set({ pageSize: n });
  return n;
}

// ── Ask-selection hotkey (application page → assistant chat) ─────────────────
// Stored as a combo object. Requires Ctrl/Alt/Meta so normal typing is never stolen.

export const DEFAULT_ASK_HOTKEY = {
  ctrl: false,
  alt: true,
  shift: false,
  meta: false,
  key: "a",
};

export function normalizeAskHotkey(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ASK_HOTKEY };
  const key = String(raw.key || "")
    .trim()
    .toLowerCase();
  if (!key) return { ...DEFAULT_ASK_HOTKEY };
  const ctrl = !!raw.ctrl;
  const alt = !!raw.alt;
  const shift = !!raw.shift;
  const meta = !!raw.meta;
  if (!ctrl && !alt && !meta) return { ...DEFAULT_ASK_HOTKEY };
  return { ctrl, alt, shift, meta, key };
}

export function formatAskHotkey(raw) {
  const c = normalizeAskHotkey(raw);
  const isMac =
    typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || "");
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push(isMac ? "Option" : "Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push(isMac ? "⌘" : "Win");
  const keyLabel =
    c.key === " " || c.key === "space"
      ? "Space"
      : c.key === "escape"
        ? "Esc"
        : c.key.length === 1
          ? c.key.toUpperCase()
          : c.key.charAt(0).toUpperCase() + c.key.slice(1);
  parts.push(keyLabel);
  return parts.join("+");
}

export function askHotkeyFromKeyboardEvent(e) {
  if (!e) return null;
  const key = e.key === " " ? "space" : String(e.key || "").toLowerCase();
  if (!key || key === "control" || key === "alt" || key === "shift" || key === "meta") return null;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return normalizeAskHotkey({
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
    meta: !!e.metaKey,
    key,
  });
}

export function eventMatchesAskHotkey(e, raw) {
  const c = normalizeAskHotkey(raw);
  if (!e || !c.key) return false;
  if (!!e.ctrlKey !== c.ctrl) return false;
  if (!!e.altKey !== c.alt) return false;
  if (!!e.shiftKey !== c.shift) return false;
  if (!!e.metaKey !== c.meta) return false;
  const pressed = e.key === " " ? "space" : String(e.key || "").toLowerCase();
  return pressed === c.key;
}

export async function getAskHotkey() {
  const { askHotkey } = await LOCAL.get("askHotkey");
  return normalizeAskHotkey(askHotkey);
}

export async function setAskHotkey(value) {
  const next = normalizeAskHotkey(value);
  await LOCAL.set({ askHotkey: next });
  return next;
}

// Remembered answers for stable identity / EEO / work-authorization / consent
// questions, keyed by category (gender, hispanic, race, veteran, disability,
// work_auth, sponsorship, how_hear, consent) -> the exact option text last used.
// These answers are identical across jobs, so replaying them lets repeat
// applications skip both option harvesting and the LLM.
//
// IMPORTANT: the cache is scoped per (user, PLATFORM). The stored value is the
// exact option TEXT, but each ATS phrases / value-maps its options differently
// (e.g. Greenhouse vs ApplyToJob citizenship options), so a value learned on one
// platform must never be replayed on another. A new platform therefore starts
// empty: the LLM chooses every answer from that form's own inline options, and
// only that platform's answers are remembered for its future jobs. The category
// space is small and bounded, so no size cap is needed.
function answerCacheKey(userId, platform) {
  return `answers_${userId || "anon"}_${platform || "generic"}`;
}

export async function getAnswerCache(userId, platform) {
  const key = answerCacheKey(userId, platform);
  const obj = await LOCAL.get(key);
  const v = obj[key];
  return v && typeof v === "object" ? v : {};
}

export async function saveAnswerPairs(userId, platform, pairs) {
  if (!pairs || !Object.keys(pairs).length) return;
  const key = answerCacheKey(userId, platform);
  const cur = await getAnswerCache(userId, platform);
  const next = { ...cur };
  for (const [k, v] of Object.entries(pairs)) {
    if (k && v) next[k] = String(v);
  }
  await LOCAL.set({ [key]: next });
}

export async function clearAnswerCache(userId, platform) {
  await LOCAL.remove(answerCacheKey(userId, platform));
}
