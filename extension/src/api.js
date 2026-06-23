// API client for the Job Scraper backend. Authenticates with a Bearer token
// (returned by /auth/login) rather than the web app's HttpOnly cookie.

import {
  getToken,
  setToken,
  clearToken,
  getBackendUrl,
  setBackendUrl,
  setCurrentUser,
  normalizeBackendUrl,
} from "./store.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const API_PREFIX = "/api/v1";

// Request the optional host permission for the configured backend origin so the
// extension can call it (and stream SSE) cross-origin. Must run on a user gesture.
export async function ensureHostPermission(backendUrl) {
  try {
    const origin = new URL(normalizeBackendUrl(backendUrl)).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (err) {
    console.warn("ensureHostPermission failed", err);
    return false;
  }
}

async function buildUrl(path) {
  const base = await getBackendUrl();
  return `${base}${API_PREFIX}${path}`;
}

async function authHeaders(extra = {}) {
  const token = await getToken();
  const headers = { ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function apiFetch(path, { method = "GET", body, headers } = {}) {
  const url = await buildUrl(path);
  const h = await authHeaders(headers || {});
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload });
  } catch (networkErr) {
    throw new ApiError(
      "Cannot reach the backend. Check the server URL and that the server is running.",
      0
    );
  }
  if (res.status === 401) {
    await clearToken();
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail =
      data && typeof data === "object" && data.detail
        ? typeof data.detail === "string"
          ? data.detail
          : JSON.stringify(data.detail)
        : `Request failed (${res.status})`;
    throw new ApiError(detail, res.status);
  }
  return data;
}

// ── auth ──────────────────────────────────────────────────────────────────

export async function login(backendUrl, email, password) {
  await setBackendUrl(backendUrl);
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: { email, password, long_lived: true },
  });
  if (!data || !data.access_token) {
    throw new ApiError("Login did not return a token. Update the backend to the latest version.", 500);
  }
  await setToken(data.access_token);
  const user = { user_id: data.user_id, email: data.email };
  await setCurrentUser(user);
  return user;
}

export async function logout() {
  await clearToken();
}

// ── data ──────────────────────────────────────────────────────────────────

export const getProfile = () => apiFetch("/profile");
export const getProfileText = () => apiFetch("/profile/openai-text");
export const getSettings = () => apiFetch("/settings");
export const getDataVersion = () => apiFetch("/me/data-version");

export const getDashboard = (params = {}) => {
  const q = new URLSearchParams({
    page: params.page || 1,
    per_page: params.per_page || 50,
    sort: params.sort || "match_score",
    order: params.order || "desc",
    ...(params.q ? { q: params.q } : {}),
  });
  return apiFetch(`/jobs/dashboard?${q.toString()}`);
};

export const getExtraction = (jobId) => apiFetch(`/extract/${jobId}`);
export const triggerMatch = (jobId) =>
  apiFetch(`/jobs/valid/${jobId}/match`, { method: "POST" });

// ── application sessions ────────────────────────────────────────────────────

export const listSessions = (status) =>
  apiFetch(`/assistant/sessions${status ? `?status=${status}` : ""}`);
export const createSession = (jobId) =>
  apiFetch("/assistant/sessions", { method: "POST", body: { job_id: jobId } });
export const getSessionDetail = (jobId) => apiFetch(`/assistant/sessions/${jobId}`);
export const updateSession = (jobId, status) =>
  apiFetch(`/assistant/sessions/${jobId}`, { method: "PATCH", body: { status } });
export const deleteSession = (jobId) =>
  apiFetch(`/assistant/sessions/${jobId}`, { method: "DELETE" });

export const nextJob = (after) =>
  apiFetch(`/assistant/next-job${after ? `?after=${encodeURIComponent(after)}` : ""}`);

export const markApplied = (jobIds) =>
  apiFetch("/jobs/valid/applied/batch", { method: "POST", body: { job_ids: jobIds } });

// Hide a job from the active list (e.g. the posting expired / link is dead).
export const reportJobInvalid = (jobId, reason) =>
  apiFetch(`/jobs/valid/${jobId}/report-invalid`, {
    method: "POST",
    body: { duplication_reason: reason },
  });

// ── autofill ────────────────────────────────────────────────────────────────

// fields: structured per-control specs. preferences: { answer_strategy?, resume_source? }
// -> { results: [{ handle, controls: [{ cid, value, kind, option?, file_role?, needs_user, reason? }] }] }
export const autofill = (jobId, fields, preferences) =>
  apiFetch("/assistant/autofill", {
    method: "POST",
    body: { job_id: jobId, fields, ...(preferences ? { preferences } : {}) },
  });

// Canonical structured profile for deterministic platform engines (Workday).
// resumeSource: "original" | "tailored". Returns the merged profile object the
// Workday engine maps to fixed selectors.
export const getAutofillProfile = (jobId, resumeSource = "original") =>
  apiFetch(`/assistant/autofill-profile?job_id=${encodeURIComponent(jobId)}&resume_source=${encodeURIComponent(resumeSource)}`);

// Download a generated resume/cover-letter file as base64 (for attaching to a
// page's <input type=file> via DataTransfer in the content script).
// fileType: resume_pdf | resume_docx | cover_letter_pdf | cover_letter_docx
export async function downloadResumeFile(jobId, fileType) {
  const url = await buildUrl(`/jobs/valid/${jobId}/resume-build/download/${fileType}`);
  const h = await authHeaders({});
  const res = await fetch(url, { method: "GET", headers: h });
  if (res.status === 401) {
    await clearToken();
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }
  if (!res.ok) {
    throw new ApiError(`Could not fetch ${fileType} (${res.status}).`, res.status);
  }
  const blob = await res.blob();
  const buf = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  let filename = `${fileType}`;
  const disp = res.headers.get("Content-Disposition") || "";
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disp);
  if (m) filename = decodeURIComponent(m[1].replace(/"/g, ""));
  return { base64, filename, mime: blob.type || "application/octet-stream" };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── streaming chat (SSE over fetch, so we can send the Authorization header) ──

export async function chatStream(reqBody, { onDelta, onDone, onError, signal }) {
  const url = await buildUrl("/assistant/chat");
  const h = await authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" });
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(reqBody), signal });
  } catch (err) {
    if (err && err.name === "AbortError") return;
    onError && onError("Cannot reach the backend.");
    return;
  }
  if (res.status === 401) {
    await clearToken();
    onError && onError("Your session expired. Please sign in again.");
    return;
  }
  if (!res.ok || !res.body) {
    onError && onError(`Assistant request failed (${res.status}).`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSseEvent(rawEvent, { onDelta, onDone, onError });
      }
    }
  } catch (err) {
    if (err && err.name === "AbortError") return;
    onError && onError("The assistant stream was interrupted.");
  }
}

function handleSseEvent(rawEvent, { onDelta, onDone, onError }) {
  const dataLines = rawEvent
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return;
  const payload = dataLines.join("\n");
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return;
  }
  if (obj.delta) onDelta && onDelta(obj.delta);
  if (obj.error) onError && onError(obj.error);
  if (obj.done) onDone && onDone();
}
