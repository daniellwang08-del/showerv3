// Thin wrappers over chrome.storage.local. The auth token is stored in local
// (not session) so the user stays signed in across browser restarts; the server
// issues a long-lived token for this client, so the login persists.

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
  return backendUrl || "http://localhost:8000";
}

export async function setBackendUrl(backendUrl) {
  await LOCAL.set({ backendUrl: normalizeBackendUrl(backendUrl) });
}

export function normalizeBackendUrl(url) {
  let u = (url || "").trim();
  if (!u) return "http://localhost:8000";
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

// Minimum match score used to filter the default job board. Defaults to 70 for
// all new users, then persists whatever value the user sets until they change it.
export const DEFAULT_MIN_SCORE = 70;

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
